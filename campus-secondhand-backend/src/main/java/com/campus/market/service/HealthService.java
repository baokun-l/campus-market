package com.campus.market.service;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 健康检查服务（部署适配清单 P1-5）
 * <p>
 * 回答一个问题：「**这台机器上的服务，现在到底是不是好的**」。
 * 逐项探测依赖，把结果汇总成一个总状态给运维与监控用。
 *
 * <h3>★★ 起因：服务已经挂了，监控显示健康 ★★</h3>
 * 原先全仓没有 {@code /health}、也没有 actuator，而本项目的约定是
 * <b>所有业务错误一律 HTTP 200 + body 业务码</b>（见 {@code AuthInterceptor#reject}）。
 * 两者叠加的后果是：数据库连不上、接口全线报错时，探针看到的仍然是 {@code 200 OK}。
 * <p>
 * ★ 修法不是去改状态码 ★ —— 那个 200 约定是**为了适配前端 axios 的错误分支**而做的正确选择，
 * 改回去会让前端精心写的 401/403 分支永远走不到（细节见 {@code GlobalExceptionHandler} 类注释）。
 * 所以这里补一个**独立端点**，并把监控口径改成「看响应体」，这是
 * 「约定本身没错，但监控方式要跟着约定走」的典型案例。
 *
 * <h3>★★ 为什么 code 恒为 0、状态放在 data.status ★★</h3>
 * {@code Result} 与 {@code BusinessCode} 里，{@code 500} 的语义被明确限定为
 * 「**真正的未捕获故障**，只应由兜底分支产出」（见 {@code Result#error(String)} 的废弃说明）——
 * 它曾经被业务拒绝滥用，导致监控里出现一批假的「服务端异常」，把真故障淹掉。
 * <p>
 * 健康检查不是那种情况：**这次请求本身是成功的**（我们成功测出了依赖的状态），
 * 不健康是「被测对象的属性」，属于 data，不属于这次调用的结果码。
 * 所以：{@code code=0} 恒定，真正的信号是 {@code data.status}。
 * <p>
 * 监控一行版：
 * <pre>
 *   curl -fsS http://127.0.0.1:8080/api/health | jq -e '.data.status == "UP"'
 * </pre>
 * 云监控只支持「关键字匹配」时，匹配 {@code "status":"UP"} 即可。
 * 若只做**存活**探测（进程还在吗），看 HTTP 200 就够了 —— 两层含义不同，别混用：
 * <ul>
 *   <li>HTTP 200 ⇒ Tomcat 还活着（能接连接、能回响应）；</li>
 *   <li>{@code data.status == "UP"} ⇒ 依赖也健康（数据库能查、日志能写）。</li>
 * </ul>
 *
 * <h3>★ 三个状态，不是一个 ★</h3>
 * <ul>
 *   <li>{@code UP} —— 全好；</li>
 *   <li>{@code DEGRADED} —— 数据库好，但**日志目录不可写**。站点能用，但「排障第一现场」
 *       正在丢失，而且这事**完全静默**（logback 写不进去时只在控制台打一行，没人看）。
 *       生产的典型成因是 systemd 的 {@code ProtectSystem=strict} 没有把日志目录放进
 *       {@code ReadWritePaths} —— 这正是本轮在 {@code deploy/campus-market.service} 里修掉的那个坑；</li>
 *   <li>{@code DOWN} —— 数据库不可用，业务已经不可用。</li>
 * </ul>
 * 三者分开是因为**处置动作不同**：DOWN 要立刻介入，DEGRADED 要当天处理。
 * 把 DEGRADED 也报成 DOWN 会让告警失真（狼来了），报成 UP 则等于没检查。
 *
 * <h3>★ 探测必须自带超时，否则健康检查自己会把监控拖死 ★</h3>
 * 数据库挂掉时，{@code dataSource.getConnection()} 会等**连接池的** connectionTimeout
 * （Hikari 默认 30 秒）。若健康检查直接同步调用，探针就会挂 30 秒 ⇒ 监控判定为超时 ⇒
 * 我们想解决「探针看不出故障」，结果变成「探针自己不可用」。
 * 所以这里把探测丢进**单线程**执行器并用 {@code Future.get(timeout)} 限时：
 * 超时即答 DOWN，响应时间有上界。
 * <p>
 * ★ 为什么是**单**线程 ★：数据库持续不可用时，每次调用都会在池等待里留下一个卡住的线程。
 * 用无界线程池会不断新建线程（探测频率 10 秒一次，一天能堆出上万个）；
 * 单线程池则**最多只有一个**卡住的探测，后续调用排队后被超时规则快速判 DOWN。
 * 这是刻意的有界资源占用，不是性能优化。
 *
 * <h3>★ 响应里不回传内部细节 ★</h3>
 * 数据库探测失败时，异常消息里通常含 JDBC URL、主机名、库名 —— 端点又是**匿名可读**的，
 * 直接回传等于把内网拓扑送出去。所以对外只有 {@code status/latencyMs}，
 * 异常细节只进日志（那里现在带 traceId，见 {@code RequestTraceFilter}）。
 */
@Service
public class HealthService {

    private static final Logger log = LoggerFactory.getLogger(HealthService.class);

    public static final String UP = "UP";
    public static final String DEGRADED = "DEGRADED";
    public static final String DOWN = "DOWN";

    private final DataSource dataSource;

    /** 与 logback-spring.xml 读的是**同一个配置键**（app.log-dir），避免"检查的和实际写的不是一个目录" */
    private final String logDir;

    private final int dbTimeoutMs;

    /** 单线程 + daemon：见类注释「为什么是单线程」 */
    private final ExecutorService probeExecutor;

    private final long startedAtMs = System.currentTimeMillis();

    @Autowired
    public HealthService(DataSource dataSource,
                         @Value("${app.log-dir:logs}") String logDir,
                         @Value("${app.health.db-timeout-ms:2000}") int dbTimeoutMs) {
        this.dataSource = dataSource;
        this.logDir = logDir;
        // 下限 200ms：配 0 会让每次探测都必然超时 ⇒ 恒报 DOWN，比不检查更糟（假警报）
        this.dbTimeoutMs = Math.max(200, dbTimeoutMs);
        ThreadFactory tf = r -> {
            Thread t = new Thread(r, "health-probe");
            t.setDaemon(true);
            return t;
        };
        this.probeExecutor = Executors.newSingleThreadExecutor(tf);
    }

    @PreDestroy
    public void shutdown() {
        probeExecutor.shutdownNow();
    }

    /**
     * 生效的探测限时（毫秒）。**只为测试而存在**（package-private）。
     * <p>
     * ★ 为什么必须能读到这个值 ★
     * 一开始只用行为断言（配 0 时健康库仍应探测成功），结果发现它**没有判别力**：
     * 修复前写法的 {@code future.get(0, MILLISECONDS)} 在任务"恰好已经完成"时也会成功返回 ——
     * 于是这条断言在"夹紧被删掉"的实现上照样绿（红绿探针当场抓出：M7 突变没让它报红）。
     * 那属于**调度竞态**，它不是证明，只是运气。
     * 现在把「生效值」直接暴露出来断言，配合下面那条有 10 倍余量的行为用例：
     * 一条锁死决定本身，一条证明这个决定真的生效。
     */
    int effectiveDbTimeoutMs() {
        return dbTimeoutMs;
    }

    /**
     * 探测并汇总。**任何情况下都不抛异常** —— 健康检查自己抛异常是最坏的形态：
     * 监控看到的是 500/超时，而真正的原因（数据库挂了）被掩盖。
     */
    public Map<String, Object> report() {
        Map<String, Object> db = checkDatabase();
        boolean logWritable = checkLogWritable();
        boolean dbUp = UP.equals(db.get("status"));

        String overall;
        if (!dbUp) {
            overall = DOWN;
        } else if (!logWritable) {
            overall = DEGRADED;
        } else {
            overall = UP;
        }

        Map<String, Object> out = new LinkedHashMap<>();
        // 顺序固定：人读 JSON 时 status 永远在第一位，grep/肉眼都快
        out.put("status", overall);
        out.put("db", db);
        // ★ 只报「能不能写」，不回传绝对路径：端点匿名可读，绝对路径属于内网信息
        out.put("log", Map.of("writable", logWritable));
        out.put("build", resolveBuildId());
        out.put("uptimeSeconds", (System.currentTimeMillis() - startedAtMs) / 1000);
        out.put("time", java.time.LocalDateTime.now().toString());
        return out;
    }

    /** 数据库探测：限时 + 不回传内部细节 */
    private Map<String, Object> checkDatabase() {
        Map<String, Object> db = new LinkedHashMap<>();
        long t0 = System.currentTimeMillis();
        Future<Long> future = probeExecutor.submit(this::pingDatabase);
        try {
            long latency = future.get(dbTimeoutMs, TimeUnit.MILLISECONDS);
            db.put("status", UP);
            db.put("latencyMs", latency);
        } catch (TimeoutException e) {
            future.cancel(true);
            db.put("status", DOWN);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            // 超时不带堆栈：这是"依赖不健康"的预期结果，不是代码缺陷；带堆栈会把 error 日志冲成噪音
            log.warn("健康检查：数据库探测超时（>{}ms），判定 DOWN", dbTimeoutMs);
        } catch (ExecutionException e) {
            db.put("status", DOWN);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            // ★ 细节只进日志（含 traceId/uid），响应里一个字都不回传
            log.warn("健康检查：数据库探测失败，判定 DOWN", e.getCause());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            db.put("status", DOWN);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            log.warn("健康检查：数据库探测被中断，判定 DOWN");
        }
        return db;
    }

    /** 真的去查一次库（不是只看连接池对象在不在） */
    private long pingDatabase() throws Exception {
        long t0 = System.currentTimeMillis();
        try (Connection conn = dataSource.getConnection();
             Statement st = conn.createStatement()) {
            // 语句级超时兜住"连上了但库不响应"（如锁等待），只靠 getConnection 的限时不够
            st.setQueryTimeout(Math.max(1, dbTimeoutMs / 1000));
            try (ResultSet rs = st.executeQuery("SELECT 1")) {
                rs.next();
            }
        }
        return System.currentTimeMillis() - t0;
    }

    /**
     * 日志目录可写性。
     * <p>
     * ★ 为什么这件小事值得单独探测 ★
     * 「日志写不进去」是本项目最怕的那类故障：**服务照常工作、错误照常发生，
     * 但事后什么痕迹都没有**。生产上最容易踩的成因是 systemd 把根文件系统挂成只读
     * （{@code ProtectSystem=strict}）却忘了把日志目录加进 {@code ReadWritePaths} ——
     * 那时 logback 只在启动瞬间往控制台打一行错误，之后再无声息。
     * 探测方式就是**真去写一个文件**：能创建再删掉，才算可写。
     * （只检查目录存在是不够的：目录存在但只读是更常见的情况。）
     */
    private boolean checkLogWritable() {
        Path dir = Paths.get(logDir);
        Path probe = null;
        try {
            Files.createDirectories(dir);
            probe = Files.createTempFile(dir, ".health-probe-", ".tmp");
            return true;
        } catch (Exception e) {
            log.warn("健康检查：日志目录不可写（{}）—— 服务仍可用，但故障现场不会被记录", logDir, e);
            return false;
        } finally {
            if (probe != null) {
                try {
                    Files.deleteIfExists(probe);
                } catch (Exception ignored) {
                    // 删不掉不影响"可写"的判断；这个临时文件极小且带固定前缀，可被巡检清理
                }
            }
        }
    }

    /**
     * 正在运行的构建标识 = **jar 文件名**（去掉 .jar 后缀）。
     * <p>
     * ★ 为什么读文件名而不是读配置 ★
     * 发版脚本 {@code deploy/build-release.mjs} 产出的名字本身就带版本与源码指纹
     * （形如 {@code campus-market-1.0.0-dd76412d72e6-202609221420.jar}），
     * 所以「当前跑的是哪一版」这个信息**已经在产物名里了**。
     * 再引入一个 {@code APP_VERSION} 环境变量就多一个会忘记设置、且忘了也不报错的开关
     * （本项目已多次踩「配置了但没生效」）；直接读事实来源，零配置、不会说谎。
     * <p>
     * 用 IDE / {@code mvn spring-boot:run} / {@code -cp classes} 启动时没有 jar，
     * 此时返回 {@code dev(...)} —— 如实说明"不是打包产物"，而不是编一个版本号。
     */
    private static String resolveBuildId() {
        try {
            return buildIdFromLocation(HealthService.class.getProtectionDomain().getCodeSource().getLocation().toString());
        } catch (Exception e) {
            return "unknown";
        }
    }

    /**
     * 从 CodeSource 的 location 字符串里取出「构建标识」。
     * <p>
     * ★★ 为什么要单独抽出来：真机与单测拿到的 location **根本不是一个形态** ★★
     * <p>
     * Spring Boot 的可执行 fat jar 用 {@code LaunchedURLClassLoader}，本类的 CodeSource 是
     * <pre>jar:file:/…/campus-market-1.0.0-xxx-202609221605.jar!/BOOT-INF/classes!/</pre>
     * 它**不是分层 URI**，所以 {@code Paths.get(location.toURI())} 直接抛
     * （{@code FileSystemNotFoundException} / "URI is not hierarchical"）⇒ {@code build} 恒为
     * {@code "unknown"}，整个字段失去意义（"当前跑的是哪一版"答不出来）。
     * <p>
     * 而**单测永远发现不了**：单测跑在 {@code target/classes} 目录下，location 是普通目录，
     * 一路顺畅 —— 这正是"单测绿、真机红"的典型形态。第一版就是这样的，
     * 是 {@code .workbuddy/e2e-p15p16.mjs} 的 {@code buildIdInBody} 断言把它抓出来的。
     * <p>
     * 所以这里改成纯字符串解析：取「{@code .jar} 之前的最后一段路径」，三种形态都成立 ——
     * <ul>
     *   <li>{@code file:/C:/x/app.jar} → {@code app}</li>
     *   <li>{@code jar:file:/C:/x/app.jar!/BOOT-INF/classes!/} → {@code app}</li>
     *   <li>目录（IDE / {@code mvn spring-boot:run}）→ 走下面的 {@code dev(...)} 分支</li>
     * </ul>
     * 抽成静态方法是为了**能被单测直接喂字符串**，把那两个 fat jar 形态钉在单测里 ——
     * 否则下次有人"顺手"改回 {@code Paths.get(toURI())}，又只有真机才报错。
     */
    static String buildIdFromLocation(String raw) {
        if (raw == null || raw.isEmpty()) {
            return "unknown";
        }
        int jarMark = raw.indexOf(".jar");
        if (jarMark > 0) {
            String name = lastSegment(raw.substring(0, jarMark));
            if (!name.isEmpty()) {
                return decodeIfEncoded(name);
            }
        }
        // 非 jar（IDE / mvn spring-boot:run / target/classes）：如实说明"不是打包产物"，
        // 而不是编一个版本号，也不是含糊的 unknown —— 后者会让人以为读取失败
        String dir = lastSegment(raw.replaceAll("/+$", ""));
        return dir.isEmpty() ? "unknown" : "dev(" + decodeIfEncoded(dir) + ")";
    }

    /** 取路径的最后一段（同时认 `/` 与 `\`，因为 URL 里可能出现反斜杠） */
    private static String lastSegment(String s) {
        int slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return s.substring(slash + 1);
    }

    /** 只在**确实**是百分号编码时才解码：URLDecoder 会把 `+` 也解成空格，无脑解码会改坏正常文件名 */
    private static String decodeIfEncoded(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        try {
            return java.net.URLDecoder.decode(s, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return s;
        }
    }
}
