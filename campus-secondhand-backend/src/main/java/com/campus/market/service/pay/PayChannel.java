package com.campus.market.service.pay;

import java.math.BigDecimal;
import java.util.Map;

/**
 * 支付渠道：把「收钱」这件事抽象成一条可替换的通道。
 * <p>
 * ★★ 为什么要这一层抽象 ★★
 * <p>
 * 三条渠道（钱包余额 / 演示渠道 / 支付宝沙箱）在**业务流程上完全不同**：
 * 钱包是从数据库里扣一个数字、当场就有结果；支付宝要把用户送到外部收银台、
 * 等一个异步回调、还要验签；演示渠道则什么都不做。
 * <p>
 * 但它们对**订单状态机**的诉求是同一个：
 * <pre>
 *   给我一笔应付金额 → 告诉我要把用户送哪儿去（或者钱已经收了）
 *   → 之后（可能过几秒、也可能过几分钟）告诉我这笔到底成没成
 *   → 如果订单后来被关掉了，把钱退回去
 * </pre>
 * 把这三件事固定成接口，收益有两层：
 * <ol>
 *   <li><b>换渠道不动基建</b>：接入第四条渠道（微信、校园卡、银联）只需新增一个实现类，
 *       支付单、幂等、回调入口、超时关单、退款链路一行都不用改；</li>
 *   <li><b>演示与生产共用一条路径</b>：演示渠道走的是**同一套**建单 → 结算 → 退款流程，
 *       只是渠道实现内部什么都不做。所以「演示跑得通」这件事对真实渠道是有意义的 ——
 *       它不是一条专用假路径，而是同一条路径换了个末端。</li>
 * </ol>
 *
 * ★★ 渠道只负责「动钱」，不负责「改订单」★★
 * <p>
 * 这是本接口最重要的边界，也是避免循环依赖的关键：
 * <ul>
 *   <li>{@link #create} 只做「渠道侧该做的事」——钱包扣余额并记流水、
 *       支付宝生成跳转 URL、演示渠道什么也不做；</li>
 *   <li>「把订单推进到待发货」这一步**永远**由
 *       {@code PaymentService#settle} 完成，渠道不碰 {@code t_order}。</li>
 * </ul>
 * 这条边界让 {@code WalletPayChannel} 不必依赖 {@code OrderService}，
 * 而 {@code OrderService} 也不必反过来依赖渠道 —— 两边只认「支付单」这一个交汇点。
 * <p>
 * ★ 与之配套的一条硬规则：渠道 {@link #create} **绝不返回「支付成功」** ★
 * <p>
 * 它只允许回答「用户现在去哪儿付」。真正的成功必须走 {@link #parseNotify}
 * （异步渠道）或 {@link CreateResult.Kind#DONE}（同步渠道），
 * 两者最终都汇入同一段结算代码。这样「订单被推进」这件事全仓只有一个入口，
 * 审计时只需要看那一个方法。
 *
 * @see PayChannelRegistry 渠道注册表（按 code 取渠道，并过滤掉不可用的）
 */
public interface PayChannel {

    /* ==================================================================
     * 身份
     * ================================================================== */

    /** 渠道编码，落库在 {@code t_payment.channel}。**改了就是历史数据断链，不要改** */
    String code();

    /** 收银台上显示的名字 */
    String label();

    /** 收银台上的补充说明（告诉用户这条渠道下一步会发生什么） */
    String hint();

    /**
     * 这条渠道当前是否可用。
     * <p>
     * ★ 必须能回答「不可用」，而不是靠抛异常 ★
     * <p>
     * 支付宝沙箱需要 appid 与 RSA2 私钥；没配置时它不该出现在收银台上，
     * 更不该在用户点下去之后才报错。所以收银台的渠道列表由本方法过滤，
     * {@link PayChannelRegistry#get(String)} 也会拒绝不可用的渠道。
     * <p>
     * 注意：未配置**不能**导致启动失败 —— 仓库里不能有密钥，而开发环境本来就该
     * 只跑钱包与演示渠道。这条渠道"沉默地不存在"才是正确的默认状态。
     */
    boolean available();

    /* ==================================================================
     * 发起支付
     * ================================================================== */

