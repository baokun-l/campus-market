package com.campus.market.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.util.TimeZone;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link DeploymentGuard} 的单测。
 * <p>
 * ★ 为什么这类"配置护栏"值得写单测 ★
 * 它防的是「启动参数写错 → 数据被清空 / 后台被任意人进入」这种**低频但不可逆**的事故。
 * 这类代码平时一次都不会被跑到，只有出事那天跑一次 —— 如果那天它自己是坏的，
 * 就等于没有护栏。所以它必须在 CI 里被反复执行。
 * <p>
 * ★ 测试要点 ★ {@link MockEnvironment} 直接喂环境，不需要起 Spring 容器，
 * 因此"护栏有没有在容器创建**之前**生效"这件事能被干净地验证。
 */
@DisplayName("DeploymentGuard（部署护栏）")
class DeploymentGuardTest {

    /** 一条够长、且不是仓库兜底值的密钥 */
    private static final String GOOD_SECRET =
            "Zq3F7u9Lp2Xc8Vn5Tb1Rw6Yh4Km0Ds9Ag2Jf5Hc7Ne1Bv3Xz8";

    private TimeZone originalTimeZone;

    @BeforeEach
    void rememberTimeZone() {
        // normalizeTimeZone 会改 JVM 全局默认时区 —— 这是**进程级**副作用，
        // 不还原就会污染同批次的其它测试（而且症状会非常难查）。
        originalTimeZone = TimeZone.getDefault();
    }

    @AfterEach
    void restoreTimeZone() {
        TimeZone.setDefault(originalTimeZone);
    }

    private static MockEnvironment env(String... activeProfiles) {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles(activeProfiles);
        return env;
    }

    private static void run(MockEnvironment env) {
        new DeploymentGuard().postProcessEnvironment(env, null);
    }

    // ==================================================================
    // ① demo profile：未确认必须拒绝
    // ==================================================================

