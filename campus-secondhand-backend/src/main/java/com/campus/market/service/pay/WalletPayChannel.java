package com.campus.market.service.pay;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.campus.market.common.BusinessException;
import com.campus.market.config.PayProperties;
import com.campus.market.entity.User;
import com.campus.market.entity.WalletLog;
import com.campus.market.mapper.UserMapper;
import com.campus.market.mapper.WalletLogMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.util.Map;

/**
 * 钱包渠道：从平台余额（校园币）里扣款。这是三条渠道里唯一「钱真的动」的一条。
 * <p>
 * ★★ 它为什么算「真实支付」★★
 * <p>
 * 它没有第三方通道，但它满足真实支付的**全部工程要求**：
 * 余额原子扣减（并发安全）、余额不足当场拒绝、每一笔都留流水、退款原路加回、
 * 账目可对（余额 = 流水之和）。接一条外部通道时，唯一要换的是「钱从哪来」，
 * 这套账务骨架一行都不用改。
 * <p>
 * ★★ 核心不变式：余额只能由**条件 UPDATE** 变更 ★★
 * <pre>
 *   -- 扣款：只有余额够的那一行才会被扣，扣不动 = 余额不足
 *   UPDATE t_user SET balance = balance - ? WHERE id = ? AND balance >= ?
 *   -- 退款：加回去没有条件（钱本来就是这个人的）
 *   UPDATE t_user SET balance = balance + ? WHERE id = ?
 * </pre>
 * 为什么绝不能写成「selectById 读出来 → 内存里减 → updateById 回写」：
 * <ul>
 *   <li><b>超扣</b>：余额 100，两个 80 元的订单同时下单，两边读到的都是 100，
 *       各自算成 20 并回写 —— 结果是「只付了 80 却买到 160 的东西」；</li>
 *   <li><b>覆盖</b>：整实体回写会把读快照之后发生的其它余额变动一并盖回去，
 *       相当于凭空加钱或抹钱。</li>
 * </ul>
 * 本项目在商品库存上已经踩过同一个坑（见 {@code OrderService#createOrder} 的注释），
 * 这里是同一族缺陷在资金上的形态 —— **比库存严重一个量级**，
 * 所以判定「扣没扣成功」直接用 {@code affected rows}，而不是自己算一遍再比较。
 *
 * ★ 与订单状态的关系：本类**不碰** t_order ★
 * 扣完钱只返回 {@link CreateResult.Kind#DONE}，把「推进订单」留给
 * {@code PaymentService#settle}。见 {@link PayChannel} 的类注释。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class WalletPayChannel implements PayChannel {

    public static final String CODE = "wallet";

    private final PayProperties props;
    private final UserMapper userMapper;
    private final WalletLogMapper walletLogMapper;

    @Override
    public String code() {
        return CODE;
    }

    @Override
    public String label() {
        return "钱包余额";
    }

    @Override
    public String hint() {
        return "使用校园币余额直接支付，无需跳转";
    }

    @Override
    public boolean available() {
        return props.channelEnabled(CODE);
    }

    /**
     * 扣款。失败（余额不足）直接抛业务异常 —— 由外层事务整体回滚，
     * 不会留下「扣了钱却没有支付单」的记录。
     */
    @Override
    @Transactional
    public CreateResult create(CreateContext ctx) {
        BigDecimal amount = normalize(ctx.amount());
        if (amount.signum() <= 0) {
            throw BusinessException.of("支付金额异常，无法完成钱包支付");
        }

        /*
         * ★ 条件 UPDATE：把「余额够不够」这件事交给数据库判断 ★
         *
         * ge(User::getBalance, amount) 会拼进 WHERE，与服务端的 UPDATE 一起
         * 在同一条语句、同一个行锁里完成「判断 + 扣减」。affected == 0 就说明
         * 余额不足（或用户不存在）—— 这是**唯一**可靠的判定方式。
         */
        int affected = userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, ctx.buyerId())
                .ge(User::getBalance, amount)
                .setSql("balance = balance - " + plain(amount)));

        if (affected == 0) {
            // 走到这里说明扣不动。查出真实余额给出可读提示（这一步只是**为了文案**，
            // 不参与任何判断 —— 判断已经由上面的 affected 完成了）
            User current = userMapper.selectById(ctx.buyerId());
            BigDecimal balance = current != null && current.getBalance() != null
                    ? current.getBalance() : BigDecimal.ZERO;
            throw BusinessException.of("钱包余额不足：当前余额 ¥" + plain(balance)
                    + "，本单需支付 ¥" + plain(amount)
                    + "，还差 ¥" + plain(amount.subtract(balance)));
        }

        /*
         * 变动后余额必须**重新查库**，不能用「扣款前余额 - amount」在内存里算：
         * 并发场景下那个减法用的是过期快照，写进流水的 balance_after 会是错的，
         * 而对账恰恰逐行比对这一列。重新查库拿到的是本事务内的真实值。
         */
        User after = userMapper.selectById(ctx.buyerId());
        BigDecimal balanceAfter = after != null && after.getBalance() != null
                ? after.getBalance() : BigDecimal.ZERO;
        writeLog(ctx, amount.negate(), balanceAfter, WalletLog.TYPE_PAY,
                "支付订单 " + ctx.orderId());

        return CreateResult.done("钱包支付 ¥" + plain(amount) + " 已完成，剩余余额 ¥" + plain(balanceAfter));
    }

    /** 同步渠道，没有异步回调 */
    @Override
    public boolean asyncNotify() {
        return false;
    }

    @Override
    public NotifyResult parseNotify(Map<String, String> params) {
        return NotifyResult.rejected("钱包渠道不支持异步回调");
    }

    @Override
    public boolean refundable() {
        return true;
    }

    /**
     * 原路退回：把钱加回买家余额。
     * <p>
     * ★ 这里没有「余额上限」之类的条件 —— 退款是把本来就属于买家的钱还回去，
     * 不存在「退不动」的情况（与扣款的不对称是刻意的）★
     * <p>
     * 但要有一道**幂等守卫**：退款可能因为管理员重复点击、或超时关单 + 手动退款
     * 并发而走到两次。幂等由 {@code PaymentService} 在支付单状态上做
     * （只有 {@code success} 的支付单能被改成 {@code refunded}，条件更新保证只有一个赢家），
     * 所以本方法只在确认自己是唯一赢家之后才被调用。
     */
    @Override
    @Transactional
    public RefundResult refund(RefundContext ctx) {
        BigDecimal amount = normalize(ctx.refundAmount());
        if (amount.signum() <= 0) {
            return RefundResult.fail("退款金额必须大于 0");
        }
        if (ctx.buyerId() == null) {
            return RefundResult.fail("支付单缺少付款人信息，无法退回钱包");
        }

        int affected = userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, ctx.buyerId())
                .setSql("balance = balance + " + plain(amount)));
        if (affected == 0) {
            return RefundResult.fail("收款账户不存在，无法退回钱包");
        }

        User after = userMapper.selectById(ctx.buyerId());
        BigDecimal balanceAfter = after != null && after.getBalance() != null
                ? after.getBalance() : BigDecimal.ZERO;
        writeLog(ctx, amount, balanceAfter, WalletLog.TYPE_REFUND,
                "退款：" + (ctx.reason() == null || ctx.reason().isBlank() ? "订单退款" : ctx.reason()));

        return RefundResult.ok(null, "已退回钱包余额 ¥" + plain(amount)
                + "，当前余额 ¥" + plain(balanceAfter));
    }

    /* ------------------------- 内部 ------------------------- */

    /**
     * 金额归一：两位小数、四舍五入。
     * <p>
     * 库列是 {@code decimal(10,2)}，多出来的位会被 MySQL 静默截断 ——
     * 于是「扣了 1.005，流水记 1.01，余额只少 1.00」这种账目漂移会一直存在且极难发现。
     * 所以在进 SQL 之前先按目标精度收敛一次，两边永远一致。
     */
    private BigDecimal normalize(BigDecimal value) {
        return value == null ? BigDecimal.ZERO : value.setScale(2, RoundingMode.HALF_UP);
    }

    /**
     * 转成可安全拼进 SQL 的字面量。
     * <p>
     * ★ 用 {@code toPlainString()} 而不是 {@code toString()} ★
     * {@code toString()} 在特定数量级下会输出科学计数法（如 {@code 1E+2}），
     * 拼进 SQL 就是语法错误；{@code toPlainString()} 保证是普通十进制写法。
     * 金额在进入本方法前已过 {@link #normalize}，所以字符集只可能是数字与小数点。
     */
    private String plain(BigDecimal value) {
        return value.toPlainString();
    }

    /** 写一条钱包流水（与余额变更同一事务；见 {@link WalletLog} 的类注释） */
    private void writeLog(CreateContext ctx, BigDecimal amount, BigDecimal balanceAfter,
                          String type, String remark) {
        WalletLog entry = new WalletLog();
        entry.setUserId(ctx.buyerId());
        entry.setAmount(amount);
        entry.setBalanceAfter(balanceAfter);
        entry.setType(type);
        entry.setBizId(ctx.paymentId());
        entry.setRemark(remark + "（商品：" + safe(ctx.subject()) + "）");
        entry.setCreateTime(LocalDateTime.now());
        walletLogMapper.insert(entry);
    }

    private void writeLog(RefundContext ctx, BigDecimal amount, BigDecimal balanceAfter,
                          String type, String remark) {
        WalletLog entry = new WalletLog();
        entry.setUserId(ctx.buyerId());
        entry.setAmount(amount);
        entry.setBalanceAfter(balanceAfter);
        entry.setType(type);
        entry.setBizId(ctx.paymentId());
        entry.setRemark(remark);
        entry.setCreateTime(LocalDateTime.now());
        walletLogMapper.insert(entry);
    }

    private String safe(String text) {
        // remark 是 varchar(200)：商品标题最长 200，加上前后缀会超长 → Data too long → 整个支付回滚
        if (text == null) {
            return "";
        }
        return text.length() > 80 ? text.substring(0, 80) + "…" : text;
    }
}
