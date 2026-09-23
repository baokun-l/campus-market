package com.campus.market.service.pay;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 支付宝 RSA2 协议实现测试 —— **用真实生成的 RSA 密钥对**跑通签名与验签。
 * <p>
 * ★★ 为什么这个类值得存在 ★★
 * <p>
 * 签名是支付链路里唯一「错了也不会报错」的环节：拼错一个字符、编码差一个百分号，
 * 表现都是「回调验签失败」—— 而我们远端看不到支付宝那边的日志，
 * 只能靠盲猜。所以这里不 mock 任何东西，真的生成一对 2048 位 RSA 密钥，
 * 走完整的「拼规范串 → 签 → 验」流程。
 * <p>
 * ★ 反向断言比正向断言更重要 ★
 * 「签得出来、验得过」只能证明 happy path；真正要防的是
 * **篡改过的报文被当成真的**。所以每个正向用例都配一条「改一个字符必须验不过」。
 * 只写正向断言的验签测试等于没写 —— 一个恒返回 true 的实现也能全绿。
 */
class AlipayRsa2Test {

    private static KeyPair keyPair;
    private static KeyPair otherKeyPair;
    private static String privateKeyPkcs8;
    private static String publicKeyPem;

    @BeforeAll
    static void generateKeys() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();
        otherKeyPair = gen.generateKeyPair();

        privateKeyPkcs8 = "-----BEGIN PRIVATE KEY-----\n"
                + base64(keyPair.getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----";
        publicKeyPem = "-----BEGIN PUBLIC KEY-----\n"
                + base64(keyPair.getPublic().getEncoded())
                + "\n-----END PUBLIC KEY-----";
    }

    private static String base64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    /* ============================================================
     * 规范串
     * ============================================================ */

    @Nested
    @DisplayName("规范串：排序与跳过规则必须与支付宝逐字一致")
    class Canonical {

        @Test
        @DisplayName("按参数名 ASCII 升序排列，末尾不加 &")
        void sortedAndJoined() {
            Map<String, String> p = new LinkedHashMap<>();
            p.put("charset", "utf-8");
            p.put("app_id", "2021001");
            p.put("method", "alipay.trade.page.pay");
            assertEquals("app_id=2021001&charset=utf-8&method=alipay.trade.page.pay",
                    AlipayRsa2.canonical(p));
        }

        @Test
        @DisplayName("★★ 跳过 sign；sign_type 参与签名 —— 2026-09-23 沙箱真机实测口径")
        void skipsSignButKeepsSignType() {
            Map<String, String> p = new LinkedHashMap<>();
            p.put("a", "1");
            p.put("sign", "xxx");
            p.put("sign_type", "RSA2");
            p.put("b", "2");
            // 真机证据：剔除 sign_type ⇒ 网关 isv.invalid-signature（其回显串含 sign_type=RSA2）；
            // 保留 ⇒ 通过。旧版断言「sign_type 不参与」是把请求签名与通知验签的口径搞混了。
            assertEquals("a=1&b=2&sign_type=RSA2", AlipayRsa2.canonical(p));
        }

        @Test
        @DisplayName("★ 跳过空值 —— 空串参与拼串会让服务端算出的串比我们长一个 =")
        void skipsEmptyValues() {
            Map<String, String> p = new LinkedHashMap<>();
            p.put("a", "1");
            p.put("b", "");
            p.put("c", null);
            p.put("d", "4");
            assertEquals("a=1&d=4", AlipayRsa2.canonical(p));
        }
    }

    /* ============================================================
     * 签名 / 验签（真实密钥）
     * ============================================================ */

    @Nested
    @DisplayName("签名 / 验签：真实密钥往返")
    class SignAndVerify {

