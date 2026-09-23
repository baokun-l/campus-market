package com.campus.market.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.boot.context.event.ApplicationPreparedEvent;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.Profiles;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * 部署护栏：在**环境准备好、但 Spring 容器还没创建**的时候，把几件"参数写错就毁数据/开门揖盗"的事挡住。
 * <p>
 * ★★ 为什么必须是 {@code EnvironmentPostProcessor}，而不是 {@code @Component} / {@code ApplicationRunner} ★★
 * 本项目启动时会自动执行 SQL 脚本（{@code spring.sql.init}，见 {@code application.yml}）：
 * 它由 {@code DataSourceScriptDatabaseInitializer} 在**容器刷新早期**执行，
 * 而 {@code @Component} 的创建顺序相对于它是不确定的，{@code ApplicationRunner} 更是**最后**才跑
 * —— 等它们喊"停"的时候，库已经被重置完了。
 * 只有 {@code EnvironmentPostProcessor} 跑在容器创建之前，才能做到"脚本一行都没执行就已经退出"。
 * <p>
 * 挡的是这几条（每一条都对应一次"靠记得"是防不住的）：
 * <ol>
 *   <li><b>demo profile 是重置型</b>：{@code db/demo-data.sql} 会 {@code DELETE FROM t_goods / t_category /
 *       t_goods_audit_record / t_audit_log}，{@code db/demo-data-orders.sql} 再按主键删演示订单与消息，
 *       然后灌进 16 件演示商品 + 9 笔演示订单。生产误带上 = 真实商品与订单被换成假数据。</li>
 *   <li><b>prod 与 demo 同时激活</b>：说明启动参数是被拼出来的，必须拒绝而不是"按 profile 顺序赌一个赢"。</li>
 *   <li><b>prod 缺 JWT_SECRET / 仍在用仓库里的兜底密钥</b>：兜底值写在开源仓库里 = 公开，
 *       谁都能自签一个 {@code role=admin} 的 token 进后台（{@code AuthInterceptor} 只校验签名 + 回查 status/role）。</li>
 *   <li><b>prod 仍用默认库口令 123456</b>：与"生产账号降权"是同一件事的两半，口令没换等于降权白做。</li>
 * </ol>
 * 另外在 prod 下**强制**关闭接口文档（见 {@link #hardenProdDefaults}）。
 * <p>
 * 注册方式：{@code src/main/resources/META-INF/spring.factories}。
 * 这是 Spring Boot 3.x 加载 {@code EnvironmentPostProcessor} 的**唯一**入口
 * （{@code AutoConfiguration.imports} 只管自动配置类，管不到这个扩展点）。
 */
public class DeploymentGuard implements EnvironmentPostProcessor, Ordered {

    private static final Logger log = LoggerFactory.getLogger(DeploymentGuard.class);

    /** 重置型演示 profile */
    public static final String DEMO_PROFILE = "demo";
    /** 生产 profile */
    public static final String PROD_PROFILE = "prod";

    /**
     * 启用 demo 的**显式确认开关**。
     * <p>
     * ★ 为什么给"破坏性操作"加开关，而不是靠注释提醒 ★
     * 默认安全 = 忘记加参数时得到的是"启动失败"而不是"数据没了"。
     * 想重置的人**必须主动多敲一个参数**，这就把"误操作"变成"有意操作"。
     * 命令行写 {@code --app.demo.reset-confirmed=true}，环境变量写 {@code APP_DEMO_RESET_CONFIRMED=true}
     * （{@code SystemEnvironmentPropertySource} 会做点→下划线的宽松匹配）。
     */
    public static final String RESET_CONFIRMED_KEY = "app.demo.reset-confirmed";

    /**
     * 仓库里的 JWT 兜底密钥。与 {@code JwtConfig#DEV_FALLBACK_SECRET} 同一个值 ——
     * 它写在开源仓库里，等于公开。生产出现这个值必须拒绝启动。
     */
    public static final String DEV_JWT_SECRET = "campus-secondhand-market-jwt-secret-key-2024";

    /** {@code application.yml} 里的默认库口令，同样是公开的，生产不许用 */
    public static final String DEV_DB_PASSWORD = "123456";

    /**
     * 时区偏移开关：JVM 默认时区与 MySQL 会话时区**共用它**，杜绝"只改了一边"。
     * 环境变量写法 {@code APP_TIME_ZONE_OFFSET=+08:00}。
     */
    public static final String TIME_ZONE_OFFSET_KEY = "app.time-zone-offset";

    /** 默认 +08:00（与 {@code application.yml} 里 Jackson 的 Asia/Shanghai 同义） */
    public static final String DEFAULT_TIME_ZONE_OFFSET = "+08:00";

    /** 兜底密钥/口令之外，还要求密钥本身够长（HS256 要求 ≥32 字节） */
    private static final int MIN_SECRET_LENGTH = 32;

    /** 护栏注入的属性源名字，日志与排障时能看到它插在最前面 */
    private static final String OVERRIDES = "deploymentGuardOverrides";

    /**
     * 排在最后执行：必须先让 {@code ConfigDataEnvironmentPostProcessor} 把
     * {@code application-prod.yml} 之类的 profile 配置读进来，护栏才能看到完整环境。
     */
    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }

    /**
     * 待打印的提示。见 {@link #flushNotes(SpringApplication)} ——
     * 在 {@code EnvironmentPostProcessor} 阶段调用 SLF4J **打不出任何东西**，
     * 所以不能当场 log，只能先攒着。
     */
    private final List<String> notes = new ArrayList<>();

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication application) {
        boolean demo = env.acceptsProfiles(Profiles.of(DEMO_PROFILE));
        boolean prod = env.acceptsProfiles(Profiles.of(PROD_PROFILE));

        if (demo && prod) {
            throw reject("prod 与 demo 不能同时激活",
                    "同时带上两个 profile 通常说明启动参数是拼出来的（脚本里写死了 prod，又被环境变量追加了 demo）。",
                    "两个 profile 的 data-locations 是**整体覆盖**关系，谁生效取决于声明顺序，赌赢了也纯属运气。",
                    "· 生产：只保留 --spring.profiles.active=prod",
                    "· 演示：只保留 --spring.profiles.active=demo --" + RESET_CONFIRMED_KEY + "=true");
        }

        if (demo) {
            requireResetConfirmed(env);
            return; // demo 与 prod 互斥，上面已经挡住同时出现的情况
        }

        if (prod) {
            requireJwtSecret(env);
            requireRealDbPassword(env);
            hardenProdDefaults(env);
        }

        flushNotes(application);
    }

    /**
     * ★★ 为什么提示不能当场 log，而必须推迟 ★★
     * 本类是 {@code EnvironmentPostProcessor}，跑在「环境准备好了、日志系统还没就绪」这个窗口里。
     * 真机实测（见 {@code .workbuddy/e2e-p0-guard.mjs}）：这个阶段里所有 {@code log.info/warn/error}
     * **一条都不会出现在控制台** —— 既没有报错也没有异常，就是静默消失。
     * 于是会出现一种极难察觉的假象：护栏明明生效了（时区被钉住、springdoc 被关掉），
     * 但日志里查不到任何痕迹，排障时就会以为"护栏没跑"。
     * <p>
     * 对策：先把要说的话攒在 {@link #notes} 里，再注册一个监听器，
     * 等 {@code ApplicationPreparedEvent}（日志系统此时已就绪）统一打出来。
     * 这样既保住"日志全部走 SLF4J、级别可控"的既有约定，又不用在启动早期直写控制台。
     */
    private void flushNotes(SpringApplication application) {
        if (application == null || notes.isEmpty()) {
            return; // application 为 null 只发生在单测里直接调用本方法时
        }
        List<String> snapshot = List.copyOf(notes);
        application.addListeners((ApplicationPreparedEvent event) -> {
            for (String note : snapshot) {
                log.info("[部署护栏] {}", note);
            }
        });
    }

    // ==================================================================
    // 规则一：demo 必须显式确认
    // ==================================================================

    private void requireResetConfirmed(ConfigurableEnvironment env) {
        if (env.getProperty(RESET_CONFIRMED_KEY, Boolean.class, false)) {
            notes.add("检测到 " + RESET_CONFIRMED_KEY + " = true，本次启动**会重置演示数据**"
                    + "（t_goods / t_category / t_audit_log 会被 DELETE 后重灌）。");
            return;
        }
        throw reject("demo profile 已激活，但没有显式确认重置",
                "demo 是「重置型」脚本，不是追加：",
                "  · db/demo-data.sql        DELETE FROM t_goods / t_category / t_goods_audit_record / t_audit_log",
                "  · db/demo-data-orders.sql 按主键 DELETE 演示订单、订单日志、会话消息",
                "  · 随后灌入 16 件演示商品 + 9 笔演示订单",
                "即：真实商品、分类、订单与审核日志会被**清空并换成假数据**，且没有二次确认、不可回滚。",
                "--------------------------------------------------------------------",
                "确认要重置才启动（多敲一个参数）：",
                "  java -jar app.jar --spring.profiles.active=demo --" + RESET_CONFIRMED_KEY + "=true",
                "只想「建库、不重置」：去掉 demo 这个 profile 即可（默认行为就是这样）。");
    }

    // ==================================================================
    // 规则二、三：生产凭据
    // ==================================================================

    private void requireJwtSecret(ConfigurableEnvironment env) {
        // ★ 只读环境变量名本身，不回退去读 jwt.secret ★
        // 这个护栏跑在占位符解析之前，env.getProperty("jwt.secret") 取到的是
        // application-prod.yml 里那串**还没展开的字面量** "${JWT_SECRET}" ——
        // 它既不是空、也不等于兜底值，于是"缺失"会被误判成"设置了一个奇怪的短密钥"。
        // 想绕过护栏的人绕不过去：yml 里 jwt.secret 就是 ${JWT_SECRET}，没有别的入口。
        String secret = env.getProperty("JWT_SECRET");
        if (isBlank(secret)) {
            throw reject("profile=prod 但 JWT_SECRET 未设置",
                    "jwt.secret 在 prod 下没有默认值，缺失即启动失败 —— 这是**刻意的**。",
                    "兜底密钥写在开源仓库里等于公开，谁都能自签一个 role=admin 的 token 进后台。",
                    "生成并设置：",
                    "  export JWT_SECRET=$(openssl rand -base64 48)      # Linux/macOS",
                    "  JWT_SECRET 至少 32 字节（HS256 的硬性要求）");
        }
        if (DEV_JWT_SECRET.equals(secret.trim())) {
            throw reject("profile=prod 但 JWT_SECRET 仍是仓库里的默认兜底值",
                    "这个值就写在源码里（JwtConfig.DEV_FALLBACK_SECRET），任何拿到仓库的人都能伪造 token。",
                    "请换成随机密钥：export JWT_SECRET=$(openssl rand -base64 48)");
        }
        if (secret.trim().length() < MIN_SECRET_LENGTH) {
            throw reject("profile=prod 但 JWT_SECRET 太短（< " + MIN_SECRET_LENGTH + " 字节）",
                    "HS256 要求密钥至少 32 字节（256 bit），短于这个长度签名强度不达标。",
                    "建议：export JWT_SECRET=$(openssl rand -base64 48)");
        }
    }

    private void requireRealDbPassword(ConfigurableEnvironment env) {
        // 同上：只读 DB_PASSWORD，不回退读 spring.datasource.password（那里是未展开的 ${DB_PASSWORD}）
        String password = env.getProperty("DB_PASSWORD");
        if (isBlank(password)) {
            // ★ 空口令不等于安全，但在 MySQL 里「空口令账号」是另一种常见形态，
            //   这里只告警不阻断：可能是走了 socket / 免密的部署形态，阻断会误伤。
            notes.add("profile=prod 但未读到 DB_PASSWORD。"
                    + "若这是无口令账号，请确认它只允许本机连接。");
            return;
        }
        if (DEV_DB_PASSWORD.equals(password.trim())) {
            throw reject("profile=prod 但仍在使用 application.yml 里的默认库口令",
                    "123456 是仓库里的默认值，等于公开。",
                    "· 换强口令：export DB_PASSWORD=<强随机串>",
                    "· 并配合降权账号（只授 SELECT/INSERT/UPDATE/DELETE），别用 root");
        }
    }

    // ==================================================================
    // 规则四：生产默认值加固
    // ==================================================================

    /**
     * prod 下**强制**关闭接口文档，并且插到属性源最前面 —— 连环境变量都覆盖不了它。
     * <p>
     * ★ 为什么不用 {@code ${SPRINGDOC_...:false}} 这种"默认关"的写法 ★
     * 因为部署时最常发生的事就是「把开发环境那套 docker-compose / systemd 环境文件复制过去」，
     * 里面带着 {@code SPRINGDOC_SWAGGER_UI_ENABLED=true}，默认值直接被盖掉。
     * 接口文档会把每个端点的路径、参数、错误码列全，对攻击者是免费的侦察资料 ——
     * 这类"关了又可能被打开"的开关，就应该像现在这样钉死，并留一条日志说明是谁关的。
     */
    private void hardenProdDefaults(ConfigurableEnvironment env) {
        normalizeTimeZone(env);

        Map<String, Object> forced = new LinkedHashMap<>();
        forced.put("springdoc.api-docs.enabled", false);
        forced.put("springdoc.swagger-ui.enabled", false);
        env.getPropertySources().addFirst(new MapPropertySource(OVERRIDES, forced));

        String cors = env.getProperty("cors.allowed-origins");
        if (isBlank(cors)) {
            notes.add("profile=prod 但未配置 CORS_ALLOWED_ORIGINS。当前口径是「不放行任何跨域来源」："
                    + "前后端同域反代部署属正常；若前端放在别的域名（CDN / 独立前端域名），"
                    + "跨域请求会被一律拒绝（403 Invalid CORS request）。");
        }
        notes.add("profile=prod：已强制关闭 springdoc 接口文档（忽略 SPRINGDOC_* 环境变量）。");
    }

    // ==================================================================
    // 规则五：时区两侧对齐（这是全项目最隐蔽的一个静默失效点）
    // ==================================================================

    /**
     * ★★ 把 JVM 默认时区钉成固定偏移，与 MySQL 会话时区用**同一个开关** ★★
     * <p>
     * 故障现场（不修的话，线上表现出来的是"在线小绿点怎么都不亮"，而且**一条错误日志都没有**）：
     * <ul>
     *   <li><b>写入</b>：{@code UserService} 心跳写 {@code LocalDateTime.now()} —— 取的是 <b>JVM 时区</b>的墙钟；</li>
     *   <li><b>读取</b>：同一个类的在线判定写的是 {@code last_active_at > DATE_SUB(NOW(), ...)}
     *       —— {@code NOW()} 取的是 <b>MySQL 会话时区</b>的墙钟。</li>
     * </ul>
     * 两侧差 8 小时（Docker 官方 mysql 镜像默认 UTC，而国内服务器 JVM 常是 Asia/Shanghai）→
     * 要么全站永久离线，要么全站永久在线。
     * <p>
     * ★ 为什么是「改 JVM 默认时区」，而不是让 JDBC URL 去带 {@code serverTimezone} ★
     * {@code serverTimezone} 只影响驱动对 {@code java.util.Date} 的转换，
     * 而 {@code LocalDateTime} 是**无时区类型**，驱动原样发送、不做换算 —— 所以它救不了这条。
     * 真正要让两边对齐，只有「两侧是同一个时区」这一条路。
     * <p>
     * ★ 为什么用固定偏移（{@code +08:00}）而不是 {@code Asia/Shanghai} ★
     * MySQL 认 {@code SET time_zone='Asia/Shanghai'} 需要 {@code mysql.time_zone_name} 表有数据，
     * 而官方 mysql 镜像**默认没有导入时区表**，会直接报
     * {@code Unknown or incorrect time zone}。固定偏移不需要任何表，任何 MySQL 都认。
     * <p>
     * 两侧共用一个开关 {@code app.time-zone-offset}：
     * JVM 侧由本方法设为默认时区，MySQL 侧由 {@code application-prod.yml} 的
     * {@code spring.datasource.hikari.connection-init-sql} 在新连接上执行 {@code SET time_zone}。
     * ★ 只有一个开关 = 不可能"改了一边忘了另一边" ★（本项目反复踩的"改一处必扫全族"）。
     */
    private void normalizeTimeZone(ConfigurableEnvironment env) {
        String offset = env.getProperty(TIME_ZONE_OFFSET_KEY, DEFAULT_TIME_ZONE_OFFSET).trim();
        String zoneId = "GMT" + offset;
        TimeZone zone = TimeZone.getTimeZone(zoneId);
        // TimeZone.getTimeZone 对无法识别的输入会静默返回 GMT —— 这种"认不出就退回 UTC"
        // 正是本方法要消灭的那类失败，所以这里必须校验，不能让它悄悄变成 +00:00
        if (!zoneId.equals(zone.getID())) {
            throw reject("app.time-zone-offset 不是合法的 UTC 偏移",
                    "当前值：" + offset + "（解析结果退回了 " + zone.getID() + "，说明没被识别）",
                    "合法写法形如 +08:00 / -05:00 / +00:00。",
                    "注意：不要写 Asia/Shanghai 这类时区名 —— MySQL 侧 SET time_zone 在无时区表时会报错。");
        }
        TimeZone.setDefault(zone);
        notes.add("profile=prod：JVM 默认时区已钉为 " + zone.getID() + "（" + offset + "）；"
                + "MySQL 会话时区由 spring.datasource.hikari.connection-init-sql 同步设为同一偏移。");
    }

    // ==================================================================

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    private static IllegalStateException reject(String title, String... lines) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n====================================================================\n");
        sb.append(" [启动被拒绝] ").append(title).append("\n");
        sb.append("--------------------------------------------------------------------\n");
        for (String line : lines) {
            sb.append(' ').append(line).append('\n');
        }
        sb.append("====================================================================");
        // 不在这里 log：本阶段 SLF4J 的输出实测到不了控制台（见 flushNotes 的说明）。
        // 这段文案会作为异常消息由 Spring Boot 的启动失败报告完整打印出来，
        // 这正是部署时"为什么起不来"最需要看到的地方。
        return new IllegalStateException(sb.toString());
    }
}
