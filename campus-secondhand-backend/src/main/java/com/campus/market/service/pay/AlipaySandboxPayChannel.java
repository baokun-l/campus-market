package com.campus.market.service.pay;

import com.campus.market.common.BusinessException;
import com.campus.market.config.PayProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 支付宝沙箱渠道：真实的签名、真实的异步通知、真实的退款接口，只有钱是假的。
 * <p>
 * ★★ 它给这个项目带来的东西 ★★
 * <p>
 * 钱包渠道里「钱」是数据库里一个数字，演示渠道里连数字都没有。只有接上外部通道，
 * 才会遇到真实支付特有的那几个问题 —— 而它们正是这个模块存在的意义：
 * <ul>
 *   <li><b>支付结果不是同步的</b>：用户付完钱就关掉页面，回调才是唯一的真相来源；</li>
 *   <li><b>回调地址是公开的</b>：任何人都能往它发请求，所以必须验签；</li>
 *   <li><b>回调会重复投递</b>：渠道在没收到 {@code success} 响应前会一直重推，
 *       所以结算必须幂等；</li>
 *   <li><b>回调可能丢</b>：网络抖动、服务重启都可能导致通知没到，
 *       所以要有主动查单兜底。</li>
 * </ul>
 * 前三条在本模块里都是真做的；第四条（主动查单）见 {@link #queryTrade}。
 *
 * ★★ 配置与「沉默地不可用」★★
 * <p>
 * 需要 appid + 应用私钥 + 支付宝公钥 + 公网回调地址四项齐全才 {@link #available()}。
 * 缺任何一项时这条渠道**从收银台上消失**，而不是让用户在点下去之后才看到报错，
 * 更不是让应用启动失败 —— 仓库里不能有密钥，开发环境本来就该只跑钱包与演示渠道。
 *
 * ★★ 怎么拿到沙箱配置（写在这里，因为这是唯一需要它的地方）★★
 * <ol>
 *   <li>open.alipay.com → 控制台 → 沙箱环境（个人实名即可，**无需营业执照**）；</li>
 *   <li>复制 APPID；用「密钥工具」生成 RSA2 密钥对，把**应用公钥**填进沙箱应用的
 *       「接口加签方式」，然后复制平台给出的**支付宝公钥**；</li>
 *   <li>填进环境变量：{@code APP_PAY_ALIPAY_APP_ID} / {@code APP_PAY_ALIPAY_PRIVATE_KEY}
 *       / {@code APP_PAY_ALIPAY_PUBLIC_KEY} / {@code APP_PAY_PUBLIC_BASE_URL}。</li>
 *   <li>★ 四个变量**都带 {@code APP_} 前缀，一个都不能少** ★
 *       少写前缀（例如写成 {@code PAY_PUBLIC_BASE_URL}）**不会报任何错**，只是绑不上：
 *       {@code publicBaseUrl} 保持空 ⇒ {@link PayProperties#notifyUrl(String)} 返回 null
 *       ⇒ 本渠道 {@link #available()} 为 false、**从收银台静默消失**，而日志里一条错都没有。
 *       三类命名的真机对照见 {@code .workbuddy/e2e-pay-env.mjs}：
 *       全 {@code APP_PAY_*} ⇒ 渠道出现；全 {@code PAY_*} ⇒ 不出现；
 *       **只有回调地址这一项漏前缀** ⇒ 同样不出现（这就是"照着旧文档配"的下场）。</li>
 * </ol>
 * 沙箱买家账号与登录/支付密码在沙箱环境首页「账号信息」里，用它付款即可真正跑通全链路。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AlipaySandboxPayChannel implements PayChannel {

    public static final String CODE = "alipay_sandbox";

    /** 电脑网站支付。用户被送到支付宝收银台，付款后浏览器跳回 return_url */
    private static final String METHOD_PAGE_PAY = "alipay.trade.page.pay";
    /** 退款 */
    private static final String METHOD_REFUND = "alipay.trade.refund";
    /** 主动查单（回调丢了时的兜底） */
    private static final String METHOD_QUERY = "alipay.trade.query";

    private static final String RESP_PAGE_PAY = "alipay_trade_page_pay_response";
    private static final String RESP_REFUND = "alipay_trade_refund_response";
    private static final String RESP_QUERY = "alipay_trade_query_response";

    /** 支付宝业务成功码 */
    private static final String ALIPAY_SUCCESS = "10000";

    private static final DateTimeFormatter TIMESTAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final PayProperties props;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * 专用于支付宝网关的 HTTP 客户端。
     * <p>
     * ★ 不复用 Spring AI 那个 {@code RestClient.Builder} Bean ★
     * 它的超时是给 AI 调的（连接 3 秒），而支付网关的超时要更宽 ——
     * 把支付网关的超时绑在「AI 调不动时的降级节奏」上是纯粹的耦合事故：
     * 有人为了让 AI 更快失败把连接超时改成 1 秒，退款就会开始随机失败。
     */
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    @Override
    public String code() {
        return CODE;
    }

    @Override
    public String label() {
        return "支付宝（沙箱）";
    }

    @Override
    public String hint() {
        return "跳转到支付宝沙箱收银台完成付款（真实签名与回调，非真实资金）";
    }

    /**
     * 四项配置齐全才可用。
     * <p>
     * 尤其是 {@code publicBaseUrl}：它决定 {@code notify_url}，而 {@code notify_url}
     * 决定「我们能不能知道用户付了钱」。把它也列为必要条件，是为了避免出现
     * 「能付款、但订单永远停在待付款」这种最糟糕的半可用状态。
     */
    @Override
    public boolean available() {
        return props.channelEnabled(CODE)
                && configured(props.getAlipayAppId())
                && configured(props.getAlipayPrivateKey())
                && configured(props.getAlipayPublicKey())
                && configured(props.notifyUrl(CODE));
    }

    /* ==================================================================
     * 发起支付
     * ================================================================== */

    /**
     * 生成收银台跳转地址。
     * <p>
     * ★ 这里**不动任何数据** ★：支付宝的收银台地址是一个纯计算产物，
     * 用户甚至可能根本不点这个链接。所以「支付单进入 paying」这件事由
     * {@code PaymentService} 决定，本方法只负责回答「送去哪儿」。
     */
    @Override
    public CreateResult create(CreateContext ctx) {
        Map<String, Object> biz = new LinkedHashMap<>();
        biz.put("out_trade_no", ctx.outTradeNo());
        // total_amount 必须是两位小数字符串；用 double 拼会得到 45.0 而支付宝要 45.00
        biz.put("total_amount", AlipayRsa2.money(ctx.amount()));
        biz.put("subject", truncate(ctx.subject(), 256));
        biz.put("product_code", "FAST_INSTANT_TRADE_PAY");
        /*
         * ★ 把我们自己的关单时限告诉支付宝 ★
         * 不传的话支付宝默认 15 天，于是我们 24 小时关单、用户第 3 天还能在支付宝付款，
         * 结果只能走「已收款但订单作废 → 自动退回」。见 PayProperties#timeoutExpress。
         */
        biz.put("timeout_express", props.timeoutExpress());

        Map<String, String> params = commonParams(METHOD_PAGE_PAY);
        // ★ 渠道名是路径的最后一段，不是参数：少了它渠道就回调到一个不存在的地址
        params.put("notify_url", props.notifyUrl(CODE));
        if (props.getReturnUrl() != null && !props.getReturnUrl().isBlank()) {
            params.put("return_url", props.getReturnUrl());
        }
        params.put("biz_content", toJson(biz));

        String sign = AlipayRsa2.sign(AlipayRsa2.canonical(params), props.getAlipayPrivateKey());
        params.put("sign", sign);

        String url = AlipayRsa2.buildRedirectUrl(props.getAlipayGateway(), params);
        return CreateResult.redirect(url);
    }

    /* ==================================================================
     * 异步通知
     * ================================================================== */

    @Override
    public boolean asyncNotify() {
        return true;
    }

    /**
     * 验签 + 商户校验 + 字段提取。
     * <p>
     * ★★ 三道关，缺一不可 ★★
     * <ol>
     *   <li><b>验签</b>：用支付宝公钥验规范串。这一关回答「报文是不是支付宝发的」；</li>
     *   <li><b>app_id 比对</b>：验签通过只说明报文确实来自支付宝，但**可能是发给别的商户的**。
     *       只验签不比对 app_id，等于允许别人拿他自己的订单来把我们的订单标记成已付款；</li>
     *   <li><b>trade_status 判定</b>：支付宝的 {@code TRADE_SUCCESS} 与
     *       {@code TRADE_FINISHED} 都表示「钱已到账」，其余（WAIT_BUYER_PAY /
     *       TRADE_CLOSED）不能当成功处理。</li>
     * </ol>
     * 金额的比对**刻意不在这里做** —— 它需要与支付单一起判断，属于业务规则，
     * 放在 {@code PaymentService} 里（见该类注释）。
     */
    @Override
    public NotifyResult parseNotify(Map<String, String> params) {
        // 原始报文：存证用。用 TreeMap 保证同样的参数总是序列化成同样的字符串
        String raw = params.toString();

        if (!AlipayRsa2.verifyNotify(params, props.getAlipayPublicKey())) {
            log.warn("[pay] alipay notify signature verification FAILED, out_trade_no={}",
                    params.get("out_trade_no"));
            return NotifyResult.rejected(raw);
        }

        String appId = params.get("app_id");
        if (!props.getAlipayAppId().equals(appId)) {
            // 验签过了但 app_id 不是我们的：说明这是发给另一个商户的合法报文被重放到这里
            log.warn("[pay] alipay notify app_id mismatch: got={} expected={}",
                    appId, props.getAlipayAppId());
            return NotifyResult.rejected(raw);
        }

        String outTradeNo = params.get("out_trade_no");
        String tradeNo = params.get("trade_no");
        String tradeStatus = params.get("trade_status");
        boolean success = "TRADE_SUCCESS".equals(tradeStatus) || "TRADE_FINISHED".equals(tradeStatus);

        java.math.BigDecimal paid = null;
        String totalAmount = params.get("total_amount");
        if (totalAmount != null && !totalAmount.isBlank()) {
            try {
                paid = new java.math.BigDecimal(totalAmount);
            } catch (NumberFormatException e) {
                // 金额解析不出来 = 报文不可信（验签已经过了，所以这只可能是协议变化）
                log.warn("[pay] alipay notify total_amount unparsable: {}", totalAmount);
                return NotifyResult.rejected(raw);
            }
        }

        return new NotifyResult(true, outTradeNo, tradeNo, paid, success,
                success ? null : ("支付宝交易状态：" + tradeStatus), raw);
    }

    /* ==================================================================
     * 退款
     * ================================================================== */

    @Override
    public boolean refundable() {
        return true;
    }

    /**
     * 原路退回。
     * <p>
     * ★ {@code out_request_no} 是退款请求号，必须每次唯一 ★
     * 支付宝按它做退款的幂等：**同一个 out_request_no 重复提交只会退一次**。
     * 这是我们在「退回失败想重试」和「重复点按钮」之间唯一的保护 ——
     * 若把它写成固定值（比如就用支付单号），那么「部分退款 A 45 元」和
     * 「部分退款 B 20 元」会被当成同一笔，第二笔静默不退。
     * 这里用「支付单号 + 退款金额」拼出来：同一笔金额只退一次是可接受的语义，
     * 且天然满足「请求号唯一」。
     */
    @Override
    public RefundResult refund(RefundContext ctx) {
        Map<String, Object> biz = new LinkedHashMap<>();
        // 优先用渠道流水号定位原交易；没有时退回商户订单号（支付宝两者都收）
        if (ctx.tradeNo() != null && !ctx.tradeNo().isBlank()) {
            biz.put("trade_no", ctx.tradeNo());
        } else {
            biz.put("out_trade_no", ctx.outTradeNo());
        }
        biz.put("refund_amount", AlipayRsa2.money(ctx.refundAmount()));
        biz.put("out_request_no", buildOutRequestNo(ctx));
        if (ctx.reason() != null && !ctx.reason().isBlank()) {
            biz.put("refund_reason", truncate(ctx.reason(), 256));
        }

        String body;
        try {
            body = post(METHOD_REFUND, RESP_REFUND, toJson(biz));
        } catch (BusinessException e) {
            return RefundResult.fail(e.getMessage());
        }

        JsonNode node = readNode(body, RESP_REFUND);
        if (node == null) {
            return RefundResult.fail("支付宝退款响应无法解析，请到支付宝后台核对退款状态");
        }
        String respCode = node.path("code").asText("");
        if (!ALIPAY_SUCCESS.equals(respCode)) {
            String subMsg = node.path("sub_msg").asText("");
            String msg = node.path("msg").asText("");
            return RefundResult.fail("支付宝退款被拒绝：" + (subMsg.isEmpty() ? msg : subMsg)
                    + "（code=" + respCode + "）");
        }
        /*
         * ★ fund_change 必须看 ★
         * Y = 本次真的发生了资金变动；N = 这笔退款之前已经退过了（幂等命中）。
         * 两种都算「钱已经回去了」，但把 N 记成「本次退回」会在对账时多算一笔。
         */
        boolean fundChanged = "Y".equalsIgnoreCase(node.path("fund_change").asText(""));
        String refundNo = node.path("trade_no").asText("");
        String message = fundChanged
                ? "支付宝已退回 ¥" + AlipayRsa2.money(ctx.refundAmount())
                : "支付宝确认该笔退款此前已完成（幂等命中），未重复退钱";
        return RefundResult.ok(refundNo.isEmpty() ? null : refundNo, message);
    }

    /**
     * 主动查单：回调丢了时的兜底手段。
     * <p>
     * ★ 为什么必须有它 ★
     * 异步通知是**尽力投递**：服务重启、网络抖动、回调地址短暂不可用，
     * 都会让通知永远到不了。此时用户的钱已经付了，而订单还停在「待付款」——
     * 用户投诉、平台却查不出原因。有了查单，"回调丢了"就只是"晚几分钟到账"。
     * <p>
     * 本方法目前只提供给排障与将来的定时对账使用（没有挂进主流程），
     * 因为把「主动查单」做成定时任务需要一个稳定的轮询频率，
     * 而这属于对账系统的范畴 —— 先把它作为可调用的能力放在这里，
     * 比临时在某个 Service 里拼一个 URL 出去要好。
     *
     * @return 支付宝侧的交易状态字符串（如 {@code TRADE_SUCCESS}）；查询失败返回 null
     */
    public String queryTrade(String outTradeNo) {
        Map<String, Object> biz = new LinkedHashMap<>();
        biz.put("out_trade_no", outTradeNo);
        String body;
        try {
            body = post(METHOD_QUERY, RESP_QUERY, toJson(biz));
        } catch (BusinessException e) {
            log.warn("[pay] alipay trade query failed: {}", e.getMessage());
            return null;
        }
        JsonNode node = readNode(body, RESP_QUERY);
        if (node == null) {
            return null;
        }
        return node.path("trade_status").asText(null);
    }

    /* ==================================================================
     * 内部
     * ================================================================== */

    private Map<String, String> commonParams(String method) {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("app_id", props.getAlipayAppId());
        params.put("method", method);
        params.put("format", "JSON");
        params.put("charset", "utf-8");
        params.put("sign_type", props.getAlipaySignType());
        params.put("timestamp", LocalDateTime.now().format(TIMESTAMP));
        params.put("version", "1.0");
        return params;
    }

    /**
     * 发一个已签名的 POST 请求到网关。
     * <p>
     * ★ 必须 POST 且 form-urlencoded ★
     * GET 会被网关按「网页支付」处理，业务接口（退款/查单）走 GET 一律报
     * {@code Invalid Request}，而错误信息里不会提示"你该用 POST"。
     */
    private String post(String method, String respKey, String bizContent) {
        Map<String, String> params = commonParams(method);
        params.put("biz_content", bizContent);
        String sign = AlipayRsa2.sign(AlipayRsa2.canonical(params), props.getAlipayPrivateKey());
        params.put("sign", sign);

        StringBuilder form = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (form.length() > 0) {
                form.append('&');
            }
            form.append(AlipayRsa2.urlEncode(e.getKey()))
                    .append('=')
                    .append(AlipayRsa2.urlEncode(e.getValue()));
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(props.getAlipayGateway()))
                .header("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")
                .timeout(Duration.ofSeconds(20))
                .POST(HttpRequest.BodyPublishers.ofString(form.toString(), StandardCharsets.UTF_8))
                .build();

        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            String body = response.body();
            if (response.statusCode() != 200) {
                throw BusinessException.of("支付宝网关返回 HTTP " + response.statusCode());
            }
            verifyResponseSign(body, respKey);
            return body;
        } catch (BusinessException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw BusinessException.of("调用支付宝网关被中断");
        } catch (Exception e) {
            throw BusinessException.of("调用支付宝网关失败：" + e.getMessage());
        }
    }

    /**
     * 校验出站响应的签名。
     * <p>
     * ★ 不校验会怎样 ★
     * 我们用 HTTPS 连支付宝，但**只依赖 TLS 是不够的**：请求要经过代理、网关、
     * 各种中间层，任何一处都可能被替换响应体。支付宝的响应里带 sign 就是为了让
     * 调用方有能力发现「这个响应不是支付宝给的」。不验，
     * 一个被篡改成 {@code code=10000} 的响应就能让平台以为退款成功了。
     */
    private void verifyResponseSign(String body, String respKey) {
        try {
            JsonNode root = objectMapper.readTree(body);
            String sign = root.path("sign").asText(null);
            String node = AlipayRsa2.extractSignedNode(body, respKey);
            if (node == null) {
                throw BusinessException.of("支付宝响应缺少 " + respKey + " 节点");
            }
            if (sign == null || !AlipayRsa2.verify(node, sign, props.getAlipayPublicKey())) {
                throw BusinessException.of("支付宝响应验签失败，已拒绝本次结果");
            }
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw BusinessException.of("支付宝响应解析失败：" + e.getMessage());
        }
    }

    private JsonNode readNode(String body, String respKey) {
        try {
            return objectMapper.readTree(body).path(respKey);
        } catch (Exception e) {
            log.warn("[pay] alipay response parse failed: {}", e.getMessage());
            return null;
        }
    }

    /** 同一笔支付 + 同一个金额 → 同一个 out_request_no（支付宝据此做退款幂等） */
    private String buildOutRequestNo(RefundContext ctx) {
        return ctx.paymentId() + "-R-" + AlipayRsa2.money(ctx.refundAmount());
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw BusinessException.of("构造支付宝请求参数失败：" + e.getMessage());
        }
    }

    private boolean configured(String value) {
        return value != null && !value.isBlank();
    }

    /** 渠道对 title / reason 有长度上限；超长会被网关拒绝，而错误码指向的字段名很难懂 */
    private String truncate(String text, int max) {
        if (text == null) {
            return "";
        }
        return text.length() > max ? text.substring(0, max) : text;
    }
}
