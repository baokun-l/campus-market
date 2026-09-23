package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 种子数据密码合规测试。
 * <p>
 * ★ 为什么值得单独写一个测试类 ★
 * <p>
 * {@code schema.sql} 是**新部署环境的第一份数据**，也是全班都能看到的一份文件。
 * 里面只要还留着 {@code ('admin','admin123',...)} 这种明文，
 * 「已接 BCrypt」就只对当前这台机器成立 —— 换台机器重新初始化，密码又是明文的。
 * <p>
 * 这类回退非常隐蔽：功能全对、登录全通、演示零异常，只有翻 SQL 才看得见。
 * 所以让测试**直接读 schema.sql 原文**来把关，而不是读数据库 ——
 * 数据库是结果，SQL 文件才是会被复制传播的源头。
 */
class SeedDataPasswordTest {

    /** 种子账号 → 明文口令（仅用于校验哈希是否对应，属于公开的演示凭据） */
    private static final Map<String, String> EXPECTED_PLAINTEXT = Map.of(
            "admin", "admin123",
            "goods_admin", "goods123456",
            "report_admin", "report123456",
            "zhangsan", "123456",
            "lisi", "123456",
            "wangwu", "123456"
    );

    /**
     * 抓 t_user 的 INSERT 行：靠 role 列落脚，避免误抓 t_category 等两列表。
     * 形如 {@code ('admin', '$2a$10$...', '系统管理员', 'https://...', 'admin', 'active')}
     * <p>
     * ★ 末尾的 {@code (?:,[^)]*)?} 是必须的：兜住「status 之后还有别的列」★
     * 这里原本写死了「status 之后紧跟右括号」，于是给 t_user 添一列
     * （如 last_active_at / show_online）就会让本测试**误报 0 个种子账号** ——
     * 报错是「预期 6 个实际 0」，看上去像种子数据被人删了，实际只是正则不再匹配。
     * 给表加列是常态，这个正则不该跟着每次加列一起改。
     */
    private static final Pattern USER_ROW = Pattern.compile(
            "\\(\\s*'([A-Za-z_]+)'\\s*,\\s*'([^']*)'\\s*,\\s*'[^']*'\\s*,\\s*'[^']*'\\s*,"
                    + "\\s*'(admin|goods_admin|report_admin|user)'\\s*,\\s*'[^']*'\\s*(?:,[^)]*)?\\)");

    private static String readSchema() throws Exception {
        try (InputStream in = SeedDataPasswordTest.class.getClassLoader().getResourceAsStream("db/schema.sql")) {
            assertNotNull(in, "找不到 db/schema.sql —— 它必须在 src/main/resources 下");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static Map<String, String> parseSeedPasswords(String sql) {
        Map<String, String> found = new LinkedHashMap<>();
        Matcher m = USER_ROW.matcher(sql);
        while (m.find()) {
            found.put(m.group(1), m.group(2));
        }
        return found;
    }

    @Test
    @DisplayName("schema.sql 里 6 个种子账号的密码全部是 BCrypt 哈希，无明文")
    void seedPasswordsMustAllBeHashed() throws Exception {
        Map<String, String> seed = parseSeedPasswords(readSchema());

        assertEquals(6, seed.size(),
                "预期 6 个种子账号（admin/goods_admin/report_admin + 3 个演示用户），实际 " + seed.keySet());
        assertEquals(EXPECTED_PLAINTEXT.keySet(), seed.keySet());

        for (Map.Entry<String, String> e : seed.entrySet()) {
            assertTrue(Passwords.isHashed(e.getValue()),
                    "账号 " + e.getKey() + " 的密码不是 BCrypt 哈希：" + e.getValue()
                            + " —— 明文写进 schema.sql 等于换台机器重新初始化就全部泄露");
            assertEquals(60, e.getValue().length(), "BCrypt 哈希定长 60 位");
        }
    }

    @Test
    @DisplayName("哈希与文档声明的明文一一对应（否则演示当天登录不上）")
    void seedHashesMustVerifyAgainstDocumentedPlaintext() throws Exception {
        Map<String, String> seed = parseSeedPasswords(readSchema());
        StringBuilder report = new StringBuilder();

        for (Map.Entry<String, String> e : seed.entrySet()) {
            String username = e.getKey();
            String plain = EXPECTED_PLAINTEXT.get(username);
            boolean ok = Passwords.matches(plain, e.getValue());
            report.append(username).append(ok ? " OK" : " FAIL").append("  ");
            assertTrue(ok, "账号 " + username + " 的哈希与 " + plain + " 不匹配"
                    + " —— 脚本重新生成哈希后忘了更新文档，或者手动改错了字符");
        }
        // 让通过时也能在报告里看到逐账号结论，便于人工核对
        System.out.println("[种子密码校验] " + report);
    }

    @Test
    @DisplayName("schema.sql 全文不得再出现裸明文口令字面量")
    void schemaMustNotContainPlaintextPasswordLiteral() throws Exception {
        String sql = readSchema();
        for (String plain : new java.util.LinkedHashSet<>(EXPECTED_PLAINTEXT.values())) {
            // hash 中不含明文，所以明文一旦以「带引号的整串」出现就是回退信号
            assertTrue(!sql.contains("'" + plain + "'"),
                    "schema.sql 里出现了明文口令字面量 '" + plain + "'");
        }
    }
}
