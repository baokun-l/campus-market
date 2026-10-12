package com.campus.market.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.common.InstanceSeqGenerator;
import com.campus.market.dto.WalletLogItem;
import com.campus.market.dto.WalletRechargeResult;
import com.campus.market.dto.WalletSummary;
import com.campus.market.entity.User;
import com.campus.market.entity.WalletLog;
import com.campus.market.mapper.UserMapper;
import com.campus.market.mapper.WalletLogMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 钱包账户服务：校园币的**入金**入口，以及余额 / 流水的只读查询。
 * <p>
 * ★★★ 本类补的是一个真实存在过的缺口 ★★★
 * <p>
 * 改造前，「余额」只有三条受控路径能变：支付扣减、退款退回、以及建库种子脚本。
 * 但 {@code schema.sql} 的列注释与 {@code User#balance} 的字段注释都写着
 * 「只能由充值 / 支付 / 退款三条受控路径变更」—— 也就是说**文档里承诺了充值这条路，
 * 代码里从来没有过**：{@code WalletLog.TYPE_RECHARGE} 定义了常量却零调用，
 * 后端没有任何充值接口，前端全树搜「充值」零命中。
 * <p>
 * 后果不是「少个功能」而是演示当场翻车：除了三个种子账号（余额 500）之外，
 * 任何账号打开收银台都显示「余额 ¥0.00」，而收银台的文案却写着
 * 「使用校园币余额直接支付」—— 点下去必然弹「钱包余额不足」，
 * 用户找不到任何可以给余额加钱的入口。本类就是把那条被承诺过的路径补上。
 *
 * ★★★ 三条必须守住的不变式 ★★★
 * <ol>
 *   <li><b>余额只能由条件 UPDATE 变更</b> —— 绝不「读出来、算一下、写回去」。
 *       整实体回写会覆盖快照之后发生的其它余额变动，等于凭空加钱或抹钱
 *       （详见 {@code WalletPayChannel} 的类注释，那里是同一族缺陷在扣款方向上的形态）；</li>
 *   <li><b>{@code balance_after} 必须重新查库</b> —— 不能用「充值前余额 + amount」
 *       在内存里算。并发下那个加法用的是过期快照，写进流水的值就是错的，
 *       而对账恰恰逐行比对这一列；</li>
 *   <li><b>改余额与写流水同事务</b> —— 任何一半单独成功都是错账：
 *       只加钱不写账，对账链当场断裂；只写账不加钱，用户的钱凭空消失。</li>
 * </ol>
 *
 * ★★★ 幂等：三层，缺一层都有洞 ★★★
 * <pre>
 *   ① 业务层「先查后写」   —— 覆盖**顺序重放**（用户连点两下、前端重试）。
 *                            命中就把上一次的结果原样回放，不报错、不再加钱。
 *   ② 条件 UPDATE 的溢出守卫 —— WHERE balance + ? <= 上限。见 {link #MAX_BALANCE}。
 *   ③ 唯一索引 uk_wallet_type_biz(type, biz_id) —— **并发下的唯一仲裁者**。
 * </pre>
 * 为什么 ① 不能单独用：两个真正并发的请求在 ① 处**都查不到**对方（各自还没提交），
 * 于是两边都会加钱 —— 这就是典型的「先查后写」竞争，用户连点两下余额翻倍。
 * 所以 ③ 必须存在：那一层的判定发生在数据库内部，写入即校验，没有竞争窗口。
 * <p>
 * 为什么 ③ 触发时抛异常而不是吞掉：唯一索引冲突说明这次余额**已经加过了**，
 * 必须让整个事务回滚把那笔多加的钱撤掉。吞掉异常会让事务照常提交，等于错账
 * ——这正是本项目最不能接受的一类结果。宁可响亮地失败，不可静默地错。
 * <p>
 * ★ 口径说明（不要误解本类的定位）★
 * <p>
 * 这里实现的充值是**平台内部的入金**：钱由平台记入，不对接外部资金通道。
 * 生产环境里这一步应当由支付渠道的**异步回调**驱动（用户付了钱，回调告诉平台加余额）。
 * 但那样一来，被回调驱动的那一半逻辑（验签 → 幂等 → 加余额 → 写流水）
 * 与本类的后半段是同一段代码。也就是说：将来接真实通道，换的只是「钱从哪来」，
 * 这套账务骨架不用改 —— 与 {@code WalletPayChannel} 描述的分工一致。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WalletService {

    /** 单笔最小充值额。1 分钱 —— 再小就没有意义了（且 decimal(10,2) 也存不下） */
    public static final BigDecimal MIN_RECHARGE = new BigDecimal("0.01");

    /**
     * 单笔上限 ¥50,000。
     * <p>
     * ★ 它的作用是「防手滑」而不是「防攻击」★
     * 没有上限时，用户在金额框里多打两个 0 就能把自己余额冲到几千万 ——
     * 事后排查只会看到一条巨额流水，无从判断是误操作还是漏洞。
     * 真实系统的上限通常由支付渠道的单笔限额决定，这里取一个校园场景下的合理值。
     */
    public static final BigDecimal MAX_RECHARGE = new BigDecimal("50000.00");

    /**
     * 余额上限 = {@code DECIMAL(10,2)} 能表示的最大值。
     * <p>
     * ★ 为什么必须显式守这一条 ★
     * <p>
     * 库列是 {@code decimal(10,2)}，最大值 99999999.99。MySQL 跑在 STRICT_TRANS_TABLES 下
     * 不会静默截断，而是抛 {@code Out of range value for column 'balance'}。
     * 这个异常从 Mapper 一路冒到 {@code GlobalExceptionHandler} 的兜底分支，
     * 用户看到的是 500「服务器内部错误」—— 又是一次「把用户的错报成服务器的错」。
     * 所以把它做成条件 UPDATE 的 WHERE 条件：越界时 affected == 0，
     * 我们就能给出一句看得懂的话，而不是让数据库抛错。
     */
    private static final BigDecimal MAX_BALANCE = new BigDecimal("99999999.99");

    /** 流水查询条数上限（只读展示，不做分页：钱包页只看最近发生的事） */
    private static final int LOG_LIMIT = 20;

    /**
     * 幂等键的合法形态。
     * <p>
     * 客户端传来的东西**不能直接进库**：它是 varchar(40)，超长会 Data too long；
     * 而含控制字符的值会让日志与对账脚本难以处理。所以只接受
     * 「8~40 位的字母 / 数字 / 下划线 / 连字符」——UUID、时间戳串、雪花 ID 都在这个范围内。
     * 不合规的入参直接拒绝，而不是**清洗后**照用：清洗会让两个不同的入参
     * 收敛成同一个键，于是「两次不同的充值」被误判成「重复提交」，钱就不加了。
     */
    private static final Pattern BIZ_ID_OK = Pattern.compile("^[A-Za-z0-9_-]{8,40}$");

    private final UserMapper userMapper;
    private final WalletLogMapper walletLogMapper;

    /**
     * 充值流水号发号器：{@code rcg_} + 17 位时间戳 + 实例号 + 2 位序号（共 24 字符）。
     * <p>
     * ★ 用项目的唯一发号器，不要自己 {@code new AtomicLong()} ★
     * 见 {@link InstanceSeqGenerator} 的类注释：同族 id 各写一份实现，多实例部署时必然撞号。
     * 这里只在「客户端没给幂等键」时作为兜底发号用。
     */
    private final InstanceSeqGenerator rechargeIds = new InstanceSeqGenerator(2);

    /** 实例号（与订单号、支付单号同一套：多实例部署时每个实例配不同值） */
    @Value("${app.instance-id:0}")
    private int instanceId;

    /* ==================================================================
     * 充值（入金）
     * ================================================================== */

    /**
     * 充值入账。
     * <p>
     * 全流程在一个事务里：**任何一步失败，余额与流水一起回退**，不存在中间态。
     *
     * @param userId    当前登录用户（来自 JWT，**不接受请求体传入** —— 否则可以给任意账号加钱）
     * @param rawAmount 充值金额；两位小数归一，见 {@code normalize}
     * @param requestId 幂等键，可为空。前端每次打开充值弹窗生成一个，
     *                  同一次充值的重试必须复用同一个值，否则退化成两次独立充值
     * @throws BusinessException 金额越界 / 幂等键非法 / 余额越上限 / 重复提交
     */
    @Transactional
    public WalletRechargeResult recharge(Long userId, BigDecimal rawAmount, String requestId) {
        if (userId == null) {
            // 走到这里说明拦截器放行了却没有 userId —— 属于鉴权层与业务层的契约断裂，
            // 不能继续往下走：没有主体就不知道给谁加钱。
            throw BusinessException.of(BusinessCode.UNAUTHORIZED, "请先登录后再充值");
        }

        // ① 金额归一 + 边界校验。必须在拼 SQL 之前完成（见 normalize 注释）
        BigDecimal amount = normalize(rawAmount);
        requireAmountOk(amount);

        // ② 幂等键。客户端给了就用它，没给则现场发一个（此时不具备跨请求幂等能力）
        String bizId = resolveBizId(requestId);

        // ③ 幂等第一层：顺序重放。命中说明这笔充值已经成功处理过 ——
        //    把上次的结果回放出去（余额取**当前**值），既不报错也不再加钱。
        //    语义上这才是真正的幂等：同一个请求重发，得到同一个结果。
        WalletLog existing = findRecharge(userId, bizId);
        if (existing != null) {
            log.info("[wallet] 充值重放被拦截。userId={} bizId={}", userId, bizId);
            return new WalletRechargeResult(bizId, existing.getAmount(), balanceOf(userId),
                    "该笔充值已处理，未重复入账");
        }

        // ④ 条件 UPDATE：加钱 + 余额上限守卫，一次往返完成
        //
        //    与扣款方向的不对称是刻意的：扣款要判「够不够」（ge），
        //    入金没有"够不够"的问题，只有"会不会越界"的问题（le 上限）。
        //    apply 里的 {0}/{1} 是真参数绑定，不是字符串拼接 —— 条件里不放字面量。
        int affected = userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, userId)
                .apply("balance + {0} <= {1}", amount, MAX_BALANCE)
                .setSql("balance = balance + " + plain(amount)));

        if (affected == 0) {
            // 加不动只有两种原因，分开给话术，避免用户对着"充值失败"反复重试
            User current = userMapper.selectById(userId);
            if (current == null) {
                throw BusinessException.notFound("账号不存在，无法充值");
            }
            BigDecimal balance = current.getBalance() == null ? BigDecimal.ZERO : current.getBalance();
            throw BusinessException.of("充值后余额将超过上限 ¥" + plain(MAX_BALANCE)
                    + "（当前余额 ¥" + plain(balance) + "），本次未入账");
        }

        // ⑤ 重新查库拿变动后的余额 —— 不用「加之前的余额 + amount」在内存里算（见类注释不变式 ②）
        BigDecimal balanceAfter = balanceOf(userId);

        // ⑥ 写流水。这一步同时是幂等第三层的落点（见类注释）
        WalletLog entry = new WalletLog();
        entry.setUserId(userId);
        entry.setAmount(amount);                 // 正数 = 入账
        entry.setBalanceAfter(balanceAfter);
        entry.setType(WalletLog.TYPE_RECHARGE);  // ★ 常量终于有了调用方 ★
        entry.setBizId(bizId);
        entry.setRemark("校园币充值 ¥" + plain(amount));
        entry.setCreateTime(LocalDateTime.now());
        try {
            walletLogMapper.insert(entry);
        } catch (DuplicateKeyException e) {
            /*
             * ★★ 并发仲裁点 ★★
             *
             * 走到这里说明：两个请求几乎同时进入本方法，都在第 ③ 步没查到对方，
             * 都执行了第 ④ 步的加钱。唯一索引 (type, biz_id) 让其中一个插入失败 ——
             * 也就只有一个能提交，另一个必须整体回滚把那笔多加的钱撤掉。
             *
             * 这里**必须抛出**而不是吞掉：吞掉会让事务照常提交，
             * 结果是这次充值把余额加了两次，而对账链上只有一条记录
             * —— 账面余额 ≠ 流水之和，且永远查不出差在哪。
             *
             * 抛的是业务异常（1001）而不是让 DuplicateKeyException 冒到兜底分支（500）：
             * 这是「重复提交」，属于客户端的错，不该显示成"服务器内部错误"。
             */
            log.warn("[wallet] 并发重复充值被唯一索引拦下，已回滚本次入账。userId={} bizId={}", userId, bizId);
            throw BusinessException.paramError("这笔充值正在处理中，请勿重复提交，可稍后刷新余额确认");
        }

        log.info("[wallet] 充值成功。userId={} amount={} balanceAfter={} bizId={}",
                userId, plain(amount), plain(balanceAfter), bizId);
        return new WalletRechargeResult(bizId, amount, balanceAfter,
                "充值成功 ¥" + plain(amount) + "，当前余额 ¥" + plain(balanceAfter));
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /**
     * 钱包概览：当前余额 + 最近 {@value #LOG_LIMIT} 条流水。
     * <p>
     * 按 id 倒序而不是按 create_time：id 是自增主键，在**同一毫秒内的多笔**之间
     * 仍然有确定的先后；create_time 精度只到秒（DATETIME 无小数位），
     * 同一秒内的两笔顺序会飘，对账时看起来就像流水错乱了。
     */
    public WalletSummary summary(Long userId) {
        if (userId == null) {
            throw BusinessException.of(BusinessCode.UNAUTHORIZED, "请先登录");
        }
        List<WalletLog> rows = walletLogMapper.selectList(new LambdaQueryWrapper<WalletLog>()
                .eq(WalletLog::getUserId, userId)
                .orderByDesc(WalletLog::getId)
                .last("LIMIT " + LOG_LIMIT));
        List<WalletLogItem> logs = rows.stream().map(r -> new WalletLogItem(
                r.getId(), r.getAmount(), r.getBalanceAfter(), r.getType(),
                WalletLog.labelOf(r.getType()), r.getBizId(), r.getRemark(), r.getCreateTime()
        )).toList();
        return new WalletSummary(balanceOf(userId), logs);
    }

    /* ==================================================================
     * 内部工具
     * ================================================================== */

    /**
     * 读当前余额。查不到用户或列是 null 时回 {@code 0.00} 而不是抛错。
     * <p>
     * 这是一个**只读展示**用的取值，不该因为余额列意外为空就让整个钱包页 500。
     * 真正需要区分"用户不存在"的地方（如充值第 ④ 步的失败分支）会自己 selectById 判断。
     */
    private BigDecimal balanceOf(Long userId) {
        User user = userMapper.selectById(userId);
        return user == null || user.getBalance() == null ? BigDecimal.ZERO : user.getBalance();
    }

    /** 查这笔幂等键对应的充值流水；不存在返回 null */
    private WalletLog findRecharge(Long userId, String bizId) {
        return walletLogMapper.selectOne(new LambdaQueryWrapper<WalletLog>()
                .eq(WalletLog::getUserId, userId)
                .eq(WalletLog::getType, WalletLog.TYPE_RECHARGE)
                .eq(WalletLog::getBizId, bizId)
                .last("LIMIT 1"));
    }

    /**
     * 金额归一：两位小数、四舍五入。
     * <p>
     * ★ 必须在进 SQL 之前收敛，理由与 {@code WalletPayChannel#normalize} 完全相同 ★
     * 库列是 {@code decimal(10,2)}，多出来的位会被 MySQL 静默截断 ——
     * 于是「用户输入 100.005，流水记 100.01，余额只加了 100.00」这种漂移会一直存在。
     * 归一之后，用户看到的、流水记的、余额加的永远是同一个数。
     */
    private BigDecimal normalize(BigDecimal value) {
        return value == null ? BigDecimal.ZERO : value.setScale(2, RoundingMode.HALF_UP);
    }

    /**
     * 金额边界校验。
     * <p>
     * ★ 为什么必须在后端做，而不是靠前端的 {@code el-input-number} 的 min/max ★
     * 前端约束是**用户体验**不是**边界**：绕过页面直接调接口，前端那层就不存在了。
     * 而充值直接改钱，是本站唯一一个「入参就是金额」的写接口，这里必须是硬的。
     */
    private void requireAmountOk(BigDecimal amount) {
        if (amount.compareTo(MIN_RECHARGE) < 0) {
            // 含 null（被 normalize 归成 0）与负数两种情形，文案对用户是同一件事
            throw BusinessException.paramError("充值金额必须大于 ¥" + plain(MIN_RECHARGE));
        }
        if (amount.compareTo(MAX_RECHARGE) > 0) {
            throw BusinessException.paramError("单笔充值最多 ¥" + plain(MAX_RECHARGE)
                    + "（当前 ¥" + plain(amount) + "），请分次充值");
        }
    }

    /**
     * 幂等键收敛：客户端给了就校验后采用，没给则现场发一个。
     * <p>
     * 不合规的入参**直接拒绝**而不是清洗后使用 —— 清洗会让两个不同的入参
     * 收敛成同一个键，于是「两次不同的充值」被误判成"重复提交"，钱就不再加了。
     * 这是一个会**吞掉用户充值**的失败模式，比报错严重得多。
     */
    private String resolveBizId(String requestId) {
        if (requestId == null || requestId.isBlank()) {
            return rechargeIds.id("rcg_", System.currentTimeMillis(), instanceId);
        }
        String key = requestId.trim();
        if (!BIZ_ID_OK.matcher(key).matches()) {
            throw BusinessException.paramError("充值请求标识格式不正确（应为 8~40 位字母、数字、下划线或连字符）");
        }
        return key;
    }

    /**
     * 转成可安全拼进 SQL 的字面量。
     * <p>
     * ★ 用 {@code toPlainString()} 而不是 {@code toString()} ★
     * {@code toString()} 在特定数量级下会输出科学计数法（如 {@code 1E+2}），
     * 拼进 {@code setSql} 就是语法错误。金额在进入本方法前已过 {@link #normalize}，
     * 所以字符集只可能是数字、负号与小数点 —— 没有注入面。
     */
    private String plain(BigDecimal value) {
        return value.toPlainString();
    }
}
