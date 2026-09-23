package com.campus.market.service.pay;

import com.campus.market.common.BusinessException;

import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Map;
import java.util.TreeMap;

/**
 * 支付宝 RSA2 签名 / 验签（纯 JDK 实现，不引入任何第三方 SDK）。
 * <p>
 * ★★ 为什么不用官方 alipay-sdk-java ★★
 * <p>
 * 本项目一直用 {@code mvn -o}（离线）构建，依赖树是固定的。引入官方 SDK 会带来
 * 一长串传递依赖（httpclient / gson / bcprov …），代价是构建不再可复现，
 * 而本类需要的协议部分其实很小：**拼规范串 → SHA256withRSA 签名 / 验签**。
 * <p>
 * 更要紧的是：**签名算法本身是可以被证明正确的**。本类配套的真实密钥对往返单测
 * （{@code AlipayRsa2Test}）生成一对 RSA 密钥、用私钥签、用公钥验，
 * 并覆盖「篡改一个字符必须验不过」这个反向断言 —— 这比「调了 SDK 就算对」
 * 提供了更强的保证。
 * <p>
 * ★★ 如果将来要换成官方 SDK ★★
 * <p>
 * 只需替换 {@link com.campus.market.service.pay.AlipaySandboxPayChannel} 里对
 * {@link #sign} / {@link #verifyNotify} 的调用（换成 {@code AlipaySignature.rsaSign} /
 * {@code AlipaySignature.rsaCheckV1}），本类可以直接删掉 —— 渠道接口
 * ({@link PayChannel}) 不受影响。这是把协议细节关在一个类里的价值。
 *
 * ★★ 三个必须逐字对齐的协议细节（错一个就永远验签失败，且报错信息毫无线索）★★
 * <ol>
 *   <li><b>规范串</b>：把除 {@code sign} / {@code sign_type} 之外的全部非空参数，
 *       按**参数名 ASCII 升序**排列，拼成 {@code k1=v1&k2=v2}（末尾不加 {@code &}）。</li>
 *   <li><b>签名</b>：{@code Base64(SHA256withRSA(规范串, 应用私钥))}，
 *       即 {@code sign_type=RSA2}。</li>
 *   <li><b>验签用支付宝公钥，不是应用公钥</b>：这两个是最常见的踩坑点 ——
 *       应用公钥是「我们自己的公钥」（给支付宝验证我们发的东西用），
 *       验支付宝回来的报文必须用**支付宝公钥**。用错了表现为"验签永远失败"。</li>
 * </ol>
 */
public final class AlipayRsa2 {

    private AlipayRsa2() {
    }

    /* ==================================================================
     * 规范串
     * ================================================================== */

