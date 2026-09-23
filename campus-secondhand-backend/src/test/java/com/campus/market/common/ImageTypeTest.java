package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 图片魔数嗅探测试。
 * <p>
 * ★ 本类只管「一段字节是什么格式」这一件事 ★
 * <p>
 * 它是上传链路上唯一**纯函数**的一环：同样的字节永远得到同样的结论，
 * 不依赖磁盘、不依赖时钟、不依赖配置。所以这里把「边界」压得比别处狠：
 * 短于签名的输入、只有前缀相同但后段不同的输入、容器格式的两段签名 ——
 * 这些正是「看一眼觉得对、细看会漏」的地方。
 * <p>
 * ★ 刻意留的几条「必须报 null」★
 * <p>
 * {@link #riffButNotWebpIsRejected()} 与 {@link #webpTagOffByOneIsRejected()}
 * 证明 WEBP 判定**不是**只看前 4 字节 {@code RIFF}：
 * 若实现偷懒只判前缀，wav/avi 会被当成图片存下来 —— 而其他用例全都照样绿。
 */
class ImageTypeTest {

    // ==================== 识别 ====================

    @Test
    @DisplayName("五种受支持格式都能按签名识别出正确的扩展名")
    void recognizesSupportedFormats() {
        assertType(ImageType.JPEG, "jpg", "FFD8FFE000104A4649460001");
        assertType(ImageType.PNG, "png", "89504E470D0A1A0A0000000D49484452");
        assertType(ImageType.GIF, "gif", "47494638396101000100");
        assertType(ImageType.WEBP, "webp", "52494646" + "24000000" + "57454250");
        assertType(ImageType.BMP, "bmp", "424D3600000000000000");
    }

    @Test
    @DisplayName("GIF 的两个版本（87a / 89a）都认")
    void acceptsBothGifVersions() {
        assertType(ImageType.GIF, "gif", "47494638376101000100");
        assertType(ImageType.GIF, "gif", "47494638396101000100");
    }

    // ==================== 拒收 ====================

    @Test
    @DisplayName("RIFF 容器但不是 WEBP（wav/avi）必须拒 —— WEBP 不是只看前 4 字节")
    void riffButNotWebpIsRejected() {
        // WAVE：RIFF????WAVE
        assertNull(ImageType.sniff(hex("52494646" + "24000000" + "57415645")),
                "wav 也是 RIFF 容器，只看前缀就会把它当图片存下来");
        // AVI ：RIFF????AVI
        assertNull(ImageType.sniff(hex("52494646" + "24000000" + "41564920")));
    }

    @Test
    @DisplayName("WEBP 标记差一个字节也要拒 —— 偏移写错时必须有用例报红")
    void webpTagOffByOneIsRejected() {
        // 标记落在偏移 5（正常在偏移 8）：RIFF + 1 字节 + "WEBP" + 1 字节
        assertNull(ImageType.sniff(hex("52494646" + "24" + "57454250" + "00")),
                "偏移量差一字节仍是 RIFF 容器，但已不是 WEBP 布局，必须拒");
        // 标记落在偏移 9：RIFF + 4 字节 + 1 字节 + "WEBP"
        assertNull(ImageType.sniff(hex("52494646" + "24000000" + "00" + "57454250")));
        // 标记写成了 WEBQ
        assertNull(ImageType.sniff(hex("52494646" + "24000000" + "57454251")));
    }

    @Test
    @DisplayName("文本 / HTML / 脚本一律识别不出")
    void rejectsNonImageContent() {
        assertNull(ImageType.sniff("<!DOCTYPE html><html>".getBytes()));
        assertNull(ImageType.sniff("<script>alert(1)</script>".getBytes()));
        assertNull(ImageType.sniff("<?php system($_GET[0]); ?>".getBytes()));
        assertNull(ImageType.sniff("PK\u0003\u0004".getBytes()), "zip 头不该被当图片");
        assertNull(ImageType.sniff("hello world, this is plain text".getBytes()));
    }

    // ==================== 边界 ====================

    @Test
    @DisplayName("空 / null / 单字节返回 null，不抛异常")
    void handlesNullOrTooShort() {
        assertNull(ImageType.sniff(null));
        assertNull(ImageType.sniff(new byte[0]));
        assertNull(ImageType.sniff(new byte[]{0x00}));
        assertNull(ImageType.sniff(new byte[]{(byte) 0xFF}));
    }

    @Test
    @DisplayName("只有签名那么长的字节也能判（短输入不越界、不误判）")
    void handlesExactlyMagicLength() {
        assertType(ImageType.JPEG, "jpg", "FFD8FF");          // 恰好 3 字节
        assertType(ImageType.BMP, "bmp", "424D");             // 恰好 2 字节
        assertType(ImageType.GIF, "gif", "47494638");         // 恰好 4 字节
        assertNull(ImageType.sniff(hex("52494646")), "只有 RIFF 四个字节时，WEBP 的第二段是缺失的 ⇒ 必须拒");
        assertNull(ImageType.sniff(hex("89504E470D0A1A")), "PNG 签名少一个字节（6/8）⇒ 必须拒");
    }

    @Test
    @DisplayName("WEBP 判定所需的头长度常量不许被改小 —— 改小就等于放开 wav/avi")
    void headLengthMustCoverWebpTag() {
        assertTrue(ImageType.HEAD_LENGTH >= 12,
                "WEBP 的 RIFF 前缀(4) + 长度(4) + WEBP 标记(4) = 12 字节；"
                        + "HEAD_LENGTH 小于 12 时，调用方读不到第二段标记，wav/avi 会被放行");
    }

    @Test
    @DisplayName("落盘的扩展名集合是封闭的 5 个值，且不含 jpeg（统一落 .jpg）")
    void extensionsAreClosedAndCanonical() {
        Set<String> exts = Arrays.stream(ImageType.values())
                .map(ImageType::ext)
                .collect(Collectors.toSet());
        assertEquals(Set.of("jpg", "png", "gif", "webp", "bmp"), exts);
        assertTrue(!exts.contains("jpeg"),
                "统一用 .jpg：同一格式两种后缀会让「后缀 = 真实格式」这个不变量出现两个写法");
    }

    // ==================== 辅助 ====================

    private static void assertType(ImageType expected, String expectedExt, String hexHead) {
        ImageType actual = ImageType.sniff(hex(hexHead));
        assertEquals(expected, actual, "字节 " + hexHead + " 应识别为 " + expected);
        assertEquals(expectedExt, actual.ext(), "扩展名必须与类型对应");
    }

    /** 十六进制串 → 字节数组（便于把签名原样写进用例，避免手算十进制） */
    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
