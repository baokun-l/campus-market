package com.campus.market.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.campus.market.common.BusinessException;
import com.campus.market.common.InstanceSeqGenerator;
import com.campus.market.config.PayProperties;
import com.campus.market.dto.PayChannelOption;
import com.campus.market.dto.PayLaunch;
import com.campus.market.entity.Order;
import com.campus.market.entity.Payment;
import com.campus.market.entity.User;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.PaymentMapper;
import com.campus.market.mapper.UserMapper;
import com.campus.market.service.pay.PayChannel;
import com.campus.market.service.pay.PayChannelRegistry;
import com.campus.market.service.pay.WalletPayChannel;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 支付服务：支付单的生命周期，以及「钱到账 → 订单推进」这一段唯一的结算路径。
 * <p>
 * ★★★ 本类存在的理由，就是让「翻订单状态」这件事只有一个入口 ★★★
 * <p>
 * 改造前它是散的：{@code OrderService#payOrder} 里，客户端调用一次接口就
 * {@code setStatus("pending_ship")}。谁都能付款成功，因为「付款成功」这个判断
 * 根本没有依据。现在整条链路被约束成：
 * <pre>
 *   前端「去支付」
 *      ↓  POST /orders/{id}/pay  { channel: "wallet" | "demo" | "alipay_sandbox" }
 *   ┌──────────────────────────────────────────────────────┐
 *   │ ① requirePayable   校验买家归属 + 订单确实待付款          │
 *   │ ② 建支付单          created，金额取订单快照               │
 *   │ ③ 交渠道           钱包扣余额 / 支付宝出收银台 / 演示什么都不做 │
 *   └──────────────────────────────────────────────────────┘
 *      ├─ 同步渠道（钱包、演示）→ 当场 settle
 *      └─ 异步渠道（支付宝）→ 用户去付
 *                                ↓  POST /pay/notify/{channel}（公开，靠验签）
 *                             验签 → appid → 金额 → 幂等 → settle
 *                                ↑
 *                     ↑ 这条通知**可能永远不来**（尽力投递，真机已发生过）
 *                                ↑
 *        兜底：PaymentReconcileJob 定时任务 → 主动 ask 渠道（alipay.trade.query）
 *              → 金额闸门 → 同一个 settle
 *                                                        ↓
 *                                          orderService.markPaid  ← 唯一翻状态处
 * </pre>
 * 关键在于：**除了 {@link #settle} 之外，全仓没有任何地方能调用 {@code markPaid}**。
 * 审计「订单是怎么变成已付款的」只需要看这一个方法。
 *
 * ★★★ 结算的三道闸门（顺序不能调）★★★
 * <ol>
 *   <li><b>验签</b>（在渠道实现里）：回答「这段报文是不是渠道发的」；</li>
 *   <li><b>支付单幂等</b>：{@code UPDATE ... WHERE status IN ('created','paying')}。
 *       affected == 0 说明已经处理过 —— 渠道重复投递时靠它返回成功而不是重复推进订单；</li>
 *   <li><b>订单状态条件更新</b>（{@code markPaid}）：确认订单**此刻**确实待付款。
 *       不成立说明订单已被超时关单抢先 —— 此时钱留在平台，必须自动退回。</li>
 * </ol>
 * 任何一步用「先查后写」代替条件更新，都会在并发下静默出错。
 *
 * ★ 依赖方向：本类 → {@code OrderService}，单向 ★
 * <p>
 * 订单侧的状态流转（含库存回补）全部由 {@code OrderService} 负责，
 * 本类不碰 {@code t_goods}、也不自己拼订单状态；反过来 {@code OrderService}
 * 不认识任何支付渠道。这样两边都不必互相引用，也就没有循环依赖。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentService {

    private final PaymentMapper paymentMapper;
    private final OrderMapper orderMapper;
    private final UserMapper userMapper;
    private final PayChannelRegistry registry;
    private final PayProperties props;
    private final OrderService orderService;

    /**
     * 支付单号发号器：{@code pay_} + 20 位（与订单号、活动号共用同一个实现）。
     * <p>
     * ★ 用项目的唯一发号器，而不是自己 {@code new AtomicLong()} ★
     * 这是 L5/L10 那两次漏修的教训：同一族 id 各写一份实现，多实例部署时必然撞号。
     * 见 {@link InstanceSeqGenerator} 的类注释。
     */
    private final InstanceSeqGenerator payIds = new InstanceSeqGenerator(2);

    /** 实例号（与订单号同一套：多实例部署时每个实例必须配不同的值） */
    @Value("${app.instance-id:0}")
    private int instanceId;

    /* ==================================================================
     * 收银台
     * ================================================================== */

    /**
     * 当前可用的支付方式（收银台渲染用）。
     * <p>
     * 只返回**此刻真的能用**的渠道：没配密钥的支付宝、prod 下的演示渠道都会被过滤掉。
     * 前端照着这个列表渲染，用户不可能点到一条不可用的渠道。
     */
    public List<PayChannelOption> availableChannels(Long userId) {
        BigDecimal balance = balanceOf(userId);
        List<PayChannelOption> out = new ArrayList<>();
        for (PayChannel ch : registry.available()) {
            boolean isWallet = WalletPayChannel.CODE.equals(ch.code());
            out.add(new PayChannelOption(ch.code(), ch.label(), ch.hint(),
                    isWallet ? balance : null));
        }
        return out;
    }

    /* ==================================================================
     * 发起支付
     * ================================================================== */

    /**
     * 发起一次支付：建支付单 → 交给渠道 → 同步渠道当场结算。
     * <p>
     * ★ 本方法**不会**把订单推进到待发货 ★
     * <p>
     * 唯一的例外是同步渠道（钱包 / 演示）：它们返回 {@link PayChannel.CreateResult.Kind#DONE}，
     * 表示钱已经收了，此时调用 {@link #settle} 走的是**与支付宝回调完全相同的那段代码**。
     * 所以「演示环境跑通了」是有意义的 —— 证明的是同一条路径，换的只是末端。
     *
     * ★ 为什么要先关掉旧的活跃支付单 ★
     * 用户可能「钱包余额不足 → 改用支付宝」「二维码过期 → 重新点一次」。
     * 不关旧单的话，库里会同时挂着多张活跃支付单，而**任何一张成功都会推进订单**：
     * 用户付了支付宝，回头又扫了那张没关掉的旧二维码再付一次 —— 钱收了两次，
     * 订单只有一笔。所以每次发起新支付都先把旧的活跃单关掉（条件更新，幂等安全）。
     *
     * @param orderId     订单号
     * @param userId      当前登录用户（必须是该单买家）
     * @param channelCode 渠道编码；为空时用第一条可用渠道（前端老版本不带这个参数也能用）
     * @param clientIp    客户端 IP（渠道风控用，可为 null）
     */
    @Transactional
    public PayLaunch createPayment(String orderId, Long userId, String channelCode, String clientIp) {
        // ① 归属与状态校验（只读）。买家的钱只有买家自己能付
        Order order = orderService.requirePayable(orderId, userId);

        // ② 选渠道。不可用会在这里被拒（1001），而不是建一张永远不会有结果的支付单
        PayChannel channel = (channelCode == null || channelCode.isBlank())
                ? firstAvailableChannel()
                : registry.require(channelCode);

        // ③ 关掉该订单上还活着的旧支付单（换渠道重试 / 重复点击）
        int closed = closeActivePayments(orderId, "被新的支付尝试取代");

        // ④ 建支付单。金额取订单快照 amount —— 前端传什么都不参与，杜绝「改价支付」
        String paymentId = payIds.id("pay_", System.currentTimeMillis(), instanceId);
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime expireAt = order.getPayExpireAt() != null
                ? order.getPayExpireAt()
                : now.plusMinutes(props.getOrderTimeoutMinutes());

        Payment payment = new Payment();
        payment.setId(paymentId);
        payment.setOrderId(orderId);
        payment.setBuyerId(userId);
        payment.setChannel(channel.code());
        payment.setAmount(scale(order.getAmount()));
        payment.setStatus(Payment.STATUS_CREATED);
        // out_trade_no 直接复用支付单号：它本来就唯一，另造一个号只会多一处可能不一致的地方
        payment.setOutTradeNo(paymentId);
        payment.setExpireAt(expireAt);
        payment.setCreateTime(now);
        paymentMapper.insert(payment);

        // ⑤ 交给渠道
        PayChannel.CreateResult created = channel.create(new PayChannel.CreateContext(
                paymentId, payment.getOutTradeNo(), orderId, payment.getAmount(), userId,
                order.getGoodsTitle(), clientIp));

        if (created.kind() == PayChannel.CreateResult.Kind.DONE) {
            // 同步渠道：钱已经收了，立刻结算（走的是与回调同一条路径）
            settle(payment, null, null);
            Payment after = paymentMapper.selectById(paymentId);
            BigDecimal balance = WalletPayChannel.CODE.equals(channel.code()) ? balanceOf(userId) : null;
            return new PayLaunch(paymentId, orderId, channel.code(), channel.label(),
                    payment.getAmount(), PayLaunch.Kind.DONE, null, null,
                    created.message(), expireAt,
                    after != null ? after.getStatus() : Payment.STATUS_SUCCESS, balance);
        }

        // 异步渠道：支付单进入 paying（结果未知），把去哪儿付告诉前端
        paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getId, paymentId)
                .eq(Payment::getStatus, Payment.STATUS_CREATED)
                .set(Payment::getStatus, Payment.STATUS_PAYING));

        PayLaunch.Kind kind = created.kind() == PayChannel.CreateResult.Kind.QR
                ? PayLaunch.Kind.QR : PayLaunch.Kind.REDIRECT;
        return new PayLaunch(paymentId, orderId, channel.code(), channel.label(),
                payment.getAmount(), kind, created.url(), created.qrCode(),
                created.message(), expireAt, Payment.STATUS_PAYING, null);
    }

    /* ==================================================================
     * 支付状态查询（收银台轮询）
     * ================================================================== */

    /**
     * 查订单的支付状态。
     * <p>
     * 返回体刻意做得很小（状态 + 渠道 + 时间），因为它是**轮询接口**：
     * 收银台每几秒问一次，返回整张订单等于白白搬运一遍快照。
     */
    public Map<String, Object> payStatus(String orderId, Long userId) {
        Order order = orderService.requireBuyerOrder(orderId, userId);
        Payment latest = latestPayment(orderId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("orderId", orderId);
        out.put("orderStatus", order.getStatus());
        out.put("paid", order.getPayTime() != null);
        out.put("payChannel", order.getPayChannel());
        out.put("payTime", order.getPayTime());
        out.put("payExpireAt", order.getPayExpireAt());
        if (latest != null) {
            out.put("paymentId", latest.getId());
            out.put("paymentStatus", latest.getStatus());
            out.put("channel", latest.getChannel());
            out.put("amount", latest.getAmount());
            out.put("failReason", latest.getFailReason());
        }
        return out;
    }

    /* ==================================================================
     * 渠道回调（唯一的信任边界）
     * ================================================================== */

    /**
     * 处理渠道异步通知。
     * <p>
     * ★★ 返回的是**纯文本** {@code "success"}，不是项目统一的 {@code Result} JSON ★★
     * <p>
     * 这是全项目唯一一个不遵守 {@code {code,message,data}} 约定的接口，
     * 因为这是**支付宝定的协议**：它只看响应体是不是 {@code success} 这七个字符，
     * 不是就认为通知失败并**按固定频率一直重推**（支付宝的规则是 4m, 10m, 10m, 1h, 2h, 6h, 15h…）。
     * 回一段 JSON 的后果是：回调被处理成功、但支付宝认为失败，
     * 于是同一条回调被重复推十几小时 —— 日志里刷满同一条记录，真实问题被淹没。
     * <p>
     * 所以本方法直接返回 {@code String}，由 Controller 以 {@code text/plain} 写出。
     *
     * ★ 返回 success 的三种情形要分清 ★
     * <ul>
     *   <li>处理成功 → {@code success}；</li>
     *   <li>**渠道明确告知交易失败**（用户取消、超时关闭）→ 也返回 {@code success}：
     *       我们确实收到了、也记下了，重推没有意义；</li>
     *   <li>验签失败 / 找不到支付单 / 金额不符 → 返回 {@code failure}：
     *       这些是**异常**，可能是一次配置问题或攻击，让支付宝按规则重推，
     *       我们有机会在修好之后收到它，而不是永久丢掉这笔钱。</li>
     * </ul>
     */
    @Transactional
    public String handleNotify(String channelCode, Map<String, String> params) {
        PayChannel channel = registry.find(channelCode);
        if (channel == null) {
            log.warn("[pay] notify for unknown channel: {}", channelCode);
            return "failure";
        }
        /*
         * ★ 拒绝「同步渠道」的回调 ★
         * 钱包与演示渠道当场就出结果，永远不会（也不该）回调。放行的话，
         * 等于给攻击者多开一个入口：只要伪造一个 channel=wallet 的 POST，
         * 就绕过了真实渠道的验签（因为同步渠道没有验签）。
         */
        if (!channel.asyncNotify()) {
            log.warn("[pay] notify rejected: channel {} is synchronous, no async notify expected", channelCode);
            return "failure";
        }

        PayChannel.NotifyResult notify = channel.parseNotify(params);
        if (!notify.ok()) {
            // 验签失败：这是最需要被看见的一类，记 WARN 而不是 INFO
            log.warn("[pay] notify verification failed on channel {}, out_trade_no={}",
                    channelCode, params.get("out_trade_no"));
            return "failure";
        }

        Payment payment = findByOutTradeNo(notify.outTradeNo());
        if (payment == null) {
            log.warn("[pay] notify for unknown out_trade_no={}", notify.outTradeNo());
            return "failure";
        }
        /*
         * ★ 渠道串号校验：回调里的渠道必须与支付单上记录的一致 ★
         * 不校验的话，理论上存在「用 A 渠道的合法报文去推进 B 渠道的支付单」。
         * 本项目的三个渠道各有独立密钥/同步语义，实际很难构造，但这是一行代码的事，
         * 而它对账时的意义很大：流水号属于哪条渠道必须唯一确定。
         */
        if (!channel.code().equals(payment.getChannel())) {
            log.error("[pay] notify channel mismatch: notify={} payment={} id={}",
                    channel.code(), payment.getChannel(), payment.getId());
            return "failure";
        }

        /*
         * ★★ 金额校验：这是防「1 分钱买 iPhone」的最后一道闸 ★★
         *
         * 渠道回传的实收金额必须与支付单上的应付金额**逐分相等**。
         * 少了不行（少付钱），多了也不行（可能是攻击者拿一笔大额支付来撞单，
         * 而订单金额对不上时多收的钱没有归属，反而制造对账难题）。
         * 注意比的是**支付单**的金额，而不是订单当前的金额 ——
         * 订单金额可以被后续操作影响，支付单金额是下单那一刻冻住的。
         */
        if (notify.paidAmount() == null
                || notify.paidAmount().compareTo(payment.getAmount()) != 0) {
            log.error("[pay] notify amount mismatch: out_trade_no={} notify={} payment={}",
                    notify.outTradeNo(), notify.paidAmount(), payment.getAmount());
            return "failure";
        }

        if (!notify.success()) {
            // 渠道明确说这笔没成（用户放弃 / 渠道关单）：记下原因，返回 success 让渠道别再推
            markFailed(payment, notify.failReason(), notify.raw());
            return "success";
        }

        settle(payment, notify.tradeNo(), notify.raw());
        return "success";
    }

    /* ==================================================================
     * 结算（唯一翻订单状态的路径）
     * ================================================================== */

    /**
     * 结算：把「渠道确认收到钱」这件事落进支付单与订单。
     * <p>
     * ★★★ 全类、乃至全仓唯一会推进订单到「待发货」的地方 ★★★
     * <p>
     * 幂等靠支付单上的条件更新：
     * <pre>
     *   UPDATE t_payment SET status='success', trade_no=?, paid_at=?, notify_payload=?
     *    WHERE id=? AND status IN ('created','paying','closed')
     * </pre>
     * {@code affected == 0} 说明这张支付单早已入账（{@code success}/{@code refunded}）
     * 或已被渠道明确判定失败（{@code failed}）—— 此时**直接返回**，不碰订单。
     * 这就是「渠道重复投递同一条通知」不会重复推进订单的原因。
     * <p>
     * ★ 来源状态里为什么有 {@code closed} ★
     * 见方法体里的长注释：{@code closed} 不代表「这笔没成」，只代表**我们不再等了**。
     * 而钱可能在关单的同一秒到账、通知又晚到几小时。把它排除在外会让这笔钱
     * 既不入账也不退回 —— 无痕的进账。放进来之后，后续「订单已不可付」
     * 那段既有的 {@link #autoRefund} 会自然接管。
     * <p>
     * 若订单已经不可付（被超时关单抢先），钱已经收了、货却卖不了，
     * 此时触发 {@link #autoRefund} 原路退回。
     *
     * @param tradeNo     渠道流水号（同步渠道为 null）
     * @param notifyPayload 渠道回调原文（同步渠道为 null）
     */
    @Transactional
    public void settle(Payment payment, String tradeNo, String notifyPayload) {
        LocalDateTime now = LocalDateTime.now();
        /*
         * ★★★ 允许的来源状态包含 closed —— 这是 2026-09-23 补的一个「钱不留痕」的洞 ★★★
         *
         * 原先只允许 created / paying，注释里把 affected=0 一律解释成
         * 「已经处理过（重复投递）」并直接返回。但 closed 与 success 根本不是一回事：
         *   - success / refunded → 钱已入账（或已退回），重复投递，跳过是对的；
         *   - **closed → 钱可能真的到了，只是比我们关单晚了一步**。
         *
         * closed 是超时关单任务在 expire_at 到点写下的，而渠道的通知是**尽力投递**：
         * 支付宝在收到 success 响应前会按 4m/10m/10m/1h/2h/6h/15h 一直重推，
         * 所以「用户卡在关单前后付款 + 通知晚到」是真实可达的。原实现走到这里会
         * 静默返回，于是事情定格成：**钱在渠道手上、订单已作废、而且没有任何代码会去退它** ——
         * 一笔无痕的进账，正是本模块最不能接受的形态。
         *
         * ★ 为什么把 closed 放进条件更新的「允许来源」，而不是再写一遍补救代码 ★
         * 因为条件更新本身就是幂等闸门：无论谁先到，closed → success 只有一次能成功，
         * 之后状态是 success/refunded，再来一条重复通知必然 affected=0 被跳过。
         * 补救逻辑则不必新写 —— 状态一旦恢复成 success，下面「订单已不可付」
         * 那段既有的自动原路退回就会自然接管，钱会被退回去。
         *
         * ★ 安全性前提（本方法的契约，调用方必须守住）★
         * settle 只允许在**渠道已确认收款**之后调用：同步渠道的 create()==DONE、
         * 回调路径的 notify.success()==true 且金额相符、对账路径的 outcome==PAID 且金额相符。
         * 三处调用点都满足。若将来新增调用点，这一条是必须延续的前提 ——
         * 否则一个「没付款但状态被关掉」的支付单会被误判成已收款。
         */
        int affected = paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getId, payment.getId())
                .in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING,
                        Payment.STATUS_CLOSED)
                .set(Payment::getStatus, Payment.STATUS_SUCCESS)
                .set(Payment::getTradeNo, tradeNo)
                .set(Payment::getPaidAt, now)
                .set(Payment::getNotifyPayload, notifyPayload));

        if (affected == 0) {
            /*
             * 走到这里只剩两种情形，都是**真·重复投递**：
             *   - success / refunded：这笔钱早已入账（或已退回）；
             *   - failed：渠道此前已明确判定这笔没成。
             * 注意 closed **不会**出现在这里 —— 它已被上面放行。
             */
            log.info("[pay] settlement skipped (already terminal) paymentId={} status={}",
                    payment.getId(), currentStatus(payment.getId()));
            return;
        }

        /*
         * 诊断用：入参 payment 的状态是**调用方刚刚读出来的库值**（三个调用点都走
         * selectOne/selectById 现取，没有缓存），所以拿它判断「这笔是不是关掉后才到的款」
         * 是准的。只打日志、不参与任何判断 —— 绝不能让一个诊断分支影响资金动作。
         */
        if (Payment.STATUS_CLOSED.equals(payment.getStatus())) {
            log.warn("[pay] channel confirmed payment on a CLOSED payment (notify arrived after "
                            + "timeout close) - order will be auto-refunded. paymentId={} orderId={}",
                    payment.getId(), payment.getOrderId());
        }

        boolean advanced = orderService.markPaid(payment.getOrderId(), payment.getChannel());
        if (!advanced) {
            /*
             * ★ 订单已不可付，但钱已经收了 ★
             *
             * 唯一能走到这里的情况是「超时关单」与「用户付款」并发且关单先赢。
             * 处理原则很明确：**订单作废了就不能留着这笔钱**，自动原路退回。
             * 回退失败时不抛异常（抛了会把这条支付记录一起回滚掉，钱就彻底成了
             * 一笔"没有痕迹"的进账），而是把失败原因写进支付单并记 ERROR 日志，
             * 留一条能被检索到的人工处理线索。
             */
            log.warn("[pay] paid but order not payable, auto-refunding. orderId={} paymentId={}",
                    payment.getOrderId(), payment.getId());
            autoRefund(payment, "订单已关闭，自动退回");
            return;
        }

        log.info("[pay] settled. orderId={} paymentId={} channel={} amount={}",
                payment.getOrderId(), payment.getId(), payment.getChannel(), payment.getAmount());
    }

    /**
     * 自动退回（订单已关闭时）。
     * <p>
     * 与人工退款走同一条 {@code channel.refund}，只是发起方是系统。
     */
    private void autoRefund(Payment payment, String reason) {
        try {
            PayChannel channel = registry.find(payment.getChannel());
            boolean done;
            if (channel == null || !channel.refundable()) {
                failOpen(payment, "订单已关闭且渠道无法自动退回，需人工处理");
                return;
            }
            PayChannel.RefundResult result = channel.refund(new PayChannel.RefundContext(
                    payment.getId(), payment.getOutTradeNo(), payment.getTradeNo(),
                    payment.getBuyerId(), payment.getAmount(), payment.getAmount(), reason));
            done = result.ok();
            if (done) {
                markRefunded(payment, payment.getAmount());
                log.warn("[pay] auto-refund OK. paymentId={} amount={} msg={}",
                        payment.getId(), payment.getAmount(), result.message());
            } else {
                failOpen(payment, "自动退回失败：" + result.message());
            }
        } catch (Exception e) {
            // 渠道调用可能因网络/配置失败。绝不把异常抛出去 —— 见 settle 的注释
            log.error("[pay] auto-refund FAILED, manual handling required. paymentId={} orderId={}",
                    payment.getId(), payment.getOrderId(), e);
            failOpen(payment, "自动退回异常：" + e.getMessage());
        }
    }

    /** 标记「钱已收但需要人工处理」：状态仍是 success（钱确实在我们这里），把原因写进 fail_reason */
    private void failOpen(Payment payment, String reason) {
        paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getId, payment.getId())
                .set(Payment::getFailReason, reason));
    }

    /* ==================================================================
     * 退款（管理端入口）
     * ================================================================== */

    /**
     * 退款并**原路退回**。
     * <p>
     * ★★ 改造前这里最大的问题是：钱根本没动 ★★
     * <p>
     * 原 {@code OrderService#refundOrder} 只是把订单改成「已取消」并写几个退款字段，
     * 界面上显示「已退款 ¥45.00」，而买家的钱**还留在平台账上**。
     * 这不是"实现不完整"，是**账实不符**：对账时平台显示已支出 45 元，
     * 实际资金一动不动。
     * <p>
     * 现在的顺序（**不能调**）：
     * <ol>
     *   <li>订单侧落地（含状态校验、保留买家申请原因、库存回补）——
     *       校验失败要在这里就失败，不能先把钱退出去再发现这单不该退；</li>
     *   <li>渠道原路退回 —— 唯一会失败的外部调用。放在订单侧之后，
     *       失败时整个事务回滚，订单侧的改动一并撤销，不会出现「记录说退了、钱没退」；</li>
     *   <li>支付单标记 refunded。</li>
     * </ol>
     * <p>
     * ★ 残留风险（必须知道）★
     * 渠道（支付宝）退款是**外部 HTTP 调用，不参与本地事务**。若第 2 步成功、
     * 第 3 步的本地更新失败，事务回滚会撤销第 1 步，但支付宝那笔钱已经出去了。
     * 这个窗口极小（一次主键更新），但一旦发生需要人工介入 ——
     * 所以第 3 步之外还打一条带支付单号的 ERROR 日志作为检索锚点。
     *
     * @param amount 退款金额；为 null 时按订单实付全额退
     */
    @Transactional
    public void refundForOrder(String orderId, BigDecimal amount, String reason, String remark) {
        Order order = orderMapper.selectById(orderId);
        if (order == null) {
            throw BusinessException.notFound("订单不存在");
        }

        BigDecimal refundAmount = scale(amount != null ? amount : order.getAmount());
        Payment paid = findSuccessPayment(orderId);

        // ① 订单侧先落地（所有校验都在里面，失败即整体不生效）
        orderService.refundOrder(orderId, refundAmount, reason, remark);

        /*
         * ② 没有成功支付单：改造前的老订单，或管理员线下代收的订单。
         *    这种情况下**没有第三方通道可退**，钱本来就在平台手上（现金/转账），
         *    只能由管理员线下处理 —— 所以这里如实记录，而不是假装"已原路退回"。
         */
        if (paid == null) {
            log.warn("[pay] refund without successful payment (legacy/offline order). orderId={} amount={}",
                    orderId, refundAmount);
            return;
        }

        PayChannel channel = registry.find(paid.getChannel());
        if (channel == null) {
            throw BusinessException.of("找不到该订单使用的支付渠道「" + paid.getChannel()
                    + "」，无法原路退回，请联系运维核对");
        }
        if (!channel.refundable()) {
            throw BusinessException.of("支付渠道「" + channel.label()
                    + "」不支持原路退回，请线下处理");
        }

        PayChannel.RefundResult result = channel.refund(new PayChannel.RefundContext(
                paid.getId(), paid.getOutTradeNo(), paid.getTradeNo(), paid.getBuyerId(),
                paid.getAmount(), refundAmount, order.getRefundReason()));
        if (!result.ok()) {
            // 抛出去 → 事务回滚 → 订单侧的退款记录一并撤销，避免「记录说退了、钱没退」
            throw BusinessException.of("原路退回失败：" + result.message());
        }

        // ③ 标记支付单已退回（条件更新：只有 success 的支付单能被标记，重复退款时不会被记两次）
        markRefunded(paid, refundAmount);
        log.info("[pay] refunded. orderId={} paymentId={} amount={} msg={}",
                orderId, paid.getId(), refundAmount, result.message());
    }

    /* ==================================================================
     * 超时关单（定时任务入口）
     * ================================================================== */

    /**
     * 关掉超时未付款的订单与支付单。
     * <p>
     * ★★ 这个方法把一条「死配置」接上了真实执行路径 ★★
     * <p>
     * 改造前：前端有 {@code ORDER_SLA_HOURS.pending_payment = 24} 用于把超时订单标红，
     * 后端 SQL 片段 {@code slaBreach} 也把它筛选出来 —— 但**全仓没有一个定时任务真的关单**。
     * 于是买家拍下不付，库存被永久占住：卖家不能卖给别人，自己也解除不了
     * （{@code cancelByBuyer} 只有买家能调）。商品就这样从货架上消失了，
     * 而管理员在后台看到的只是一条普通的「待付款」。
     * <p>
     * ★ 这个方法**刻意不加** {@code @Transactional} ★
     * <p>
     * 每笔订单的关闭由 {@code orderService.closeExpiredOrder} 各自开事务。
     * 若整个批量共用一个事务，其中一笔因为数据异常失败就会把整批都回滚 ——
     * 而定时任务没有重试机制，结果是**每一轮都失败在同一笔上，后面永远处理不到**。
     * 逐笔独立事务的代价只是「部分成功」，但至少每次都在前进。
     *
     * @return 本次关闭的订单数
     */
    public int closeExpired() {
        LocalDateTime now = LocalDateTime.now();

        // ① 先关支付单：它是「还可能成功」的标志，必须先失效，否则用户在关单后立刻付款仍会被受理
        int closedPayments = paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING)
                .isNotNull(Payment::getExpireAt)
                .lt(Payment::getExpireAt, now)
                .set(Payment::getStatus, Payment.STATUS_CLOSED)
                .set(Payment::getFailReason, "支付超时，已自动关闭"));

        // ② 再关订单（逐笔独立事务）
        List<Order> due = orderMapper.selectList(new LambdaQueryWrapper<Order>()
                .eq(Order::getStatus, "pending_payment")
                .isNotNull(Order::getPayExpireAt)
                .lt(Order::getPayExpireAt, now)
                .orderByAsc(Order::getPayExpireAt)
                .last("LIMIT " + Math.max(1, props.getCloseBatchSize())));

        int closedOrders = 0;
        for (Order order : due) {
            try {
                if (orderService.closeExpiredOrder(order.getId())) {
                    closedOrders++;
                }
            } catch (Exception e) {
                // 单笔失败不能拖垮整批：记下来，继续下一笔
                log.error("[pay] close expired order FAILED. orderId={}", order.getId(), e);
            }
        }

        if (closedPayments > 0 || closedOrders > 0) {
            log.info("[pay] timeout close done. payments={} orders={}", closedPayments, closedOrders);
        }
        return closedOrders;
    }

    /* ==================================================================
     * 主动对账（回调丢失时的兜底）
     * ================================================================== */

    /**
     * 一笔支付单的对账结论（供定时任务统计与打日志）。
     */
    public enum ReconcileOutcome {
        /** 不需要处理：不是 paying / 渠道不支持查单 / 已被别的路径处理掉 */
        SKIPPED,
        /** 查单请求没问成（网络、网关、验签）。**什么都没改**，下一轮再问 */
        UNAVAILABLE,
        /** 渠道确认这笔还没成（用户还在收银台 / 交易已关闭）。什么都没改 */
        NOT_PAID,
        /** 渠道确认钱已到账，且金额与支付单逐分相等 → 已结算 */
        SETTLED,
        /** 渠道说付款了，但金额与支付单不符 → 拒绝结算，留 ERROR 待人工核对 */
        AMOUNT_MISMATCH
    }

    /**
     * 找出「值得去问渠道」的支付单号。
     * <p>
     * ★★ 这个方法回答的是「哪些订单可能已经付了钱、而我们不知道」★★
     * <p>
     * ★★★ 候选分两类，各自覆盖支付单生命周期的一段，各自带自己的时间窗 ★★★
     * <ol>
     *   <li><b>还在等结果的</b>：{@code status = 'paying'} + {@code expire_at > now}
     *       + {@code create_time < now - 宽限期}。这一段的含义是「已把用户送去收银台、
     *       结果未知」；{@code created} 还没送出去，{@code success/failed/refunded}
     *       是真终态，都不在这里。
     *       <b>已过期的交给超时关单任务，不在这里抢</b> —— 两个任务同时处理同一笔
     *       会在「关单」与「入账」之间形成难以复现的竞态，而这类竞态的后果是钱。
     *       边界必须清晰：<b>未过期归对账，已过期归关单</b>；</li>
     *   <li><b>刚被关掉的</b>：{@code status = 'closed'} +
     *       {@code update_time >= now - 回看窗口}。
     *       ★ 这一类补的正是上面那条边界留下的真空期 ★
     *       关单只代表「我们不再等了」，**不代表「这笔没成」**：用户在到期前最后
     *       一两分钟付款、而通知始终不来时，关单任务会把支付单写成 {@code closed} ——
     *       于是这笔钱既不在「未过期候选」里（它已过期），也不是任何人的待办。
     *       窗口与默认值的取舍见
     *       {@link PayProperties#getReconcileLookbackMinutes()}。
     *       <p>
     *       关单时刻用 {@code update_time} 当锚，它由 DDL 的
     *       {@code ON UPDATE CURRENT_TIMESTAMP} 在关单那一次 UPDATE 时写定；
     *       全仓没有 MyBatis-Plus 的自动填充处理器（没有 {@code MetaObjectHandler}），
     *       所以这个锚**依赖建表语句里的那一句**，见 {@code t_payment} 建表语句。
     *       改 DDL 时把这一句去掉，本类会静默退化成一个永远选不到候选的分支 ——
     *       不报错、不打日志，只是钱又要靠那条不保证到达的通知。</li>
     * </ol>
     * <p>
     * ★ 顺序：先「刚被关掉的」，再「还在等结果的」★
     * 两类的可取数都受同一个批大小限制，而<b>窗口长度差了两个数量级</b>：
     * 回看窗口只有分钟级，{@code paying} 那类能撑到 {@code expire_at}（默认 24 小时）。
     * 若渠道长时间不可用造成积压，先跑长窗口那一类会把批大小用光，
     * 于是短窗口的候选「还没轮到就已经出窗」—— 这种错过是**不可挽回**的；
     * 而长窗口那类晚一轮再问完全无害。先处理稀缺的那一类。
     * <p>
     * ★ 渠道筛选放在这里而不是 SQL 里 ★
     * SQL 不知道哪条渠道支持查单。不用「调一下 query 试试」那种探测式判断
     * （那等于每筛一次就往渠道打请求），而是问 {@link PayChannel#queryable()}。
     * 实践中同步渠道（钱包 / 演示）在 {@code create} 当场就结算，根本不会留下
     * {@code paying} 的行，所以这个筛选通常是空转 —— 但它必须存在：
     * 将来新增一条「同步创建、异步结果」的渠道时，这里不会把它错当成可查单的渠道。
     *
     * @return 待对账的支付单号，两段各自按时间从早到晚；同一单只出现一次
     */
    public List<String> findReconcileCandidates() {
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime createdBefore = now.minusMinutes(Math.max(1, props.getReconcileGraceMinutes()));
        LocalDateTime closedAfter = now.minusMinutes(Math.max(1, props.getReconcileLookbackMinutes()));
        int limit = Math.max(1, props.getReconcileBatchSize());

        /*
         * ★ 为什么拆成两条查询，而不是并在一条 OR 里 ★
         * 两类候选的判据落在不同的列上（paying 看 expire_at，closed 看 update_time），
         * 并在一条 OR 里会让优化器用不上任何一条「等值列 + 时间列范围」索引
         * （t_payment 上有 idx_payment_status_expire(status, expire_at)），退化成全表扫。
         * 拆开之后每一类还能各自带 LIMIT —— 批大小约束的是**对渠道的请求数**，
         * 不是行数，所以两条各自限流才是它真正的语义。
         * ★ 顺序即优先级：先稀缺的短窗口，再长窗口（理由见方法注释）★
         */
        List<Payment> justClosed = paymentMapper.selectList(new LambdaQueryWrapper<Payment>()
                .eq(Payment::getStatus, Payment.STATUS_CLOSED)
                .ge(Payment::getUpdateTime, closedAfter)
                .orderByAsc(Payment::getUpdateTime)
                .last("LIMIT " + limit));

        List<Payment> stillOpen = paymentMapper.selectList(new LambdaQueryWrapper<Payment>()
                .eq(Payment::getStatus, Payment.STATUS_PAYING)
                .isNotNull(Payment::getExpireAt)
                .gt(Payment::getExpireAt, now)
                .lt(Payment::getCreateTime, createdBefore)
                .orderByAsc(Payment::getCreateTime)
                .last("LIMIT " + limit));

        /*
         * LinkedHashSet 去重：同一张支付单不可能同时是 paying 与 closed，
         * 所以正常情况下去不了重 —— 但「不可能」不构成允许结果重复的理由。
         * 对账的代价是一次真实的出站请求，重复一个号就是白白多打一次渠道。
         */
        Set<String> out = new LinkedHashSet<>();
        for (Payment p : justClosed) {
            addIfQueryable(out, p);
        }
        for (Payment p : stillOpen) {
            addIfQueryable(out, p);
        }
        return new ArrayList<>(out);
    }

    /**
     * 只有「渠道存在且支持查单」的支付单才进候选。
     * <p>
     * 这只是**预筛**，不是最终闸门 —— 真正决定要不要发请求的是
     * {@link #reconcileOne} 里的同一份判断。两处都查一遍是为了让
     * 「候选集」本身就不含注定会被跳过的号：否则批大小会被这类号占满。
     */
    private void addIfQueryable(Set<String> out, Payment p) {
        PayChannel channel = registry.find(p.getChannel());
        if (channel != null && channel.queryable()) {
            out.add(p.getId());
        }
    }

    /**
     * 对一笔支付单做主动对账：问渠道「这笔到底成了没有」，成了就结算。
     * <p>
     * ★ 处理的支付单包含 {@code closed}（关单后仍被追问一段，见
     * {@link #findReconcileCandidates()}）★ 对这类单子，正常结局不是「订单复活」
     * 而是「确认收款 → 订单已作废 → 自动原路退回」：关单过的订单不会被本方法救活，
     * 它只保证那笔钱有归宿、有痕迹。
     * <p>
     * ★★★ 与回调走的是同一条结算路径 ★★★
     * <p>
     * 这里**没有**任何自己的入账逻辑：确认收款后调用的还是 {@link #settle}，
     * 也就是回调那条路径终点的同一个方法。所以「对账兜底」不会变成第二条
     * 能把订单推进到待发货的路 —— 全仓依然只有一个入口，审计口径没有变宽。
     * <p>
     * ★ 金额闸门与回调**同一条**，一分都不能松 ★
     * 渠道回传的实收金额必须与支付单逐分相等才结算。少了不行（少付钱），
     * 多了也不行（多收的钱没有归属，反而制造对账难题）。不等时不结算、
     * 只留一条带全部数字的 ERROR 日志 —— 与回调路径的行为一致：
     * <b>拒绝 + 留证据 + 等人工</b>，而不是自己猜一个处理方式。
     * <p>
     * ★ 为什么本方法带 {@code @Transactional} 而调用方（定时任务）逐笔调用 ★
     * 单笔的「改支付单 + 推进订单」必须同生共死；而整批共用一个事务会让
     * 某一笔的数据异常把整批回滚掉，定时任务没有重试机制，后果是**每一轮都失败
     * 在同一笔上，后面的永远处理不到**。所以入口在调度器那一侧逐笔循环、
     * 每笔独立事务（与 {@link #closeExpired} 同一套取舍）。
     * <p>
     * 另注：这里能生效是因为调用方是**另一个 Bean**（{@code PaymentReconcileJob}）——
     * Spring 的事务靠代理织入，若把 {@code @Scheduled} 写在本类里再调自己，
     * 拿到的会是原始对象、事务静默失效。这条坑见 {@code GoodsOfflineJob} 的类注释。
     */
    @Transactional
    public ReconcileOutcome reconcileOne(String paymentId) {
        Payment payment = paymentMapper.selectById(paymentId);
        if (payment == null) {
            // 一轮里少一笔不该中断整批。对账天生要容忍「读到的时候它已经不在了」
            return ReconcileOutcome.SKIPPED;
        }
        /*
         * ★★★ 可对账的状态必须含 closed —— 否则「刚被关掉」那类候选会被当场跳过 ★★★
         *   - paying：正常在途，结果未知；
         *   - closed：**我们不再等了，不代表这笔没成**。用户在到期前最后一两分钟付款、
         *     通知又始终不来时，这一笔正是关单之后才需要被追问的（见
         *     findReconcileCandidates 的第二类候选）。
         * 排除 created（还没送去收银台，问不出结果）与 success/failed/refunded（真终态）。
         * ★ 放宽这里**不会**变成第二条入账路径 ★：确认收款后走的还是下面同一个
         *   {@link #settle}，它自己的条件更新与订单闸门一个字都没改。
         */
        if (!Payment.STATUS_PAYING.equals(payment.getStatus())
                && !Payment.STATUS_CLOSED.equals(payment.getStatus())) {
            // 已经被回调、关单任务或另一轮对账处理掉了。对账天生要容忍这个
            return ReconcileOutcome.SKIPPED;
        }
        if (Payment.STATUS_CLOSED.equals(payment.getStatus())) {
            /*
             * 诊断日志：这一笔是关单之后才来问的。若渠道确认收款，settle 会把支付单
             * 恢复成 success，随后因订单已作废而走既有的自动原路退回 ——
             * 即这条路径的正常结局是「钱退回去」，不是「订单复活」。
             * 先把它说出来，免得日后看到 success → refunded 的轨迹时误判成异常。
             */
            log.warn("[pay-reconcile] reconciling a CLOSED payment (query after timeout close). "
                            + "If the channel confirms payment it will be settled then auto-refunded. "
                            + "paymentId={} orderId={}",
                    payment.getId(), payment.getOrderId());
        }
        PayChannel channel = registry.find(payment.getChannel());
        if (channel == null || !channel.queryable()) {
            return ReconcileOutcome.SKIPPED;
        }

        PayChannel.QueryResult result = channel.query(payment.getOutTradeNo());
        switch (result.outcome()) {
            case UNSUPPORTED -> {
                return ReconcileOutcome.SKIPPED;
            }
            case UNAVAILABLE -> {
                // 结论未知：一个字都不改，下一轮再问。绝不能因为「问不到」就动状态
                log.warn("[pay-reconcile] query unavailable, leaving untouched. paymentId={} reason={}",
                        payment.getId(), result.message());
                return ReconcileOutcome.UNAVAILABLE;
            }
            case NOT_PAID -> {
                /*
                 * ★ 这里刻意「什么都不做」★
                 * WAIT_BUYER_PAY 是用户还站在收银台前的**正常状态**；TRADE_CLOSED
                 * 与「查无此单」也由超时关单任务按 expire_at 统一收口。
                 * 若在这里标失败，就与「用户下一秒付款成功」直接冲突。
                 */
                return ReconcileOutcome.NOT_PAID;
            }
            case PAID -> {
                if (result.paidAmount() == null
                        || result.paidAmount().compareTo(payment.getAmount()) != 0) {
                    log.error("[pay-reconcile] AMOUNT MISMATCH - manual check required. "
                                    + "paymentId={} orderId={} outTradeNo={} expect={} channelSaid={} tradeNo={}",
                            payment.getId(), payment.getOrderId(), payment.getOutTradeNo(),
                            payment.getAmount(), result.paidAmount(), result.tradeNo());
                    return ReconcileOutcome.AMOUNT_MISMATCH;
                }
                // 原始报文与回调同列存证；加标记是为了事后能分清「这笔是被查单兜住的」，
                // 而不是白等一场回调 —— 对账时这个区别很重要（它代表回调链路有问题）
                settle(payment, result.tradeNo(), "[reconcile] " + result.tradeStatus());
                return ReconcileOutcome.SETTLED;
            }
            default -> {
                return ReconcileOutcome.SKIPPED;
            }
        }
    }

    /* ==================================================================
     * 内部工具
     * ================================================================== */

    /** 关掉某订单上所有还活着的支付单（换渠道 / 重复点击时调用） */
    private int closeActivePayments(String orderId, String reason) {
        return paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getOrderId, orderId)
                .in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING)
                .set(Payment::getStatus, Payment.STATUS_CLOSED)
                .set(Payment::getFailReason, reason));
    }

    /** 渠道明确判定失败：只有还活着的支付单才会被标记，避免覆盖已成功的记录 */
    private void markFailed(Payment payment, String reason, String raw) {
        paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getId, payment.getId())
                .in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING)
                .set(Payment::getStatus, Payment.STATUS_FAILED)
                .set(Payment::getFailReason, truncate(reason, 200))
                .set(Payment::getNotifyPayload, raw));
        log.info("[pay] payment marked failed. paymentId={} reason={}", payment.getId(), reason);
    }

    /**
     * 支付单标记已退回。
     * <p>
     * ★ 条件更新 {@code eq(status,'success')} 是退款幂等的关键 ★
     * 管理员重复点「同意退款」、或系统自动退款与人工退款撞车时，
     * 只有第一次能让 {@code affected == 1}。凭这一点，调用方可以判断
     * 「这次是不是我真的退的钱」，避免同一笔钱被记两次、或者被退两次。
     */
    private void markRefunded(Payment payment, BigDecimal refundAmount) {
        int affected = paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getId, payment.getId())
                .eq(Payment::getStatus, Payment.STATUS_SUCCESS)
                .set(Payment::getStatus, Payment.STATUS_REFUNDED)
                .set(Payment::getRefundAmount, refundAmount)
                .set(Payment::getRefundTime, LocalDateTime.now()));
        if (affected == 0) {
            log.error("[pay] REFUND RECORD FAILED - channel refunded but local state not updated, "
                            + "manual reconciliation required. paymentId={} amount={}",
                    payment.getId(), refundAmount);
        }
    }

    private Payment findByOutTradeNo(String outTradeNo) {
        if (outTradeNo == null || outTradeNo.isBlank()) {
            return null;
        }
        return paymentMapper.selectOne(new LambdaQueryWrapper<Payment>()
                .eq(Payment::getOutTradeNo, outTradeNo)
                .last("LIMIT 1"));
    }

    private Payment latestPayment(String orderId) {
        return paymentMapper.selectOne(new LambdaQueryWrapper<Payment>()
                .eq(Payment::getOrderId, orderId)
                .orderByDesc(Payment::getId)
                .last("LIMIT 1"));
    }

    /** 该订单上成功的支付单（至多一张，由结算的条件更新保证） */
    private Payment findSuccessPayment(String orderId) {
        return paymentMapper.selectOne(new LambdaQueryWrapper<Payment>()
                .eq(Payment::getOrderId, orderId)
                .eq(Payment::getStatus, Payment.STATUS_SUCCESS)
                .orderByDesc(Payment::getId)
                .last("LIMIT 1"));
    }

    private String currentStatus(String paymentId) {
        Payment p = paymentMapper.selectById(paymentId);
        return p == null ? "gone" : p.getStatus();
    }

    private BigDecimal balanceOf(Long userId) {
        if (userId == null) {
            return BigDecimal.ZERO;
        }
        User user = userMapper.selectById(userId);
        return user != null && user.getBalance() != null ? user.getBalance() : BigDecimal.ZERO;
    }

    /** 没指定渠道时用第一条可用的：保证前端老版本（不带 channel）也能付款 */
    private PayChannel firstAvailableChannel() {
        List<PayChannel> available = registry.available();
        if (available.isEmpty()) {
            throw BusinessException.of("当前没有可用的支付方式，请联系管理员");
        }
        return available.get(0);
    }

    /** 金额归一：两位小数。库列是 decimal(10,2)，多出的位会被 MySQL 静默截断，导致账目漂移 */
    private BigDecimal scale(BigDecimal value) {
        return (value == null ? BigDecimal.ZERO : value).setScale(2, RoundingMode.HALF_UP);
    }

    private String truncate(String text, int max) {
        if (text == null) {
            return null;
        }
        return text.length() > max ? text.substring(0, max) : text;
    }
}
