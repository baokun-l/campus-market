package com.campus.market.common;

/**
 * 图片类型嗅探（magic number / 文件签名）。
 * <p>
 * ★ 为什么不能只看扩展名 ★
 * <p>
 * 上传接口原有三条校验：非空、字节数上限、扩展名白名单（{@code UploadController.ALLOWED_EXT}）。
 * 三条里**没有一条看过文件内容**。于是 {@code evil.png} 里装一段 HTML / 一段脚本 / 一个
 * 压缩炸弹，都能原样落到 {@code /uploads/} 下并拿到一个可公开访问的 URL。
 * 扩展名是**客户端给的字符串**，它和「这个文件真的是图片吗」之间没有任何强制关系。
 * <p>
 * 本类把判断依据换成**文件头字节**：这是攻击者要绕过就必须先满足的条件 ——
 * 他得先交出一段真的以 JPEG/PNG/... 开头的字节流，那它就不是「随便一段内容」了。
 * <p>
 * ★ 为什么是 12 字节而不是更少 ★
 * <p>
 * JPEG(3) / PNG(8) / GIF(4) / BMP(2) 都只要前几个字节，但 **WEBP 是一个 RIFF 容器**：
 * 前 4 字节是 {@code RIFF}、第 4~8 字节是长度、**{@code WEBP} 标记在第 8~12 字节**。
 * 只看前 8 字节无法把 WEBP 与其它 RIFF 文件（wav/avi）分开，所以统一读 12 字节。
 * <p>
 * ★ 判定口径：嗅探结果同时用于「拒收」与「定扩展名」 ★
 * <p>
 * **字节说了算，文件名只作参考**：
 * <ul>
 *   <li>嗅不出类型 ⇒ 直接拒收（不是图片）；</li>
 *   <li>嗅得出类型 ⇒ **存盘用的扩展名取嗅探结果**，不取客户端给的那个。</li>
 * </ul>
 * 第二条是刻意的：浏览器/截图工具/微信另存经常产出「内容与后缀不一致」的文件
 * （典型是 JPEG 字节存成 {@code .png}）。按字节定扩展名既避免了这类**误拒**，
 * 也让「存下来的文件后缀 = 它真实的格式」这个不变量成立 ——
 * 后面 Nginx/浏览器按扩展名给 Content-Type 时才不会给错。
 */
public enum ImageType {

    /** 联合图像专家组：{@code FF D8 FF}（SOI + 首个标记） */
    JPEG("jpg", new int[]{0xFF, 0xD8, 0xFF}),

    /** 便携式网络图形：{@code 89 50 4E 47 0D 0A 1A 0A}（含高位字节，防被当文本传输时损坏） */
    PNG("png", new int[]{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}),

    /** GIF：{@code 47 49 46 38}（"GIF8"），同时覆盖 87a 与 89a 两个版本 */
    GIF("gif", new int[]{0x47, 0x49, 0x46, 0x38}),

    /**
     * WEBP：{@code RIFF????WEBP} 两段签名 —— 前缀在这里，{@code WEBP} 标记由
     * {@link #sniff(byte[])} 在第 8 字节处另行比对（枚举只能存一段前缀）。
     */
    WEBP("webp", new int[]{0x52, 0x49, 0x46, 0x46}),

    /**
     * BMP：{@code 42 4D}（"BM"）。
     * <p>
     * ★ 放在最后一个 ★：它是本枚举里**唯一只有 2 字节**的签名，误命中概率最高
     * （任何以 "BM" 开头的二进制都会撞上）。枚举按声明顺序匹配，把它排在最后，
     * 保证了更长、更可靠的签名优先命中。
     */
    BMP("bmp", new int[]{0x42, 0x4D});

    /** 判定一个字节流是否为 WEBP 所需的最短长度（{@code RIFF} + 4 长度 + {@code WEBP}） */
    public static final int HEAD_LENGTH = 12;

    /** WEBP 的第二段标记，位于偏移 8（{@code 'W','E','B','P'}） */
    private static final int[] WEBP_TAG = {0x57, 0x45, 0x42, 0x50};

    /** 该类型落盘时使用的扩展名（小写、不带点） */
    private final String ext;

    /** 期望匹配的前缀字节 */
    private final int[] magic;

    ImageType(String ext, int[] magic) {
        this.ext = ext;
        this.magic = magic;
    }

    public String ext() {
        return ext;
    }

    /**
     * 嗅探文件头。
     *
     * @param head 文件开头的字节（建议至少 {@link #HEAD_LENGTH} 个；
     *             短于某类型的签名长度时该类型不会被匹配，**不会越界抛异常**）
     * @return 识别出的类型；识别不出返回 {@code null}（**调用方必须把 null 当拒收处理**）
     */
    public static ImageType sniff(byte[] head) {
        if (head == null || head.length < 2) {
            return null;
        }
        for (ImageType t : values()) {
            if (t == WEBP) {
                continue;   // 两段签名，交给下面单独判
            }
            if (matchesAt(head, t.magic, 0)) {
                return t;
            }
        }
        if (matchesAt(head, WEBP.magic, 0) && matchesAt(head, WEBP_TAG, 8)) {
            return WEBP;
        }
        return null;
    }

    /** 从 {@code offset} 起逐字节比对；越界返回 false（而不是抛异常） */
    private static boolean matchesAt(byte[] head, int[] magic, int offset) {
        if (head.length < offset + magic.length) {
            return false;
        }
        for (int i = 0; i < magic.length; i++) {
            if ((head[offset + i] & 0xFF) != magic[i]) {
                return false;
            }
        }
        return true;
    }
}
