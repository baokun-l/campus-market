package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 密码哈希工具测试。
 * <p>
 * 双模式（哈希优先 / 明文兼容）是这个类唯一的复杂点，也是最容易改坏的地方：
 * 一旦有人把明文分支删掉，**已建好的老库全体登不进去**，而演示当天才发现。
 */
class PasswordsTest {

    /** 只算一次，BCrypt 强度 10 单次约几十毫秒，别在断言里反复 encode */
    private static final String HASH_OF_123456 = Passwords.encode("123456");

    @Test
    @DisplayName("哈希不是明文，且同口令两次哈希结果不同（盐随机）")
    void shouldNotStorePlaintext() {
        assertFalse(HASH_OF_123456.contains("123456"));
        assertFalse(HASH_OF_123456.equals(Passwords.encode("123456")));
    }

    @Test
    @DisplayName("哈希形态可被识别，$2a$10$ 前缀 + 60 位定长")
    void shouldRecognizeHash() {
        assertTrue(Passwords.isHashed(HASH_OF_123456));
        assertEquals(60, HASH_OF_123456.length());
        assertTrue(HASH_OF_123456.startsWith("$2a$10$"));
    }

    @Test
    @DisplayName("明文形态不会被误判成哈希")
    void shouldNotMistakePlaintextForHash() {
        assertFalse(Passwords.isHashed("123456"));
        assertFalse(Passwords.isHashed("admin123"));
        assertFalse(Passwords.isHashed(""));
        assertFalse(Passwords.isHashed(null));
        // 长度接近但结构不对的，也不能当成哈希（否则会走 BCrypt 校验而永远失败）
        assertFalse(Passwords.isHashed("$2a$10$" + "x".repeat(20)));
    }

    @Test
    @DisplayName("哈希模式：对口令通过，错口令拒绝")
    void shouldVerifyAgainstHash() {
        assertTrue(Passwords.matches("123456", HASH_OF_123456));
        assertFalse(Passwords.matches("123457", HASH_OF_123456));
        assertFalse(Passwords.matches("", HASH_OF_123456));
    }

    @Test
    @DisplayName("明文兼容模式：老库里的明文仍能登录（否则已建库全部登不进）")
    void shouldStillSupportLegacyPlaintext() {
        assertTrue(Passwords.matches("123456", "123456"));
        assertTrue(Passwords.matches("admin123", "admin123"));
        assertFalse(Passwords.matches("admin", "admin123"));
    }

    @Test
    @DisplayName("password 列为 null / 空串时返回 false 而不是 NPE")
    void shouldNotThrowOnNullOrBlank() {
        // 历史写法 user.getPassword().equals(raw) 会 NPE 打到 500
        assertFalse(Passwords.matches("123456", null));
        assertFalse(Passwords.matches("123456", ""));
        assertFalse(Passwords.matches(null, "123456"));
        assertFalse(Passwords.matches(null, null));
    }

    @Test
    @DisplayName("encode(null) 报 1001 业务错，不是 NPE")
    void shouldRejectNullEncode() {
        BusinessException ex = assertThrows(BusinessException.class, () -> Passwords.encode(null));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
    }

    @Test
    @DisplayName("生成的哈希可被自身校验（encode → matches 闭环）")
    void shouldRoundTrip() {
        String h = Passwords.encode("Zq!2026_校园");
        assertTrue(Passwords.matches("Zq!2026_校园", h));
        assertFalse(Passwords.matches("Zq!2026_校园 ", h));
    }
}