        @Test
        @DisplayName("★ 私钥签名 → 公钥验签通过（正向）")
        void roundTrip() {
            String content = "app_id=2021001&out_trade_no=pay_001&total_amount=45.00";
            String sign = AlipayRsa2.sign(content, privateKeyPkcs8);
            assertNotNull(sign);
            assertTrue(AlipayRsa2.verify(content, sign, publicKeyPem));
        }

        @Test
        @DisplayName("★★ 篡改内容一个字符 → 必须验不过（恒返回 true 的实现会在这里变红）")
        void tamperedContentFails() {
            String content = "app_id=2021001&out_trade_no=pay_001&total_amount=45.00";
            String sign = AlipayRsa2.sign(content, privateKeyPkcs8);
            assertFalse(AlipayRsa2.verify(content + "0", sign, publicKeyPem),
                    "篡改后的报文验签通过了 —— 任何人都能伪造支付成功回调");
        }

        @Test
        @DisplayName("★★ 金额被改小 → 必须验不过（这是「1 分钱买 iPhone」的那道闸）")
        void tamperedAmountFails() {
            String content = "out_trade_no=pay_001&total_amount=45.00";
            String sign = AlipayRsa2.sign(content, privateKeyPkcs8);
            assertFalse(AlipayRsa2.verify("out_trade_no=pay_001&total_amount=0.01", sign, publicKeyPem));
        }

        @Test
        @DisplayName("★★ 换一对密钥（不是签发方的公钥）→ 必须验不过")
        void wrongPublicKeyFails() {
            String content = "out_trade_no=pay_001&total_amount=45.00";
            String sign = AlipayRsa2.sign(content, privateKeyPkcs8);
            String otherPub = "-----BEGIN PUBLIC KEY-----\n"
                    + base64(otherKeyPair.getPublic().getEncoded())
                    + "\n-----END PUBLIC KEY-----";
            assertFalse(AlipayRsa2.verify(content, sign, otherPub));
        }

        @Test
        @DisplayName("签名缺失 / 为空 → false，而不是抛异常")
        void missingSignIsFalse() {
            assertFalse(AlipayRsa2.verify("a=1", null, publicKeyPem));
            assertFalse(AlipayRsa2.verify("a=1", "", publicKeyPem));
            assertFalse(AlipayRsa2.verify(null, "xxxx", publicKeyPem));
        }

        @Test
        @DisplayName("★★ 公钥配成了「应用公钥」这种格式错误 → 返回 false 而不是抛异常给调用方")
        void brokenPublicKeyReturnsFalse() {
            String content = "a=1";
            String sign = AlipayRsa2.sign(content, privateKeyPkcs8);
            // 私钥的 PEM 拿来当公钥用：最常见的「两把钥匙拿反了」
            assertFalse(AlipayRsa2.verify(content, sign, privateKeyPkcs8));
        }
    }

    /* ============================================================
     * 私钥格式（PKCS8 / PKCS1）
     * ============================================================ */

    @Nested
    @DisplayName("私钥格式：PKCS8 与 PKCS1 都要能加载")
    class KeyFormats {

        @Test
        @DisplayName("★ PKCS1（BEGIN RSA PRIVATE KEY）能被加载，且与 PKCS8 等价")
        void pkcs1LoadsAndEqualsPkcs8() {
            byte[] pkcs1 = pkcs1FromPkcs8(keyPair.getPrivate().getEncoded());
            String pkcs1Pem = "-----BEGIN RSA PRIVATE KEY-----\n"
                    + base64(pkcs1) + "\n-----END RSA PRIVATE KEY-----";

            PrivateKey fromPkcs1 = AlipayRsa2.loadPrivateKey(pkcs1Pem);
            assertTrue(Arrays.equals(keyPair.getPrivate().getEncoded(), fromPkcs1.getEncoded()),
                    "PKCS1 转换后得到的不是同一把私钥 —— 手工拼的 PKCS8 结构有错");
        }