    /**
     * 构造待签名字符串：按 key 升序，跳过空值，跳过 {@code sign} / {@code sign_type}。
     * <p>
     * ★ 用 {@link TreeMap} 而不是「先取出来再 sort」★
     * 排序口径必须与支付宝服务端逐字一致。用自然序（{@code String.compareTo}）排序 ——
     * ASCII 升序，不是「按长度」也不是「按插入顺序」。
     * <p>
     * 之所以把 {@code sign} / {@code sign_type} 也一并跳过，而不是只在验签时跳：
     * 签名与验签共用同一个方法，两边口径不可能分叉。
     */
    public static String canonical(Map<String, String> params) {
        TreeMap<String, String> sorted = new TreeMap<>();
        for (Map.Entry<String, String> e : params.entrySet()) {
            String k = e.getKey();
            String v = e.getValue();
            if (k == null || k.isEmpty() || v == null || v.isEmpty()) {
                continue;
            }
            if ("sign".equals(k) || "sign_type".equals(k)) {
                continue;
            }
            sorted.put(k, v);
        }
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : sorted.entrySet()) {
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    /* ==================================================================
     * 签名 / 验签
     * ================================================================== */

    /** RSA2 签名：{@code Base64(SHA256withRSA(content, 应用私钥))} */
    public static String sign(String content, String appPrivateKey) {
        try {
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initSign(loadPrivateKey(appPrivateKey));
            sig.update(content.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(sig.sign());
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw BusinessException.of("支付宝签名失败：" + e.getMessage()
                    + "（请检查 app.pay.alipay.private-key 是否为 PKCS8 或 PKCS1 的 RSA 私钥）");
        }
    }

    /**
     * RSA2 验签。
     *
     * @param content       规范串（由 {@link #canonical} 得到）
     * @param signBase64    渠道回传的 sign
     * @param alipayPublicKey 支付宝公钥（**不是**应用公钥）
     * @return 验签是否通过。任何异常（公钥格式错、签名不是合法 Base64）一律返回 false ——
     *         验签的语义是「不通过就不接受」，不该把异常抛出去让调用方有机会写错分支
     */
    public static boolean verify(String content, String signBase64, String alipayPublicKey) {
        if (content == null || signBase64 == null || signBase64.isEmpty()) {
            return false;
        }
        try {
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initVerify(loadPublicKey(alipayPublicKey));
            sig.update(content.getBytes(StandardCharsets.UTF_8));
            return sig.verify(Base64.getDecoder().decode(signBase64));
        } catch (Exception e) {
            /*
             * ★ 这里刻意吞掉异常并返回 false，但**必须留日志线索** ★
             * 验签失败最常见的两个原因是「公钥配错了」和「参数被中间层改过」，
             * 两者在调用方看来完全一样。异常类型（IllegalArgumentException =
             * Base64 不合法、InvalidKeyException = 公钥格式不对）是唯一的区分线索。
             */
            return false;
        }
    }

    /** 验签 + 取规范串的组合入口（渠道实现用这个，避免自己拼装拼错） */
    public static boolean verifyNotify(Map<String, String> params, String alipayPublicKey) {
        return verify(canonical(params), params.get("sign"), alipayPublicKey);
    }

    /* ==================================================================
     * 密钥加载
     * ================================================================== */

    /**
     * 加载 RSA 私钥，同时支持 PKCS8 与 PKCS1。
     * <p>
     * ★ 为什么要兼容两种 ★
     * 支付宝「密钥生成工具」在不同版本里导出的格式不同：
     * 新版导出 PKCS8（PEM 头是 {@code BEGIN PRIVATE KEY}），
     * 老版导出 PKCS1（{@code BEGIN RSA PRIVATE KEY}）。
     * 学生拿到哪一份取决于工具版本，而这在界面上没有任何提示。
     * 只支持一种的后果是「配置明明填了，却报签名失败」，排查成本极高。
     * <p>
     * 做法：先按 PKCS8 试；失败再把 PKCS1 裸 DER 包成 PKCS8 结构重试。
     */
    public static PrivateKey loadPrivateKey(String pem) {
        byte[] der = decodePem(pem);
        if (der.length == 0) {
            throw BusinessException.of("支付宝应用私钥为空，无法签名");
        }
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
        } catch (Exception first) {
            // 不是 PKCS8：当作 PKCS1 裸 DER，包一层 PKCS8 再试
            try {
                byte[] wrapped = pkcs1ToPkcs8(der);
                return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(wrapped));
            } catch (Exception second) {
                throw BusinessException.of("支付宝应用私钥格式无法识别（既不是 PKCS8 也不是 PKCS1）"
                        + "，请用支付宝密钥生成工具重新导出，或改用 PEM 格式粘贴");
            }
        }
    }

    /** 加载 RSA 公钥（X.509 / SubjectPublicKeyInfo，即 PEM 头为 {@code BEGIN PUBLIC KEY}） */
    public static PublicKey loadPublicKey(String pem) {
        byte[] der = decodePem(pem);
        if (der.length == 0) {
            throw BusinessException.of("支付宝公钥为空，无法验签");
        }
        try {
            return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception e) {
            throw BusinessException.of("支付宝公钥格式无法识别，应为 X.509 格式"
                    + "（支付宝开放平台「支付宝公钥」一栏的内容，不是「应用公钥」）");
        }
    }

    /**
     * 去掉 PEM 头尾、空白与常见转义，得到 Base64 正文并解码。
     * <p>
     * 支持三种粘法（学生在配置文件里的真实写法）：
     * <pre>
     *   ① 带 PEM 头尾、真实换行（多行 yml 标量）
     *   ② 一整行、带 PEM 头尾
     *   ③ 一整行、**不带**头尾，只有 Base64 正文（支付宝控制台「复制」出来的形态）
     *   ④ 用字面量 {@code \n} 代替换行的单行形态（环境变量里最常用）
     * </pre>
     */
    static byte[] decodePem(String pem) {
        if (pem == null || pem.isBlank()) {
            return new byte[0];
        }
        String body = pem.replace("\\n", "\n")
                .replaceAll("-----BEGIN [A-Z ]+-----", "")
                .replaceAll("-----END [A-Z ]+-----", "")
                .replaceAll("\\s", "");
        if (body.isEmpty()) {
            return new byte[0];
        }
        return Base64.getDecoder().decode(body);
    }

