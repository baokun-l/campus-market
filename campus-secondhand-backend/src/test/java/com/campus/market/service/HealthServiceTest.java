package com.campus.market.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * P1-5（健康检查端点）的守卫用例。
 * <p>
 * 重点锁三件**不会自证**的事：
 * <ol>
 *   <li><b>探测是真的</b> —— 数据库连不上时必须报 DOWN。若某天有人为了"让监控好看"
 *       把结果写成常量 UP，这个用例必须当场报红；</li>
 *   <li><b>探测不会把监控拖死</b> —— 数据库挂掉时连接池要等 30 秒，健康检查必须有上界；</li>
 *   <li><b>不回传内部细节</b> —— 端点匿名可读，异常消息里通常含 JDBC URL / 主机名 / 库名，
 *       回传等于把内网拓扑送出去。</li>
 * </ol>
 */
class HealthServiceTest {

    private HealthService service;

    @AfterEach
    void tearDown() {
        if (service != null) {
            service.shutdown();
        }
    }

    /** 一个会正常应答 SELECT 1 的假连接 */
    private static Connection healthyConnection() throws Exception {
        Connection conn = mock(Connection.class);
        Statement st = mock(Statement.class);
        ResultSet rs = mock(ResultSet.class);
        when(conn.createStatement()).thenReturn(st);
        when(st.executeQuery(anyString())).thenReturn(rs);
        when(rs.next()).thenReturn(true);
        return conn;
    }

    /** 建一个会正常应答 SELECT 1 的假库 */
    private static DataSource healthyDataSource() throws Exception {
        // ★ 必须先建好连接再 when(...)：把 healthyConnection() 直接写进 thenReturn 的实参里，
        //   会让它的内部 stubbing 嵌在外层 stubbing 的求值过程中 ⇒ Mockito 报 UnfinishedStubbing
        //   （报错还指向 healthyConnection 那一行，看着像那里的问题）
        Connection conn = healthyConnection();
        DataSource ds = mock(DataSource.class);
        when(ds.getConnection()).thenReturn(conn);
        return ds;
    }

    private static Path tempLogDir() throws Exception {
        return Files.createTempDirectory("health-test-logs");
    }

    @Test
    @DisplayName("库能查 + 日志目录可写 ⇒ UP，且 data 里带 build/uptime/time")
    void reportsUpWhenDependenciesHealthy() throws Exception {
        Path dir = tempLogDir();
        service = new HealthService(healthyDataSource(), dir.toString(), 2000);

        Map<String, Object> data = service.report();

        assertEquals(HealthService.UP, data.get("status"));
        @SuppressWarnings("unchecked")
        Map<String, Object> db = (Map<String, Object>) data.get("db");
        assertEquals(HealthService.UP, db.get("status"));
        assertTrue(((Number) db.get("latencyMs")).longValue() >= 0);

        @SuppressWarnings("unchecked")
        Map<String, Object> log = (Map<String, Object>) data.get("log");
        assertEquals(Boolean.TRUE, log.get("writable"));

        // ★ 构建标识必须来自事实（jar 名 / dev(classes)），不是写死的 "unknown"：
        //   排障第一问是"线上跑的是哪一版"，这里为空等于这个字段白设
        assertNotNull(data.get("build"));
        assertNotEquals("", data.get("build"));
        // 单测跑在 target/test-classes 上 ⇒ 应如实报 dev(...)，不是编一个版本号
        assertTrue(String.valueOf(data.get("build")).startsWith("dev("),
                "非 jar 形态应报 dev(...)，实际=" + data.get("build"));
        assertTrue(((Number) data.get("uptimeSeconds")).longValue() >= 0);
        assertNotNull(data.get("time"));

        // 顺序固定（人读 JSON 时 status 永远第一）
        assertEquals("status", data.keySet().iterator().next());
    }