        @Test
        @DisplayName("★ 用 PKCS1 私钥签出来的签名，公钥能验过")
        void pkcs1CanSign() {
            byte[] pkcs1 = pkcs1FromPkcs8(keyPair.getPrivate().getEncoded());
            String pkcs1Pem = "-----BEGIN RSA PRIVATE KEY-----\n" + base64(pkcs1)
                    + "\n-----END RSA PRIVATE KEY-----";
            String content = "out_trade_no=pay_002&total_amount=12.30";
            assertTrue(AlipayRsa2.verify(content, AlipayRsa2.sign(content, pkcs1Pem), publicKeyPem));
        }

        @Test
        @DisplayName("乱码私钥 → 抛业务异常（带可操作的提示），而不是 NullPointerException")
        void garbageKeyThrowsBusinessException() {
            RuntimeException ex = assertThrows(RuntimeException.class,
                    () -> AlipayRsa2.sign("a=1", "not-a-key"));
            assertTrue(ex.getMessage().contains("私钥"), "实际：" + ex.getMessage());
        }

        @Test
        @DisplayName("★ 单行、不带 PEM 头尾、用字面量 \\n 代替换行 —— 三种粘法都能解析")
        void pemVariants() {
            byte[] expected = keyPair.getPrivate().getEncoded();
            String body = base64(expected);

            // ① 只有 Base64 正文（支付宝控制台「复制」出来的形态）
            assertTrue(Arrays.equals(expected, AlipayRsa2.decodePem(body)));
            // ② 带头尾但挤在一行
            assertTrue(Arrays.equals(expected,
                    AlipayRsa2.decodePem("-----BEGIN PRIVATE KEY-----" + body + "-----END PRIVATE KEY-----")));
            // ③ 环境变量里最常见的字面量 \n
            assertTrue(Arrays.equals(expected, AlipayRsa2.decodePem(
                    "-----BEGIN PRIVATE KEY-----\\n" + body + "\\n-----END PRIVATE KEY-----")));
            // ④ 真实换行 + 缩进（多行 yml 标量）
            assertTrue(Arrays.equals(expected, AlipayRsa2.decodePem(
                    "-----BEGIN PRIVATE KEY-----\n  " + body + "\n-----END PRIVATE KEY-----\n")));
        }

        /** 从 PKCS8 DER 里剥出 PKCS1 原文（私钥的 PKCS8 结构固定，见 AlipayRsa2#pkcs1ToPkcs8） */
        private byte[] pkcs1FromPkcs8(byte[] pkcs8) {
            byte[] alg = {0x30, 0x0d, 0x06, 0x09, 0x2a, (byte) 0x86, 0x48, (byte) 0x86,
                    (byte) 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00};
            int i = indexOf(pkcs8, alg);
            assertTrue(i >= 0, "PKCS8 里找不到 rsaEncryption 算法标识");
            int p = i + alg.length;
            assertEquals((byte) 0x04, pkcs8[p], "算法标识之后应当是 OCTET STRING");
            p++;
            int b = pkcs8[p++] & 0xFF;
            int len;
            if (b < 0x80) {
                len = b;
            } else if (b == 0x81) {
                len = pkcs8[p++] & 0xFF;
            } else {
                len = ((pkcs8[p++] & 0xFF) << 8) | (pkcs8[p++] & 0xFF);
            }
            return Arrays.copyOfRange(pkcs8, p, p + len);
        }

        private int indexOf(byte[] haystack, byte[] needle) {
            outer:
            for (int i = 0; i + needle.length <= haystack.length; i++) {
                for (int j = 0; j < needle.length; j++) {
                    if (haystack[i + j] != needle[j]) {
                        continue outer;
                    }
                }
                return i;
            }
            return -1;
        }
    }

    /* ============================================================
     * 拼装细节
     * ============================================================ */

    @Nested
    @DisplayName("URL 编码 / 金额 / 响应解析")
    class Encoding {