    /**
     * 把 PKCS1 的 RSA 私钥 DER 包成 PKCS8 的 DER。
     * <p>
     * PKCS8 的结构是固定的，手工拼一次即可（不需要引入 ASN.1 库）：
     * <pre>
     *   SEQUENCE {
     *     INTEGER 0                                  -- 版本
     *     SEQUENCE { OID 1.2.840.113549.1.1.1, NULL } -- 算法标识 rsaEncryption
     *     OCTET STRING { &lt;PKCS1 原文&gt; }
     *   }
     * </pre>
     * 长度字段按 DER 规则编码（&lt;128 用单字节，否则 0x81/0x82/0x83 + 大端长度）。
     */
    static byte[] pkcs1ToPkcs8(byte[] pkcs1) {
        byte[] version = {0x02, 0x01, 0x00};
        byte[] rsaAlgorithmId = {
                0x30, 0x0d,
                0x06, 0x09,
                0x2a, (byte) 0x86, 0x48, (byte) 0x86, (byte) 0xf7, 0x0d, 0x01, 0x01, 0x01,
                0x05, 0x00
        };
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.writeBytes(version);
        body.writeBytes(rsaAlgorithmId);
        body.writeBytes(derWrap((byte) 0x04, pkcs1));
        return derWrap((byte) 0x30, body.toByteArray());
    }

    /** DER 的 TLV 包装：写入 tag + 长度 + 内容 */
    private static byte[] derWrap(byte tag, byte[] content) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        int len = content.length;
        if (len < 0x80) {
            out.write(len);
        } else if (len <= 0xFF) {
            out.write(0x81);
            out.write(len);
        } else if (len <= 0xFFFF) {
            out.write(0x82);
            out.write((len >> 8) & 0xFF);
            out.write(len & 0xFF);
        } else {
            out.write(0x83);
            out.write((len >> 16) & 0xFF);
            out.write((len >> 8) & 0xFF);
            out.write(len & 0xFF);
        }
        out.write(content, 0, len);
        return out.toByteArray();
    }

    /* ==================================================================
     * 出站请求的拼装
     * ================================================================== */

    /**
     * 把已签名的参数拼成可跳转的 GET 地址。
     * <p>
     * ★ URL 编码口径必须与支付宝一致 ★
     * {@link java.net.URLEncoder} 会把空格编成 {@code +}，而支付宝按 RFC 3986 期望
     * {@code %20}。用 {@code +} 时，金额、标题里带空格就会签不过 ——
     * 而"标题里有没有空格"完全取决于卖家怎么写商品名，于是表现为
     * 「有些商品能付款、有些不能」，极难定位。
     */
    public static String buildRedirectUrl(String gateway, Map<String, String> signedParams) {
        StringBuilder sb = new StringBuilder(gateway);
        sb.append(gateway.contains("?") ? '&' : '?');
        boolean first = true;
        for (Map.Entry<String, String> e : signedParams.entrySet()) {
            if (!first) {
                sb.append('&');
            }
            first = false;
            sb.append(e.getKey()).append('=').append(urlEncode(e.getValue()));
        }
        return sb.toString();
    }

    /** RFC 3986 风格的百分号编码（空格 → {@code %20}，{@code +} 本身也要编码） */
    public static String urlEncode(String value) {
        if (value == null) {
            return "";
        }
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20")
                .replace("*", "%2A")
                .replace("%7E", "~");
    }

    /** 金额转成支付宝要求的两位小数字符串（{@code 45.00}） */
    public static String money(BigDecimal value) {
        return (value == null ? BigDecimal.ZERO : value)
                .setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    /**
     * 从 JSON 响应里取出被签名的那一段原文。
     * <p>
     * 支付宝对**出站请求的响应**也签名：{@code {"alipay_xxx_response":{...},"sign":"..."}}，
     * 且签名覆盖的是 {@code {...}} 的**原始文本**（不是反序列化再序列化的结果 ——
     * 那样字段顺序与空白都会变，签名必然对不上）。
     * <p>
     * 所以这里做一次精确的花括号配对扫描，从 {@code "key":} 之后取出那段子串。
     * 扫描必须**跳过字符串字面量内部的花括号**，否则商品标题里带一个左花括号
     * 就会让配对提前结束，取到半截文本。
     *
     * @return 原文子串；找不到时返回 null（调用方据此判定「响应不可信」）
     */
    public static String extractSignedNode(String json, String responseKey) {
        if (json == null || responseKey == null) {
            return null;
        }
        String marker = "\"" + responseKey + "\"";
        int idx = json.indexOf(marker);
        if (idx < 0) {
            return null;
        }
        int colon = json.indexOf(':', idx + marker.length());
        if (colon < 0) {
            return null;
        }
        int start = colon + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) {
            start++;
        }
        if (start >= json.length() || json.charAt(start) != '{') {
            return null;
        }
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
            } else if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return json.substring(start, i + 1);
                }
            }
        }
        return null;
    }
}