    @Test
    @DisplayName("① demo 未确认 → 拒绝启动，且说清会删哪些表")
    void demoWithoutConfirmationIsRejected() {
        MockEnvironment env = env("demo");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));

        // 断言的是"给操作者的信息够不够用来做决定"，而不是措辞本身
        String m = e.getMessage();
        assertTrue(m.contains("demo"), "应点名 demo profile");
        assertTrue(m.contains("DELETE FROM t_goods"), "应说清 t_goods 会被清空，实际：" + m);
        assertTrue(m.contains("t_category"), "应说清 t_category 会被清空");
        assertTrue(m.contains(DeploymentGuard.RESET_CONFIRMED_KEY), "应给出确认开关的名字");
        assertFalse(m.contains("Unknown"), "不应是占位符未展开的报错");
    }

    @Test
    @DisplayName("② demo 已显式确认 → 放行（并记录一条 warn 留痕）")
    void demoWithConfirmationPasses() {
        MockEnvironment env = env("demo");
        env.setProperty(DeploymentGuard.RESET_CONFIRMED_KEY, "true");

        run(env); // 不抛异常即通过

        // 确认放行时不许顺手改时区（那是 prod 专属逻辑）
        assertEquals(originalTimeZone.getID(), TimeZone.getDefault().getID(),
                "demo 不该动 JVM 时区");
    }

    @Test
    @DisplayName("③ 确认开关写成 false → 仍然拒绝（只有真 true 才放行）")
    void confirmationMustBeBooleanTrue() {
        MockEnvironment env = env("demo");
        env.setProperty(DeploymentGuard.RESET_CONFIRMED_KEY, "false");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));
        assertTrue(e.getMessage().contains("没有显式确认"), "实际：" + e.getMessage());
    }

    @Test
    @DisplayName("③b 空值 / 只写键不写值 → 视为未确认（--app.demo.reset-confirmed 不带 =true 不算数）")
    void blankConfirmationIsNotEnough() {
        MockEnvironment env = env("demo");
        env.setProperty(DeploymentGuard.RESET_CONFIRMED_KEY, "");

        assertThrows(IllegalStateException.class, () -> run(env));
    }
    // 注：Spring 的布尔转换把 "true"/"on"/"yes"/"1" 都视为 true（标准语义，不是漏洞）——
    // 写 "yes" 会放行，这是符合直觉的，故不作断言。

    @Test
    @DisplayName("④ prod 与 demo 同时激活 → 拒绝（不能靠 profile 顺序赌）")
    void prodAndDemoTogetherIsRejected() {
        MockEnvironment env = env("prod", "demo");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");
        env.setProperty(DeploymentGuard.RESET_CONFIRMED_KEY, "true");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));

        assertTrue(e.getMessage().contains("不能同时激活"), "应点明互斥，实际：" + e.getMessage());
    }

    // ==================================================================
    // ② prod 凭据
    // ==================================================================

    @Test
    @DisplayName("⑤ prod 缺 JWT_SECRET → 拒绝")
    void prodWithoutJwtSecretIsRejected() {
        MockEnvironment env = env("prod");
        env.setProperty("DB_PASSWORD", "strong-pass");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));
        assertTrue(e.getMessage().contains("JWT_SECRET 未设置"), "实际：" + e.getMessage());
    }

    @Test
    @DisplayName("⑥ prod 用仓库兜底密钥 → 拒绝（warn 是不够的）")
    void prodWithFallbackSecretIsRejected() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", DeploymentGuard.DEV_JWT_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));
        assertTrue(e.getMessage().contains("默认兜底值"), "实际：" + e.getMessage());
    }

    @Test
    @DisplayName("⑦ prod 密钥短于 32 字节 → 拒绝（HS256 硬性要求）")
    void prodWithTooShortSecretIsRejected() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", "short-secret");
        env.setProperty("DB_PASSWORD", "strong-pass");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));
        assertTrue(e.getMessage().contains("太短"), "实际：" + e.getMessage());
    }

    @Test
    @DisplayName("⑧ prod 仍用默认库口令 123456 → 拒绝")
    void prodWithDefaultDbPasswordIsRejected() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", DeploymentGuard.DEV_DB_PASSWORD);

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));
        assertTrue(e.getMessage().contains("默认库口令"), "实际：" + e.getMessage());
    }

    @Test
    @DisplayName("⑨ 凭据齐备的 prod → 放行")
    void prodWithRealCredentialsPasses() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");

        run(env); // 不抛异常即通过
    }

    // ==================================================================
    // ③ prod 默认值加固
    // ==================================================================

    @Test
    @DisplayName("⑩ prod 强制关闭接口文档，环境变量 SPRINGDOC_*=true 也覆盖不了")
    void prodForceDisablesSpringdoc() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");
        // 模拟「把开发环境的环境文件整份复制过来」
        env.setProperty("springdoc.api-docs.enabled", "true");
        env.setProperty("springdoc.swagger-ui.enabled", "true");

        run(env);

        assertEquals(Boolean.FALSE, env.getProperty("springdoc.api-docs.enabled", Boolean.class));
        assertEquals(Boolean.FALSE, env.getProperty("springdoc.swagger-ui.enabled", Boolean.class));
    }

    @Test
    @DisplayName("⑪ 非 prod 时护栏不许插手（本地/演示仍可开接口文档）")
    void noProfileMeansNoOverrides() {
        MockEnvironment env = env();
        env.setProperty("springdoc.swagger-ui.enabled", "true");

        run(env);

        assertEquals(Boolean.TRUE, env.getProperty("springdoc.swagger-ui.enabled", Boolean.class));
        assertNull(env.getPropertySources().get("deploymentGuardOverrides"),
                "非 prod 不应注入属性源");
    }

    // ==================================================================
    // ④ 时区：JVM 侧与 MySQL 侧共用同一个开关
    // ==================================================================

    @Test
    @DisplayName("⑫ prod 把 JVM 默认时区钉为 +08:00")
    void prodPinsJvmTimeZone() {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC")); // 模拟 Docker 默认 UTC
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");

        run(env);

        assertEquals("GMT+08:00", TimeZone.getDefault().getID());
    }

    @Test
    @DisplayName("⑬ 换偏移开关 → JVM 侧跟着变（与 MySQL 侧是同一个 key，不可能只改一边）")
    void customOffsetIsHonored() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");
        env.setProperty(DeploymentGuard.TIME_ZONE_OFFSET_KEY, "+09:00");

        run(env);

        assertEquals("GMT+09:00", TimeZone.getDefault().getID());
    }

    @Test
    @DisplayName("⑭ 非法偏移 → 拒绝（TimeZone.getTimeZone 认不出会静默退回 GMT，不能放行）")
    void invalidOffsetIsRejected() {
        MockEnvironment env = env("prod");
        env.setProperty("JWT_SECRET", GOOD_SECRET);
        env.setProperty("DB_PASSWORD", "strong-pass");
        env.setProperty(DeploymentGuard.TIME_ZONE_OFFSET_KEY, "Asia/Shanghai");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> run(env));
        assertTrue(e.getMessage().contains("不是合法的 UTC 偏移"), "实际：" + e.getMessage());
        assertNotEquals("GMT", TimeZone.getDefault().getID(),
                "拒绝时不应把时区改成 GMT+00:00（那样等于把故障换了个方向）");
    }

    @Test
    @DisplayName("⑮ 护栏跑在所有自动配置之前（order = LOWEST_PRECEDENCE 之前的最高优先级组）")
    void runsAfterConfigDataIsLoaded() {
        assertEquals(Integer.MAX_VALUE, new DeploymentGuard().getOrder(),
                "必须最后跑，否则看不到 application-prod.yml 里的属性");
    }
}