    /**
     * 发起一次支付：渠道侧该做的事都在这里做完（扣余额 / 拼收银台 URL）。
     * <p>
     * ★ 实现方不负责改订单状态，也不负责写支付单状态 ★
     * 那些是 {@code PaymentService} 的职责（见类注释）。
     *
     * @throws com.campus.market.common.BusinessException 渠道侧拒绝（余额不足等）
     */
    CreateResult create(CreateContext ctx);

    /* ==================================================================
     * 渠道回调
     * ================================================================== */

    /**
     * 这条渠道有没有**异步**回调。
     * <p>
     * 钱包与演示渠道是同步的（调用 {@link #create} 当场就有结果），
     * 返回 {@code false}；支付宝返回 {@code true}。
     * 回调接口据此拒绝本该同步完成的渠道 —— 否则会出现「谁都能拿钱包渠道的名字
     * 往回调地址上打一个请求」这种毫无意义的攻击面。
     */
    default boolean asyncNotify() {
        return false;
    }

    /**
     * 解析并**验签**渠道回调。
     * <p>
     * ★★ 这是整个支付链路唯一的信任边界 ★★
     * <p>
     * 回调地址是公开的（必须公开，否则渠道打不进来），任何人都能往它发请求。
     * 所以「这段报文是不是渠道发的」只能靠验签回答，绝不能靠「参数看起来对」。
     * 实现方必须在返回 {@code ok=true} 之前完成：
     * <ol>
     *   <li>验签（用渠道公钥）；</li>
     *   <li>校验 appid / 卖家账号确实是本商户的（防止别的商户的回调被重放到这里）；</li>
     *   <li>把金额、订单号原样带出来 —— **但不在这一层比对金额**，
     *       金额比对属于业务判断，放在 {@code PaymentService} 里与支付单一起做。</li>
     * </ol>
     *
     * @param params 已解析的表单参数（渠道一律用 form-urlencoded 提交）
     * @return 解析结果；{@code ok=false} 表示验签失败或不认识这段报文
     */
    NotifyResult parseNotify(Map<String, String> params);

    /* ==================================================================
     * 主动查单（回调丢了时的兜底）
     * ================================================================== */

    /**
     * 这条渠道能不能被**主动查询**交易结果。
     * <p>
     * ★ 必须是一个独立的问题，不能靠「调一下 query() 试试」来回答 ★
     * <p>
     * 对账任务要先筛出「哪些支付单值得去问渠道」。如果靠调用 {@link #query} 试出来，
     * 那么每筛一次就要往渠道打一次真实请求 —— 而筛的目的恰恰是**少打请求**。
     * 更要紧的是：一个真实的查单请求到了渠道侧是**有成本、有风控计数**的，
     * 用它当探针，等于把探测行为混进了业务流量。
     */
    default boolean queryable() {
        return false;
    }

    /**
     * 主动查单：渠道侧那笔交易到底成了没有。
     * <p>
     * ★★ 这是「回调丢了」唯一的解药 ★★
     * <p>
     * 异步通知是**尽力投递**，不是保证送达：渠道重推队列积压、回调地址短暂不可用、
     * 我们这边重启，都会让通知永远到不了。此时用户的钱已经付了，而订单还停在「待付款」。
     * <p>
     * 更糟的是它不会一直等下去 —— 超时关单任务到点会把订单与支付单一起关掉，
     * 于是事情定格成：**钱在渠道手上、订单已作废、而且按「终态跳过」的写法没有任何代码会去退它**。
     * 所以「回调可能丢」这件事必须有一个**主动**的出口：由我们反过来问渠道，
     * 而不是被动等它再来一次。
     * <p>
     * ★ 默认「不支持」是刻意的，不是没实现 ★
     * <p>
     * 钱包与演示渠道在 {@link #create} 当场就返回 {@code DONE}，根本不存在「结果未知」的窗口，
     * 也就没有可查的远端状态。若默认抛 {@code UnsupportedOperationException} 或返回 null，
     * 调用方就分不清「这条渠道不支持查单」与「渠道没查到」—— 而这两种情况的处置截然不同：
     * 前者要跳过，后者要**原样留着、下一轮再问**（网络抖动问不到 ≠ 这笔没成）。
     *
     * @param outTradeNo 提交给渠道的商户订单号（本项目即支付单号）
     * @return 查询结果；{@link QueryOutcome#UNSUPPORTED} 表示该渠道没有查单能力。
     *         ★ 实现方不得在这里判金额是否相符 ★ —— 那要与支付单一起比，属于业务规则
     *         （与 {@link #parseNotify} 同一条边界）
     */
    default QueryResult query(String outTradeNo) {
        return QueryResult.unsupported();
    }

