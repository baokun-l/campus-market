package com.campus.market.service.pay;

import com.campus.market.config.PayProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 支付宝沙箱渠道的**回调验签**测试。
 * <p>
 * ★★ 为什么单独测这一层，而不是只测 AlipayRsa2 ★★
 * <p>
 * {@code AlipayRsa2Test} 证明的是「签名算法对」，
 * 而这里证明的是「**渠道实现把算法用对了**」—— 用哪把钥匙、比哪个字段、
 * 什么算成功。这三件事弄错任何一件，效果与算法错完全一样：要么真回调被拒，
 * 要么假回调被接受，且线上日志只有一句「验签失败」，无从下手。
 * <p>
 * 尤其 {@code app_id} 比对这一条：它防的是**另一个商户的合法报文被重放到我们这里**。
 * 这种报文验签是过的（确实是支付宝签的），只有 app_id 比对能拦住它。
 * 少了这一条，别人拿自己在别处的订单就能把我们的订单标记成已付款。
 */
class AlipaySandboxNotifyTest {

    private static final String APP_ID = "2021003199999999";

    private PayProperties props;
    private AlipaySandboxPayChannel channel;
    private String alipayPrivateKey;   // 模拟「支付宝手里那把私钥」
    private String alipayPublicKeyPem; // 我们配置的「支付宝公钥」

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair kp = gen.generateKeyPair();
        alipayPrivateKey = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----";
        alipayPublicKeyPem = "-----BEGIN PUBLIC KEY-----\n"
                + Base64.getEncoder().encodeToString(kp.getPublic().getEncoded())
                + "\n-----END PUBLIC KEY-----";

        props = new PayProperties();
        ReflectionTestUtils.setField(props, "enabledChannels", "wallet,demo,alipay_sandbox");
        ReflectionTestUtils.setField(props, "alipayAppId", APP_ID);
        ReflectionTestUtils.setField(props, "alipayPublicKey", alipayPublicKeyPem);
        ReflectionTestUtils.setField(props, "alipayPrivateKey", alipayPrivateKey);
        ReflectionTestUtils.setField(props, "publicBaseUrl", "https://market.example.edu.cn");
        ReflectionTestUtils.setField(props, "notifyPath", "/api/pay/notify");
        // PayProperties 是 new 出来的，@Value 不会生效 —— 网关地址必须自己塞，否则拼 URL 时 NPE
        ReflectionTestUtils.setField(props, "alipayGateway", "https://openapi.alipaydev.com/gateway.do");
        ReflectionTestUtils.setField(props, "alipaySignType", "RSA2");