    @Test
    @DisplayName("★ 库连不上必须报 DOWN（防「为了让监控好看」写成常量 UP）★")
    void reportsDownWhenDatabaseUnreachable() throws Exception {
        DataSource ds = mock(DataSource.class);
        when(ds.getConnection()).thenThrow(new SQLException(
                "Access denied for user 'campus'@'10.1.2.3' (using password: YES), url=jdbc:mysql://db.internal:3306/campus_market"));

        Path dir = tempLogDir();
        service = new HealthService(ds, dir.toString(), 2000);
        Map<String, Object> data = service.report();

        assertEquals(HealthService.DOWN, data.get("status"));
        @SuppressWarnings("unchecked")
        Map<String, Object> db = (Map<String, Object>) data.get("db");
        assertEquals(HealthService.DOWN, db.get("status"));

        // ★ 漏洞面：端点匿名可读，异常消息里带着主机名/库名/用户名，一个字都不能出去
        String json = String.valueOf(data);
        assertFalse(json.contains("Access denied"), "不得回传数据库异常原文");
        assertFalse(json.contains("db.internal"), "不得回传数据库主机名");
        assertFalse(json.contains("jdbc:"), "不得回传 JDBC URL");
    }

    @Test
    @DisplayName("★★ 库卡住时必须有响应时间上界（否则健康检查自己把监控拖死）★★")
    void doesNotHangWhenDatabaseStalls() throws Exception {
        DataSource ds = mock(DataSource.class);
        when(ds.getConnection()).thenAnswer(inv -> {
            Thread.sleep(5000);            // 模拟连接池的 connectionTimeout（Hikari 默认 30 秒）
            return mock(Connection.class);
        });

        Path dir = tempLogDir();
        service = new HealthService(ds, dir.toString(), 200);   // 限时 200ms

        long t0 = System.currentTimeMillis();
        Map<String, Object> data = service.report();
        long elapsed = System.currentTimeMillis() - t0;

        assertEquals(HealthService.DOWN, data.get("status"));
        assertTrue(elapsed < 1500,
                "探测超时必须立刻答 DOWN，实测耗时 " + elapsed + "ms —— 若这里变成 5s+，监控会判超时，"
                        + "我们就从「探针看不出故障」变成「探针自己不可用」");
    }

    @Test
    @DisplayName("★ 日志目录不可写 ⇒ DEGRADED（不是 UP，也不是 DOWN：处置动作不同）★")
    void reportsDegradedWhenLogDirNotWritable() throws Exception {
        // 拿一个**已存在的普通文件**当目录路径：createDirectories 必然失败。
        // 这就是生产上 ProtectSystem=strict 漏配 ReadWritePaths 时的形态 ——
        // 服务照常工作、错误照常发生，但事后一点痕迹都没有，且完全静默。
        Path notADir = Files.createTempFile("health-not-a-dir", ".tmp");
        service = new HealthService(healthyDataSource(), notADir.toString(), 2000);

        Map<String, Object> data = service.report();

        assertEquals(HealthService.DEGRADED, data.get("status"),
                "库是好的，所以不能报 DOWN（会让告警失真）；但日志写不进去绝不能报 UP");
        @SuppressWarnings("unchecked")
        Map<String, Object> log = (Map<String, Object>) data.get("log");
        assertEquals(Boolean.FALSE, log.get("writable"));

        // 不回传绝对路径：端点匿名可读
        assertFalse(String.valueOf(data).contains(notADir.toString()), "不得回传日志目录绝对路径");
    }

    @Test
    @DisplayName("★ db-timeout-ms 配得太小会被收敛到 200ms（配 0 就是「每次必然超时」的假警报）★")
    void clampsTooSmallTimeoutUpwards() throws Exception {
        Path dir = tempLogDir();
        // 库要花 ~20ms 才答。传 1ms：
        //   修复前（不夹紧）⇒ 1ms 预算必然超时 ⇒ 恒报 DOWN（假警报）
        //   修复后（夹到 200ms）⇒ 20ms 的工作有 10 倍余量 ⇒ UP
        // ★ 刻意用「20ms 的工作 vs 200ms 的预算」这种 10 倍余量的差值，
        //   而不是 get(0) 那种"看调度运气"的写法 —— 后者在删掉夹紧的实现上也会绿。
        DataSource slowish = mock(DataSource.class);
        when(slowish.getConnection()).thenAnswer(inv -> {
            Thread.sleep(20);
            return healthyConnection();
        });

        service = new HealthService(slowish, dir.toString(), 1);
        Map<String, Object> data = service.report();

        assertEquals(HealthService.UP, data.get("status"),
                "限时应被夹到 200ms 下限；若这里报 DOWN，说明「每次都必然超时」的假警报又回来了");
    }