    /* ==================================================================
     * 退款
     * ================================================================== */

    /**
     * 原路退回。
     * <p>
     * ★ 为什么不实现成「改个状态就算退了」★
     * <p>
     * 钱是从哪条渠道进来的，就必须从哪条渠道回去 —— 这是支付行业的基本要求，
     * 也是本项目改造前最大的缺口：{@code refundOrder} 只是把订单状态改成「已取消」，
     * 买家的钱**根本没有动**。管理员点一下「同意退款」，界面上显示「已退款 ¥45」，
     * 而钱还在平台账上。
     * <p>
     * 默认实现是「该渠道不支持退款」并抛业务异常 —— 宁可让管理员看到失败，
     * 也不要静默地假装退成功。
     */
    default RefundResult refund(RefundContext ctx) {
        throw new UnsupportedOperationException(
                "渠道「" + label() + "」未实现原路退回，请勿直接调用；"
                        + "调用方应先判断 refundable()");
    }

    /** 这条渠道能不能原路退回。返回 false 时调用方要给出明确提示，而不是硬退 */
    default boolean refundable() {
        return false;
    }

    /* ==================================================================
     * 契约对象
     * ================================================================== */

    /**
     * 发起支付的入参。
     *
     * @param paymentId 支付单号（也是给用户看的「支付单号」）
     * @param outTradeNo 商户订单号（提交给渠道的唯一号）
     * @param orderId   订单号（仅用于展示，渠道侧不认它）
     * @param amount    应付金额
     * @param subject   商品标题（渠道收银台上显示的那一行）
     * @param clientIp  发起支付的客户端 IP（支付宝要求上送，用于风控）
     */
    record CreateContext(String paymentId, String outTradeNo, String orderId,
                         BigDecimal amount, Long buyerId, String subject, String clientIp) {
    }

    /**
     * 发起支付的结果。
     *
     * @param kind    下一步形态：
     *                {@link Kind#REDIRECT} 跳到 {@code url}；
     *                {@link Kind#QR} 展示 {@code qrCode}；
     *                {@link Kind#DONE} 钱已经收了（同步渠道），调用方应立即结算
     * @param url     收银台地址（REDIRECT）
     * @param qrCode  二维码内容（QR）
     * @param message 给用户看的一句话（例如「余额已扣除」）
     */
    record CreateResult(Kind kind, String url, String qrCode, String message) {

        public enum Kind {
            /** 需要用户跳到外部收银台 */
            REDIRECT,
            /** 展示二维码，等用户扫码 */
            QR,
            /** 同步完成：钱已经收了 */
            DONE
        }

        public static CreateResult redirect(String url) {
            return new CreateResult(Kind.REDIRECT, url, null, "正在跳转到收银台…");
        }

        public static CreateResult qr(String qrCode) {
            return new CreateResult(Kind.QR, null, qrCode, "请用手机扫码完成支付");
        }

        public static CreateResult done(String message) {
            return new CreateResult(Kind.DONE, null, null, message);
        }
    }

    /**
     * 渠道回调的解析结果。
     *
     * @param ok         验签与商户校验是否通过。**false 时其余字段一律不可信**
     * @param outTradeNo 商户订单号（用它定位支付单）
     * @param tradeNo    渠道流水号
     * @param paidAmount 渠道声明的实收金额（与支付单金额的比对在 Service 层）
     * @param success    渠道判定这笔交易是否成功
     * @param failReason 失败原因（success=false 时有值）
     * @param raw        原始报文（原样存进 {@code t_payment.notify_payload} 存证）
     */
    record NotifyResult(boolean ok, String outTradeNo, String tradeNo, BigDecimal paidAmount,
                        boolean success, String failReason, String raw) {

        /** 验签失败 */
        public static NotifyResult rejected(String raw) {
            return new NotifyResult(false, null, null, null, false, "验签失败", raw);
        }
    }