        @Test
        @DisplayName("★ 空格必须编成 %20，不是 +（URLEncoder 的默认行为会让带空格的标题签不过）")
        void spaceIsPercent20() {
            assertEquals("a%20b", AlipayRsa2.urlEncode("a b"));
            assertFalse(AlipayRsa2.urlEncode("二手 教材").contains("+"));
        }

        @Test
        @DisplayName("★ * 编成 %2A、~ 还原（支付宝的编码口径与 URLEncoder 不同）")
        void starAndTilde() {
            assertEquals("%2A", AlipayRsa2.urlEncode("*"));
            assertEquals("~", AlipayRsa2.urlEncode("~"));
        }

        @Test
        @DisplayName("金额一律两位小数：45 → 45.00（支付宝拒收 45.0）")
        void moneyIsTwoDecimals() {
            assertEquals("45.00", AlipayRsa2.money(new BigDecimal("45")));
            assertEquals("45.00", AlipayRsa2.money(new BigDecimal("45.0")));
            assertEquals("45.60", AlipayRsa2.money(new BigDecimal("45.6")));
            assertEquals("0.00", AlipayRsa2.money(null));
            // 用 toPlainString 而不是 toString：toString 在大数上会输出科学计数法
            assertEquals("100000000.00", AlipayRsa2.money(new BigDecimal("1E+8")));
        }

        @Test
        @DisplayName("★ 商品标题里带 { 时，被签名节点的提取不能提前截断")
        void extractSurvivesBraceInTitle() {
            String json = "{\"alipay_trade_page_pay_response\":{\"code\":\"10000\","
                    + "\"subject\":\"教材 { 全新 } 打包\",\"out_trade_no\":\"pay_1\"}"
                    + ",\"sign\":\"abc\"}";
            String node = AlipayRsa2.extractSignedNode(json, "alipay_trade_page_pay_response");
            assertNotNull(node);
            assertTrue(node.endsWith("}"), "节点被截断了：" + node);
            assertTrue(node.contains("{ 全新 }"), "字符串字面量里的花括号被当成结构了：" + node);
        }

        @Test
        @DisplayName("响应里没有目标节点 → 返回 null（调用方据此判定不可信）")
        void extractMissingNode() {
            assertNull(AlipayRsa2.extractSignedNode("{\"other\":1}", "alipay_trade_refund_response"));
            assertNull(AlipayRsa2.extractSignedNode(null, "x"));
        }

        @Test
        @DisplayName("跳转地址里带上签名，且签名值本身也要被编码（Base64 里有 +/=）")
        void redirectUrlCarriesSign() {
            Map<String, String> p = new LinkedHashMap<>();
            p.put("app_id", "2021001");
            p.put("sign", "a+b/c=");
            String url = AlipayRsa2.buildRedirectUrl("https://openapi.alipaydev.com/gateway.do", p);
            assertTrue(url.startsWith("https://openapi.alipaydev.com/gateway.do?"));
            assertTrue(url.contains("sign=a%2Bb%2Fc%3D"), "实际：" + url);
        }
    }

    /** 保证「公钥能用」这件事本身也被覆盖：直接加载一次不抛异常 */
    @Test
    @DisplayName("公钥加载：X.509 格式")
    void publicKeyLoads() {
        PublicKey pub = AlipayRsa2.loadPublicKey(publicKeyPem);
        assertTrue(Arrays.equals(keyPair.getPublic().getEncoded(), pub.getEncoded()));
    }

    /** 顺带钉住 UTF-8 编码：中文标题签名与验签必须用同一套字节 */
    @Test
    @DisplayName("★ 中文内容签名往返（UTF-8 字节口径一致）")
    void chineseContentRoundTrip() {
        String content = "subject=" + new String("二手教材".getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8)
                + "&total_amount=45.00";
        String sign = AlipayRsa2.sign(content, privateKeyPkcs8);
        assertTrue(AlipayRsa2.verify(content, sign, publicKeyPem));
    }
}