    @Test
    @DisplayName("夹紧规则本身：|x| < 200 ⇒ 200；够大的值原样保留（不误伤正常配置）")
    void clampFloorIsTwoHundredMillis() throws Exception {
        Path dir = tempLogDir();
        // 直接断言"生效值"：这条是**确定性**的，不依赖任务是否恰好跑完
        assertEquals(200, new HealthService(healthyDataSource(), dir.toString(), 0).effectiveDbTimeoutMs());
        assertEquals(200, new HealthService(healthyDataSource(), dir.toString(), 1).effectiveDbTimeoutMs());
        assertEquals(200, new HealthService(healthyDataSource(), dir.toString(), 199).effectiveDbTimeoutMs());
        // 负数同样收敛到下限（配置口径里负数=不限的那套语义**不适用于**时限：没有"无限等"这种选项）
        assertEquals(200, new HealthService(healthyDataSource(), dir.toString(), -5).effectiveDbTimeoutMs());
        // 正常值不许被改动，否则"夹紧"就变成了"把别人的配置改掉"
        assertEquals(5000, new HealthService(healthyDataSource(), dir.toString(), 5000).effectiveDbTimeoutMs());
    }

    @Test
    @DisplayName("日志目录会被创建（首次部署时目录还不存在，不该因此判 DEGRADED）")
    void createsLogDirOnDemand() throws Exception {
        Path base = Files.createTempDirectory("health-parent");
        Path nested = base.resolve("logs").resolve("nested");

        service = new HealthService(healthyDataSource(), nested.toString(), 2000);
        Map<String, Object> data = service.report();

        assertEquals(HealthService.UP, data.get("status"));
        assertTrue(Files.isDirectory(nested), "探测时会顺带建目录");
    }

    @Test
    @DisplayName("构建标识：fat jar 的嵌套 URL 必须解析出产物名（★ 单测与真机的唯一差别）")
    void buildIdFromNestedJarUrl() {
        /*
         * ★ 这组用例的来历 ★
         * 第一版 resolveBuildId() 用的是 Paths.get(location.toURI()).getFileName()。
         * 单测跑在 target/test-classes 目录下，那是分层 URI，一路顺畅；
         * 真机跑 Spring Boot fat jar 时 CodeSource 变成
         *     jar:file:/…/app.jar!/BOOT-INF/classes!/
         * 不是分层 URI ⇒ 抛 ⇒ build 恒 "unknown"，字段彻底失效。
         * 是 .workbuddy/e2e-p15p16.mjs 的 buildIdInBody 断言把它抓出来的。
         * 把这两个形态**直接喂字符串**进来，才能让单测守住它 —— 否则下次有人改回去，
         * 又只有真机才报错。
         */
        String expect = "campus-market-1.0.0-cb36aa33cac2-202609221605";
        assertEquals(expect, HealthService.buildIdFromLocation(
                "jar:file:/opt/app/" + expect + ".jar!/BOOT-INF/classes!/"),
                "fat jar 的嵌套 URL（真机形态）");
        assertEquals(expect, HealthService.buildIdFromLocation(
                "file:/C:/dist/" + expect + ".jar"),
                "普通非嵌套 jar");
        assertEquals(expect, HealthService.buildIdFromLocation(
                "jar:file:/C:/Users/%E5%88%98%E5%AE%9D%E6%9D%B0/dist/" + expect + ".jar!/BOOT-INF/classes!/"),
                "目录含中文 ⇒ URL 百分号编码，但文件名是 ASCII，不该被影响");
    }

    @Test
    @DisplayName("构建标识：目录形态如实报 dev(...) 或 unknown（不编版本号）")
    void buildIdFromDirectoryAndGarbage() {
        assertEquals("dev(classes)", HealthService.buildIdFromLocation("file:/C:/proj/target/classes"));
        assertEquals("dev(classes)", HealthService.buildIdFromLocation("file:/C:/proj/target/classes/"));
        assertEquals("unknown", HealthService.buildIdFromLocation(null));
        assertEquals("unknown", HealthService.buildIdFromLocation(""));
    }
}