        channel = new AlipaySandboxPayChannel(props);
    }

    /**
     * 按真实支付宝的**通知签名**规则签名：规范串剔除 sign 与 sign_type（rsaCheckV1 口径）。
     * ★ 与请求签名（canonical，保留 sign_type）口径不同 —— 2026-09-23 真机修复时拆开的。
     */
    private static String signAsAlipay(Map<String, String> params, String privateKeyPem) {
        Map<String, String> content = new LinkedHashMap<>(params);
        content.remove("sign");
        content.remove("sign_type");
        return AlipayRsa2.sign(AlipayRsa2.canonical(content), privateKeyPem);
    }

    /** 构造一条「支付宝发来」的通知：按支付宝通知签名规则签名 */
    private Map<String, String> signedNotify(Map<String, String> fields) {
        Map<String, String> p = new LinkedHashMap<>(fields);
        p.put("app_id", APP_ID);
        p.put("charset", "utf-8");
        p.put("sign_type", "RSA2");
        p.put("sign", signAsAlipay(p, alipayPrivateKey));
        return p;
    }

    private Map<String, String> paidFields() {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("out_trade_no", "pay_202609221200000010");
        f.put("trade_no", "2026092222001234567890");
        f.put("trade_status", "TRADE_SUCCESS");
        f.put("total_amount", "45.00");
        return f;
    }

    /* ============================================================
     * 正向
     * ============================================================ */

    @Test
    @DisplayName("★ 合法回调：验签通过、金额与流水号都取出来、判定为成功")
    void validNotifyAccepted() {
        PayChannel.NotifyResult r = channel.parseNotify(signedNotify(paidFields()));
        assertTrue(r.ok());
        assertTrue(r.success());
        assertEquals("pay_202609221200000010", r.outTradeNo());
        assertEquals("2026092222001234567890", r.tradeNo());
        assertEquals(0, new BigDecimal("45.00").compareTo(r.paidAmount()));
        assertNotNull(r.raw(), "原始报文要存证，事后对账全靠它");
    }

    @Test
    @DisplayName("TRADE_FINISHED 同样算成功（与 TRADE_SUCCESS 都是「钱已到账」）")
    void tradeFinishedIsSuccess() {
        Map<String, String> f = paidFields();
        f.put("trade_status", "TRADE_FINISHED");
        assertTrue(channel.parseNotify(signedNotify(f)).success());
    }

    @Test
    @DisplayName("TRADE_CLOSED：验签过了，但**不算**成功（渠道明确说这笔没成）")
    void tradeClosedIsNotSuccess() {
        Map<String, String> f = paidFields();
        f.put("trade_status", "TRADE_CLOSED");
        PayChannel.NotifyResult r = channel.parseNotify(signedNotify(f));
        assertTrue(r.ok(), "验签是通过的，不能因此把整条报文判成不可信");
        assertFalse(r.success());
        assertTrue(r.failReason() != null && r.failReason().contains("TRADE_CLOSED"));
    }

    /* ============================================================
     * ★★ 反向：这四条是「伪造回调」的四条路，必须全部堵死
     * ============================================================ */

    @Test
    @DisplayName("★★ 没有签名 / 签名是瞎编的 → 拒绝")
    void unsignedNotifyRejected() {
        assertFalse(channel.parseNotify(paidFields()).ok());
    }

    @Test
    @DisplayName("★★ 验签通过但改了金额（签名没重算）→ 拒绝 —— 这是「1 分钱买 iPhone」的那道闸")
    void tamperedAmountRejected() {
        Map<String, String> notify = signedNotify(paidFields());
        notify.put("total_amount", "0.01");
        assertFalse(channel.parseNotify(notify).ok(),
                "改了金额还能验过：攻击者可以把任意订单按 0.01 元付掉");
    }

    @Test
    @DisplayName("★★ app_id 不是我们的 → 拒绝（防「别的商户的合法报文被重放」）")
    void foreignAppIdRejected() {
        Map<String, String> notify = signedNotify(paidFields());
        notify.put("app_id", "2021003188888888");
        // 注意：这条报文的签名是重新算过的 —— 它确实是一份「合法的支付宝报文」，
        // 只是属于另一个商户。只有 app_id 比对能拦住它。
        notify.put("sign", signAsAlipay(notify, alipayPrivateKey));
        assertFalse(channel.parseNotify(notify).ok());
    }

    @Test
    @DisplayName("★★ 换一对密钥签的（不是支付宝那把）→ 拒绝")
    void foreignKeyRejected() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair attacker = gen.generateKeyPair();
        Map<String, String> notify = signedNotify(paidFields());
        notify.put("sign", signAsAlipay(notify,
                "-----BEGIN PRIVATE KEY-----\n"
                        + Base64.getEncoder().encodeToString(attacker.getPrivate().getEncoded())
                        + "\n-----END PRIVATE KEY-----"));
        assertFalse(channel.parseNotify(notify).ok());
    }

    /* ============================================================
     * 渠道属性
     * ============================================================ */

    @Test
    @DisplayName("异步渠道：有回调，且支持原路退回")
    void channelShape() {
        assertTrue(channel.asyncNotify());
        assertTrue(channel.refundable());
        assertEquals("alipay_sandbox", channel.code());
    }

    @Test
    @DisplayName("★ 密钥不全时 available() 必须为 false —— 不能让用户点到一条付不了款的渠道")
    void unavailableWithoutKeys() {
        PayProperties empty = new PayProperties();
        ReflectionTestUtils.setField(empty, "enabledChannels", "alipay_sandbox");
        assertFalse(new AlipaySandboxPayChannel(empty).available(),
                "没配 appid/密钥却显示可用：用户点下去才发现付不了");

        // 只配密钥、没配回调地址同样不可用 —— 那会导致「钱付了、订单永远不推进」
        PayProperties noNotifyUrl = new PayProperties();
        ReflectionTestUtils.setField(noNotifyUrl, "enabledChannels", "alipay_sandbox");
        ReflectionTestUtils.setField(noNotifyUrl, "alipayAppId", APP_ID);
        ReflectionTestUtils.setField(noNotifyUrl, "alipayPrivateKey", alipayPrivateKey);
        ReflectionTestUtils.setField(noNotifyUrl, "alipayPublicKey", alipayPublicKeyPem);
        assertFalse(new AlipaySandboxPayChannel(noNotifyUrl).available(),
                "没配回调地址却可用：用户付了钱，我们永远收不到通知");

        assertTrue(channel.available());
    }

    @Test
    @DisplayName("★ 不在 enabled-channels 里 → 不可用（配置关掉就该真的关掉）")
    void disabledByConfig() {
        ReflectionTestUtils.setField(props, "enabledChannels", "wallet");
        assertFalse(channel.available());
    }

    @Test
    @DisplayName("发起支付返回的是跳转地址，且带签名与回调地址")
    void createReturnsSignedRedirect() {
        PayChannel.CreateResult r = channel.create(new PayChannel.CreateContext(
                "pay_001", "pay_001", "202609221200000010", new BigDecimal("45.00"),
                7L, "二手教材", "127.0.0.1"));
        assertEquals(PayChannel.CreateResult.Kind.REDIRECT, r.kind());
        assertNotNull(r.url());
        assertTrue(r.url().contains("sign="), "跳转地址必须带签名，否则支付宝会拒收");
        assertTrue(r.url().contains("notify_url="));
    }

    /**
     * ★★ notify_url 必须**带渠道名**，且要与控制器映射 {@code /pay/notify/{channel}} 逐字一致 ★★
     * <p>
     * 为什么值得单开一条用例：上一条只断言「URL 里有 notify_url=」，
     * 而缺陷形态恰恰是「有，但少了最后一段渠道名」—— 那种写法**照样通过上一条断言**。
     * 少了这一段，渠道回调的是一个不存在的地址：本项目把
     * {@code NoResourceFoundException} 也兜成 HTTP 200，渠道看到「200 但响应体不是 success」
     * 会持续重推约 15 小时后放弃，而**本地一条日志都没有**（请求根本没进业务代码）。
     * 用户侧就是「钱付了、订单永远停在待付款」。
     * <p>
     * 所以这里断言的是**解码后的完整值**，而且要逐字等于期望地址 ——
     * 用 {@code contains("/alipay_sandbox")} 也不够：前缀拼错同样能蒙过去。
     */
    @Test
    @DisplayName("★★ notify_url 必须以渠道名结尾（渠道名是路径变量，不是参数）")
    void notifyUrlEndsWithChannelCode() {
        PayChannel.CreateResult r = channel.create(new PayChannel.CreateContext(
                "pay_001", "pay_001", "202609221200000010", new BigDecimal("45.00"),
                7L, "二手教材", "127.0.0.1"));
        assertNotNull(r.url());
        String decoded = URLDecoder.decode(
                r.url().substring(r.url().indexOf('?') + 1), StandardCharsets.UTF_8);
        String notifyUrl = null;
        for (String kv : decoded.split("&")) {
            int eq = kv.indexOf('=');
            if (eq > 0 && "notify_url".equals(kv.substring(0, eq))) {
                notifyUrl = kv.substring(eq + 1);
            }
        }
        assertNotNull(notifyUrl, "跳转地址里必须带 notify_url，否则渠道不知道往哪儿回调");
        assertEquals("https://market.example.edu.cn/api/pay/notify/alipay_sandbox", notifyUrl,
                "★ notify_url 少了渠道名这一段 ⇒ 渠道回调到一个不存在的地址，" +
                        "表现为「付了钱、订单永远停在待付款」且本地无任何日志");
    }

    /** public-base-url 为空 → notifyUrl 必须是 null，让渠道据此判定「不可用」而不是传个假地址 */
    @Test
    @DisplayName("未配置 public-base-url → notifyUrl 为 null（失败关闭，绝不传假地址）")
    void notifyUrlNullWithoutBaseUrl() {
        ReflectionTestUtils.setField(props, "publicBaseUrl", "");
        assertNull(props.notifyUrl("alipay_sandbox"));
        assertFalse(channel.available(), "回调地址都没配，渠道必须判定不可用");
    }

    /* ============================================================
     * 注册表
     * ============================================================ */

    @Test
    @DisplayName("★★ 两条渠道用同一个 code → 构造时抛异常（静默覆盖会导致「显示一条、结算另一条」）")
    void duplicateCodeFailsLoudly() {
        PayChannel a = new AlipaySandboxPayChannel(props);
        PayChannel b = new AlipaySandboxPayChannel(props);
        IllegalStateException ex = assertThrows(
                IllegalStateException.class, () -> new PayChannelRegistry(List.of(a, b)));
        assertTrue(ex.getMessage().contains("重复"), "实际：" + ex.getMessage());
    }

    @Test
    @DisplayName("★ 一条渠道都没有 → 抛异常（装配错误不该等用户点付款才发现）")
    void emptyRegistryFails() {
        assertThrows(IllegalStateException.class, () -> new PayChannelRegistry(List.of()));
    }

    @Test
    @DisplayName("★ find() 能找回「现在不可用」的渠道 —— 退款必须能退到已下线的渠道上")
    void findIgnoresAvailability() {
        ReflectionTestUtils.setField(props, "enabledChannels", "wallet");
        assertFalse(channel.available());
        PayChannelRegistry registry = new PayChannelRegistry(List.of(channel));
        assertNotNull(registry.find("alipay_sandbox"),
                "渠道被关掉了就找不到它：历史订单的钱会永远退不回去");
        assertThrows(RuntimeException.class, () -> registry.require("alipay_sandbox"));
    }
}
