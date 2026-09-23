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
import java.util.List;
import java.util.Map;

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
     *    WHERE id=? AND status IN ('created','paying')
     * </pre>
     * {@code affected == 0} 说明这张支付单已经是终态（成功过、失败过或已关闭）——
     * 此时**直接返回**，不碰订单。这就是「渠道重复投递同一条通知」不会重复推进订单的原因。
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
        int affected = paymentMapper.update(null, new LambdaUpdateWrapper<Payment>()
                .eq(Payment::getId, payment.getId())
                .in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING)
                .set(Payment::getStatus, Payment.STATUS_SUCCESS)
                .set(Payment::getTradeNo, tradeNo)
                .set(Payment::getPaidAt, now)
                .set(Payment::getNotifyPayload, notifyPayload));

        if (affected == 0) {
            log.info("[pay] settlement skipped (already terminal) paymentId={} status={}",
                    payment.getId(), currentStatus(payment.getId()));
            return;
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