    /**
     * 主动查单的**四态**结果。
     * <p>
     * ★★ 为什么不是「成功 / 失败」两态 ★★
     * <p>
     * 把「问不到」和「问到了、这笔没成」混在一起，会让对账任务做出错误动作。
     * 举个最容易踩的：网络超时导致查单失败 —— 若当成「这笔没成」，
     * 就可能去标记失败甚至关单，而实际上用户的钱早已到账。
     * 所以这里把四件事分开：
     * <ul>
     *   <li>{@link QueryOutcome#UNSUPPORTED} 渠道没有查单能力（同步渠道）→ 跳过；</li>
     *   <li>{@link QueryOutcome#UNAVAILABLE} 查单**本身**没问成（网络/网关/验签不过）
     *       → 结论未知，本轮什么都不做，下一轮再问；</li>
     *   <li>{@link QueryOutcome#PAID} 渠道确认钱已到账 → 交给结算；</li>
     *   <li>{@link QueryOutcome#NOT_PAID} 渠道确认这笔还没成（等待付款 / 已关闭 / 查无此单）
     *       → 什么都不做，<b>尤其不要在这里标失败</b>：
     *       {@code WAIT_BUYER_PAY} 是用户还站在收银台前的**正常状态**，
     *       提前标失败会与「用户下一秒付款成功」直接冲突。</li>
     * </ul>
     */
    enum QueryOutcome {
        /** 该渠道没有主动查单能力（钱包 / 演示这类同步渠道）。跳过，不是错误 */
        UNSUPPORTED,
        /** 查单请求本身没问成。**结论未知**，不得据此改变任何状态 */
        UNAVAILABLE,
        /** 渠道确认：钱已到账 */
        PAID,
        /** 渠道确认：这笔还没成（等待付款 / 交易已关闭 / 查无此单） */
        NOT_PAID
    }

    /**
     * 主动查单的结果。
     *
     * @param outcome    四态结论（见 {@link QueryOutcome}）
     * @param outTradeNo 商户订单号（回显，便于调用方核对问的是哪一笔）
     * @param tradeNo    渠道流水号（{@code PAID} 时应有值；这是对账的唯一钥匙）
     * @param paidAmount 渠道声明的实收金额（与支付单金额的比对在 Service 层，不在这里）
     * @param tradeStatus 渠道原始交易状态字符串（如 {@code TRADE_SUCCESS}），存证用
     * @param message    说明（{@code NOT_PAID} / {@code UNAVAILABLE} 时有值）
     */
    record QueryResult(QueryOutcome outcome, String outTradeNo, String tradeNo,
                       BigDecimal paidAmount, String tradeStatus, String message) {

        /** 该渠道不支持查单 */
        public static QueryResult unsupported() {
            return new QueryResult(QueryOutcome.UNSUPPORTED, null, null, null, null,
                    "该渠道不支持主动查单");
        }

        /** 没问成：网络 / 网关 / 响应验签不过。**结论未知** */
        public static QueryResult unavailable(String message) {
            return new QueryResult(QueryOutcome.UNAVAILABLE, null, null, null, null, message);
        }
    }

    /**
     * 退款入参。
     *
     * @param paymentId    支付单号
     * @param outTradeNo   原支付的商户订单号（退款要指向它）
     * @param tradeNo      原支付的渠道流水号
     * @param buyerId      原付款人（钱包渠道要按这个 id 把余额加回去）
     * @param orderAmount  原订单金额
     * @param refundAmount 本次退款金额（允许小于原金额 = 部分退款）
     * @param reason       退款原因（写给渠道与用户看）
     */
    record RefundContext(String paymentId, String outTradeNo, String tradeNo, Long buyerId,
                         BigDecimal orderAmount, BigDecimal refundAmount, String reason) {
    }

    /**
     * 退款结果。
     *
     * @param ok       渠道是否受理成功
     * @param refundNo 渠道退款单号（对账用，可为空）
     * @param message  说明
     */
    record RefundResult(boolean ok, String refundNo, String message) {

        public static RefundResult ok(String refundNo, String message) {
            return new RefundResult(true, refundNo, message);
        }

        public static RefundResult fail(String message) {
            return new RefundResult(false, null, message);
        }
    }
}
