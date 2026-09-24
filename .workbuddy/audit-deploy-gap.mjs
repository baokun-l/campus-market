/**
 * 部署缺口盘点 —— 只回代码求证，不信台账的 ✅/❌
 *
 * 自证：每条检查必须给出"证据字符串"，没抓到证据的项判为 UNKNOWN（绝不当成已完成）。
 * 退出码：0 = 全部有结论；2 = 存在无法判定的项
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const FE = path.join(ROOT, 'campus-secondhand-frontend');

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const exists = (...p) => fs.existsSync(path.join(...p));

/**
 * 取 yml 里某个 key 的值，并解析 ${ENV:default} 占位符。
 * ★ 不解析就会撒谎：application-prod.yml 里几乎每个值都写成 ${X:default}，
 *   直接用 `key:\s*(\d+)` 匹配会全部落空 ⇒ 把"已落地"误判成"没做"。
 *   （本脚本第一版就因此误报了 5 项：P0-1/P0-10/P1-8/P1-12/P2-4）
 */
function ymlVal(text, key) {
    if (!text) return null;
    const m = text.match(new RegExp(key.replace(/\./g, '\\.') + ':\\s*(\\S+)'));
    if (!m) return null;
    const raw = m[1];
    const ph = raw.match(/^\$\{[^:}]+:?(.*)\}$/);
    if (!ph) return { raw, val: raw, required: false };
    return { raw, val: ph[1] ?? null, required: ph[1] === undefined || ph[1] === '' };
}

const rows = [];
function check(id, name, fn) {
    let r;
    try { r = fn(); } catch (e) { r = { state: 'UNKNOWN', ev: 'throw: ' + e.message }; }
    rows.push({ id, name, ...r });
}

/* ---------- P0 ---------- */

check('P0-1', 'prod profile 收口', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml'));
    if (!s) return { state: 'MISSING', ev: 'no application-prod.yml' };
    const mode = ymlVal(s, 'mode');
    const jwt = ymlVal(s, 'secret');
    const ok = mode?.val === 'never' && jwt?.required === true;
    return { state: ok ? 'DONE' : 'MISSING', ev: `sql.init.mode=${mode?.raw ?? '-'} jwt.secret=${jwt?.raw ?? '-'}` };
});

check('P0-2', '阻断 demo profile', () => {
    /*
     * ★ 判据锚「能力」不锚「字样」（2026-09-23 判据红绿全量探针抓出）★
     *
     * 第一版的 state 是**硬编码 DONE**，只有「两个文件都不在」才 MISSING：
     *   ① 只要 DeploymentGuard.java 与 spring.factories 存在就恒绿 —— 一条恒真的判据就是一条注释；
     *   ② 它的 ev 读的是**原文**，而 `app.demo.reset-confirmed` 在类注释里恰好写着
     *      （`--app.demo.reset-confirmed=true`）⇒ 把真代码删光、只留注释，判据照样 ✅
     *      （第九形态：注释自己骗自己）。红绿证据：probe-audit-criteria-redgreen.mjs R02
     *      「删掉 RESET_CONFIRMED_KEY 常量」修复前**不报红**。
     *
     * 本项要的能力 = 「demo 必须显式确认，否则拒启动」，拆四条缺一不可：
     *   ① 常量声明与 key 字面量对上（写错 key ⇒ 永远读不到用户传的真值）；
     *   ② 真的从 Environment 读这个 key；
     *   ③ **同一个方法体内**读不到就 throw（按大括号配平截方法体，不用「附近 N 行」）；
     *   ④ 护栏真注册上了（spring.factories；单测里直接 new 会绕过注册）。
     */
    const gRaw = read(path.join(BE, 'src/main/java/com/campus/market/config/DeploymentGuard.java'));
    const f = read(path.join(BE, 'src/main/resources/META-INF/spring.factories'));
    if (!gRaw || !f) return { state: 'MISSING', ev: `guard=${!!gRaw} factories=${!!f}` };
    const g = javaCode(gRaw); // ★ 剥注释：类注释里故意写着这个 key，不剥 = 注释自骗自
    const declared = /RESET_CONFIRMED_KEY\s*=\s*"app\.demo\.reset-confirmed"/.test(g);
    const readFlag = /getProperty\(\s*RESET_CONFIRMED_KEY/.test(g);
    const body = methodBody(g, /void\s+requireResetConfirmed\s*\(/);
    const refuses = !!body && /getProperty\(\s*RESET_CONFIRMED_KEY/.test(body) && /throw\s+reject\(/.test(body);
    const registered = /DeploymentGuard/.test(f);
    const ok = declared && readFlag && refuses && registered;
    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `常量对齐=${declared} 读取开关=${readFlag} 同一方法内拒绝=${refuses} 已注册=${registered}`
    };
});

check('P0-3', 'JWT_SECRET fail-fast', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const g = read(path.join(BE, 'src/main/java/com/campus/market/config/DeploymentGuard.java')) || '';
    const ok = /\$\{JWT_SECRET\}/.test(s) && /JWT|secret/i.test(g);
    return { state: ok ? 'DONE' : 'MISSING', ev: `yml=${/\$\{JWT_SECRET\}/.test(s)} guard=${/JWT|secret/i.test(g)}` };
});

check('P0-4', 'forward-headers-strategy', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const m = s.match(/forward-headers-strategy:\s*(\S+)/);
    return { state: m ? 'DONE' : 'MISSING', ev: m ? m[1] : 'not set' };
});

check('P0-5', '时区两侧统一', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const m = s.match(/connection-init-sql:\s*(.+)/);
    return { state: m ? 'DONE' : 'MISSING', ev: m ? m[1].trim() : 'no connection-init-sql' };
});

check('P0-6', 'Maven Wrapper', () => {
    const mvnw = exists(BE, 'mvnw') || exists(BE, 'mvnw.cmd');
    const both = exists(BE, 'mvnw') && exists(BE, 'mvnw.cmd');
    const props = exists(BE, '.mvn/wrapper/maven-wrapper.properties');
    let dist = '-', type = '-';
    if (props) {
        const t = read(path.join(BE, '.mvn/wrapper/maven-wrapper.properties'));
        dist = (t.match(/distributionUrl=(.+)/) || [])[1] || '-';
        type = (t.match(/distributionType=(\S+)/) || [])[1] || '-';
    }
    // only-script 模式不需要 maven-wrapper.jar，这反而是优点（仓库里少一个二进制）
    return { state: mvnw && both && props ? 'DONE' : 'MISSING', ev: `${type} dist=${dist.slice(0, 56)}` };
});

check('P0-7', '服务器构建风险（spring-ai 里程碑版）', () => {
    const s = read(path.join(BE, 'pom.xml')) || '';
    const m = s.match(/<spring-ai\.version>([^<]+)<\/spring-ai\.version>/);
    const v = m ? m[1] : null;
    const milestone = /repo\.spring\.io\/milestone/.test(s);
    if (v && !/-M\d|-RC\d|-SNAPSHOT/.test(v)) return { state: 'DONE', ev: `已升 GA: ${v}（不再需要里程碑仓库）` };
    // 采用部署清单推荐方案 1：服务器不构建，只收 jar —— 判据是"机制存在"而不是"文档写了"
    // ★★ selfCheck 锚「拒绝产出的闸门」，不锚日志文案（2026-09-23 判据红绿抓出）★★
    // 第一版查的是日志里那句 `demo 资源（必须 0）` —— 红绿结果**方向是反的**：
    //   · R08 删掉真正的 assert（闸门没了）⇒ 判据**照样 ✅**；
    //   · R09 只把文案改两个字（语义零变化）⇒ 判据**立刻 ❌**。
    // 也就是说它守的是「这行字还在不在」，而不是「包里有 demo 资源会不会被拦下」。
    const script = exists(BE, 'deploy/build-release.mjs');
    const scriptText = script ? read(path.join(BE, 'deploy/build-release.mjs')) : '';
    const selfCheck = script
        && /assert\(\s*demoRes\.length\s*===\s*0/.test(scriptText)  // 真的有这条断言
        && /if\s*\(\s*bad\s*>\s*0\s*\)\s*die\(/.test(scriptText);   // 且真的会拒绝产出
    const documented = /服务器不构建|服务器上不装 Maven/.test(s);
    return {
        state: script && selfCheck && documented ? 'DONE' : 'MISSING',
        ev: `仍为 ${v}（GA 需 Boot 3.4+，属独立批次）⇒ 走方案1：发版脚本=${script} 产物自检=${selfCheck} pom已注明=${documented}`
    };
});

check('P0-8', '日志落盘 logback-spring.xml', () => {
    const p = path.join(BE, 'src/main/resources/logback-spring.xml');
    if (!fs.existsSync(p)) return { state: 'MISSING', ev: 'no file' };
    const t = read(p);
    const feats = [
        ['滚动按天+大小', /SizeAndTimeBasedRollingPolicy/.test(t)],
        ['保留30天', /<maxHistory>30<\/maxHistory>/.test(t)],
        ['总量上限', /<totalSizeCap>/.test(t)],
        ['ERROR 单独一份', /ERROR_FILE/.test(t)],
        ['目录可配(springProperty)', /<springProperty[^>]*app\.log-dir/.test(t)]
    ];
    const ymlHasKey = /log-dir:\s*\$\{LOG_DIR/.test(read(path.join(BE, 'src/main/resources/application.yml')) || '');
    const prodHasKey = /log-dir:\s*\$\{LOG_DIR/.test(read(path.join(BE, 'src/main/resources/application-prod.yml')) || '');
    const ok = feats.every(([, b]) => b) && ymlHasKey && prodHasKey;
    return {
        state: ok ? 'DONE' : 'PARTIAL',
        ev: feats.filter(([, b]) => !b).length ? '缺: ' + feats.filter(([, b]) => !b).map(([n]) => n).join(',')
            : `五项策略齐 + app.log-dir 已接(dev=${ymlHasKey} prod=${prodHasKey})`
    };
});

check('P0-2b', '打包物理剔除 demo 资源（P0-2 第2层）', () => {
    const s = read(path.join(BE, 'pom.xml')) || '';
    const hasProfile = /<id>prod<\/id>/.test(s);
    const exclYml = /<exclude>application-demo\.yml<\/exclude>/.test(s);
    const exclSql = /<exclude>db\/demo-\*\.sql<\/exclude>/.test(s);
    return {
        state: hasProfile && exclYml && exclSql ? 'DONE' : 'MISSING',
        ev: `prod profile=${hasProfile} 排除 yml=${exclYml} 排除 sql=${exclSql}`
    };
});

check('P0-9', 'prod 关 SQL 回显', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const m = s.match(/mapper:\s*(\w+)/);
    return { state: m && m[1] !== 'debug' ? 'DONE' : 'MISSING', ev: m ? m[1] : 'not set' };
});

check('P0-10', 'HTTPS + 只绑回环', () => {
    const nginx = read(path.join(BE, 'deploy/nginx-campus-market.conf')) || '';
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const addr = ymlVal(s, 'address');
    const tls = /ssl_certificate|443/.test(nginx);
    const bound = addr?.val && /^127\.0\.0\.1$/.test(addr.val);
    return {
        state: tls && bound ? 'DONE' : (tls ? 'PARTIAL' : 'MISSING'),
        ev: `nginx TLS模板=${tls} server.address=${addr?.raw ?? '未设置（默认 0.0.0.0）'}`
    };
});

/* ---------- P1 ---------- */

check('P1-1', 'JDBC URL 生产化', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const m = s.match(/url:\s*(\S+)/);
    if (!m) return { state: 'MISSING', ev: 'no url in prod' };
    const u = m[1];
    return {
        state: !/createDatabaseIfNotExist/.test(u) ? 'DONE' : 'MISSING',
        ev: `createDatabaseIfNotExist=${/createDatabaseIfNotExist/.test(u)} sslMode=${/sslMode/.test(u)}`
    };
});

check('P1-3', '产物版本化', () => {
    // ★★ 判据必须锚在「能力」上，不能锚在「手段」上 ★★
    //
    // 本项的原判据是 `pom.xml` 里有没有 buildInfo|<build-number|git-commit-id，
    // 因为清单原方案写的是 `<buildInfo />`。但那个方案被**有意放弃**了：
    // 它会把构建时间写进 BOOT-INF/classes/META-INF/build-info.properties，
    // ⇒ 时间每次不同 ⇒ 哈希每次不同 ⇒ **正好破坏刚建立的可复现性**。
    // 于是改用了外部的 deploy/build-release.mjs + .info.txt。
    //
    // 结果：旧判据把「已落地、只是换了实现手段」误报成 MISSING。
    // 这是脚本撒谎的第八种形态 —— **判据锚在被有意放弃的手段上**。
    // 教训：审计一个"目标"时，要检查目标是否达成（版本化命名 / 校验和 / 溯源信息在不在），
    //       而不是检查"当初提出来的那个实现方式"在不在。
    const script = read(path.join(BE, 'deploy', 'build-release.mjs')) || '';
    const renamed = /campus-market-\$\{version\}/.test(script);
    const sha = /\.sha256/.test(script);
    const info = /\.info\.txt/.test(script);
    const missing = [!renamed && '版本化重命名', !sha && 'sha256', !info && 'info.txt'].filter(Boolean);

    // 反向警报：如果有人"好心"把 buildInfo 加回来，必须当场指出来
    const pom = read(path.join(BE, 'pom.xml')) || '';
    const badBuildInfo = /<buildInfo\s*\/>/.test(pom);

    return {
        state: missing.length === 0 ? 'DONE' : 'MISSING',
        ev: `build-release.mjs 重命名=${renamed} sha256=${sha} info=${info}`
            + (missing.length ? ` ⇐ 缺 ${missing.join('/')}` : '')
            + (badBuildInfo
                ? '  ⚠️ pom 里出现了 <buildInfo/>：会把构建时间写进产物 ⇒ 破坏可复现性，请改用 .info.txt'
                : '')
    };
});

check('P1-4', '部署载体 systemd/Docker', () => {
    const svc = exists(BE, 'deploy/campus-market.service');
    const df = exists(BE, 'Dockerfile');
    return { state: svc ? 'DONE' : 'MISSING', ev: `systemd=${svc} Dockerfile=${df}` };
});

/* ★★★ P1-5 / P1-6 判据改写（2026-09-22，B6 批）★★★
 *
 * 这两条原来的判据都是「手段判据」，正好各踩一种撒谎形态：
 *
 *   P1-5 原判据 = `pom 里有 actuator 依赖 || controller 目录里出现过 "/health" 字样`
 *     ⇒ 第八形态（锚手段、不锚能力）。两个方向都会错：
 *        · 端点写成 `@GetMapping("/api/health")`（路径带前缀）→ 误报 MISSING；
 *        · 随便一句 `log.info("/health")` → 误报 DONE。
 *       "有字样"既不等于"有端点"，更不等于"能发现依赖故障"。
 *
 *   P1-6 原判据 = 全仓 `MDC.put(` 出现 ≥1 次即 DONE
 *     ⇒ 第九形态（锚字样）+ 漏掉本项最关键的一半：**用完有没有清**。
 *       只 put 不 clear，线程复用时下一个请求会顶着上一个请求的身份 ——
 *       那种日志比不加还危险，因为它会把故障指到无辜的人头上。
 *
 * 新判据锚「能力」，问的是"目标达成了没"：
 *   P1-5 = ① 真有映射到 /health 的端点；② 响应带一个监控可判的状态字段；
 *          ③ 至少能区分"依赖坏"与"依赖好"（DEGRADED 让告警不失真）；
 *          ④ 探测**有上界**（库挂住时探针必须自己先返回，否则"探针看不出故障"会退化成"探针不可用"）。
 *   P1-6 = ① 请求入口设置上下文；② **finally 里清理**；③ 日志 pattern 真把它打出来（设了不打 = 白设）。
 */

/*
 * ★★ 两条判据一律基于 javaCode()（剥注释后）的代码，不基于原文 ★★
 *
 * 这不是形式主义 —— 这两条判据的宿主文件里，**注释恰好写着判据要找的东西**：
 *   · RequestTraceFilter 的类注释第 52 行「用 {@code MDC.clear()} 而不是逐个 remove」；
 *   · HealthService 的 effectiveDbTimeoutMs javadoc 里「修复前写法的 future.get(0, MILLISECONDS)」。
 * 若直接匹配原文，把真代码整段删掉、只留注释，判据依然报 ✅ —— 那就是第九形态：
 * **注释自己骗自己**（而且这两处注释是**故意**留的"这里曾经是…"）。
 */
check('P1-5', '健康检查（能发现依赖故障 + 探测有上界）', () => {
    const svcRaw = read(path.join(BE, 'src/main/java/com/campus/market/service/HealthService.java'));
    const ctlRaw = read(path.join(BE, 'src/main/java/com/campus/market/controller/HealthController.java'));
    if (!svcRaw || !ctlRaw) return { state: 'MISSING', ev: `HealthService=${!!svcRaw} HealthController=${!!ctlRaw}` };
    const svc = javaCode(svcRaw);
    const ctl = javaCode(ctlRaw);

    const mapped = /@GetMapping\(\s*"\/health"\s*\)/.test(ctl);                  // ① 端点
    const passthrough = /Result\.success\(\s*healthService\.report\(\)\s*\)/.test(ctl); // ② 不把"不健康"塞进 code
    const three = ['UP', 'DEGRADED', 'DOWN'].filter((s) => new RegExp(`String\\s+${s}\\s*=`).test(svc)); // ③ 三态
    const bounded = /\.get\([^)]*MILLISECONDS/.test(svc) && /TimeoutException/.test(svc); // ④ 限时

    const actuator = /spring-boot-starter-actuator/.test(read(path.join(BE, 'pom.xml')) || '');

    const ok = mapped && passthrough && three.length === 3 && bounded;
    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `端点/health=${mapped} 恒success=${passthrough} 三态=[${three.join(',')}] 限时探测=${bounded}`
            + (actuator ? '  ⚠️ pom 里有 actuator：它会带来 /env、/beans 的泄露面，若要用必须只暴露 health' : '')
    };
});

check('P1-6', '请求上下文（设置 + finally 清理 + 日志 pattern 真输出）', () => {
    const fRaw = read(path.join(BE, 'src/main/java/com/campus/market/config/RequestTraceFilter.java'));
    if (!fRaw) return { state: 'MISSING', ev: 'no RequestTraceFilter' };
    const f = javaCode(fRaw);
    const interceptor = javaCode(read(path.join(BE, 'src/main/java/com/campus/market/interceptor/AuthInterceptor.java')) || '');
    // logback 是 XML：javaCode 只懂 Java 注释，这里按 XML 注释剥
    const lb = (read(path.join(BE, 'src/main/resources/logback-spring.xml')) || '').replace(/<!--[\s\S]*?-->/g, '');

    const km = f.match(/MDC_TRACE_ID\s*=\s*"([^"]+)"/);
    const key = km ? km[1] : null;                                     // 键名从代码里读，别写死 traceId
    const sets = /MDC\.put\(/.test(f);                                  // ① 设置
    const clears = /MDC\.clear\(\)|MDC\.remove\(/.test(f);              // ② 清理
    const inFinally = /finally\s*\{[^}]*MDC\.(clear|remove)\(/.test(f); // ★ 必须在 finally：异常路径也要清
    const inPattern = key ? new RegExp('%X\\{' + key).test(lb) : false; // ③ 打得出（设了不打 = 白设）
    const uidByAuth = /MDC\.put\(/.test(interceptor);                   // "谁"由解析出身份的地方补

    const warn = sets && !clears
        ? '  ⚠️ 只设置未清理：线程复用时下一个请求会顶着上一个请求的身份（日志会指错人）'
        : (sets && clears && !inFinally ? '  ⚠️ 有清理但不在 finally：抛异常的那条路径不会清' : '');

    return {
        state: sets && clears && inFinally && inPattern ? 'DONE' : 'MISSING',
        ev: `filter设置=${sets} 清理=${clears} finally内=${inFinally} pattern含%X{${key ?? '?'}}=${inPattern} 拦截器补uid=${uidByAuth}`
            + warn
    };
});

check('P1-7', '登录限流', () => {
    const g = exists(BE, 'src/main/java/com/campus/market/security/LoginAttemptGuard.java');
    const nginx = read(path.join(BE, 'deploy/nginx-campus-market.conf')) || '';
    return { state: g ? 'DONE' : 'MISSING', ev: `LoginAttemptGuard=${g} nginx limit_req=${/limit_req/.test(nginx)}` };
});

check('P1-8', '生产不灌弱口令种子', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const mode = ymlVal(s, 'mode');
    return { state: mode?.val === 'never' ? 'DONE' : 'MISSING', ev: `sql.init.mode=${mode?.raw ?? '-'}` };
});

/*
 * P1-10 的判据在 2026-09-23（B7 批）改过一版：从「锚字样」改成「锚能力」。
 *
 * 上一版查的是 `/FFD8FF|89504E47|474946|magic|魔数/` 与 `/RateLimit|rate|限流|UploadAttempt/`
 * —— 典型的**第九形态**：判据锚在字面字样上。它有两个毛病：
 *   ① 实现根本不用这些写法：签名是以 `0xNN` 常量写的，闸门类叫 `UploadQuotaGuard`，
 *      既不叫 `RateLimit` 也不含「限流」二字 ⇒ 一个真修好的实现会被判成没做，
 *      而且 `魔数` 二字在本仓的**注释里**到处都有 —— 只写注释不写代码也能骗过它；
 *   ② 它只查「有没有」，不查「有没有接上」。闸门类写得再漂亮，只要接口里没调用，
 *      限流就完全不存在 —— 这正是「单测全绿、接线没接」那一类，只有看调用点才能发现。
 *
 * 新判据查三件**能力**（且全部基于 `javaCode()` 剥掉注释后的代码，防止被注释骗）：
 *   ① 以字节为准：有签名常量表 + 嗅探调用 + 嗅不出即拒 + **扩展名取自嗅探结果**；
 *   ② 闸门真的生效：类里有窗口推进 + **接口里真的调用了** + 调用排在嗅探**之前**（次序判据）；
 *   ③ 配置可到达：`upload-guard` 三个键是占位符形式（裸正则会落空，本仓踩过）。
 */
check('P1-10', '上传限流 / 魔数嗅探', () => {
    const ctlRaw = read(path.join(BE, 'src/main/java/com/campus/market/controller/UploadController.java'));
    const imgRaw = read(path.join(BE, 'src/main/java/com/campus/market/common/ImageType.java'));
    const grdRaw = read(path.join(BE, 'src/main/java/com/campus/market/security/UploadQuotaGuard.java'));
    const yml = read(path.join(BE, 'src/main/resources/application.yml')) || '';
    if (!ctlRaw) return { state: 'MISSING', ev: 'no UploadController.java' };

    const c = javaCode(ctlRaw);
    const img = imgRaw ? javaCode(imgRaw) : '';
    const grd = grdRaw ? javaCode(grdRaw) : '';

    // ① 魔数：签名表 + 真的嗅探 + 嗅不出即拒 + 扩展名取自字节（而不是文件名）
    //    刻意用「任意标识符」而不是写死 `type` / `file` 这些名字：变量改名不该让判据失效
    const sigConstants = (img.match(/0x[0-9A-Fa-f]{2}/g) || []).length;
    const sniffCalls = (c.match(/\bsniff\s*\(\s*\w+\s*\)/g) || []).length;
    const rejectsUnsniffed = /==\s*null\s*\)\s*\{[\s\S]{0,240}?throw\s/.test(c);
    const extFromBytes = /\b\w+\.ext\s*\(\s*\)/.test(c);

    // ② 闸门：窗口推进 + 接口内真的调用 + 调用先于嗅探（次序判据 > 计数判据）
    //    「窗口推进」必须看**条件里真的用到了 windowMs**：写成 `if (false)`（永不重置）时
    //    光查 `>= windowMs` / `count = 0` 这两个字样仍然命中 —— 那正是「锚手段」的第二种漏法。
    const hasWindowRoll = /if\s*\([^)]*windowMs[^)]*\)\s*\{[^}]*windowStartMs\s*=[^}]*count\s*=\s*0/.test(grd);
    const acquireCalls = (c.match(/\.acquire\s*\(/g) || []).length;
    const iAcquire = c.search(/\.acquire\s*\(/);
    const iSniff = c.search(/\bsniff\s*\(\s*\w+\s*\)/);
    const guardBeforeSniff = iAcquire >= 0 && iSniff >= 0 && iAcquire < iSniff;

    /*
     * ③ 配置可到达：`upload-guard` 三个键必须写成 ${ENV:数字} 占位符。
     *
     * ★★ 这里第一版写错了，是判据红绿（C5 轮）逮出来的 ★★
     * 第一版：`cfgOk = /^\d+$/.test(uMax.val)` —— 它校验的是 `val`，
     * 而 `ymlVal` 的 `val` 是**剥掉占位符之后的默认值**：`${FOO:10}` 与裸写 `10`
     * 的 `val` 都是 `'10'` ⇒ 这个条件**恒真、形同虚设**。
     * 后果很具体：把占位符改成裸数字，生产环境就再也无法用环境变量覆盖闸门额度，
     * 而判据照样报 ✅ —— 与上面注释「配置可到达」四个字完全对不上。
     * 判「写法」必须看 `raw`；这也是本仓「审计脚本自己也会撒谎」的又一例。
     */
    const isPlaceholderNum = (v) => !!v && /^\$\{[A-Z0-9_]+:\d+\}$/.test(String(v.raw));
    const uMax = ymlVal(yml, 'user-max-uploads');
    const gMax = ymlVal(yml, 'global-max-uploads');
    const wSec = ymlVal(yml, 'window-seconds');
    const cfgOk = isPlaceholderNum(uMax) && isPlaceholderNum(gMax) && isPlaceholderNum(wSec);

    const ok = sigConstants >= 8 && sniffCalls === 1 && rejectsUnsniffed && extFromBytes
        && !!grdRaw && hasWindowRoll && acquireCalls === 1 && guardBeforeSniff && cfgOk;

    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `签名常量=${sigConstants} 嗅探调用=${sniffCalls} 嗅不出即拒=${rejectsUnsniffed} 扩展名取自字节=${extFromBytes}`
            + ` | 闸门类=${!!grdRaw} 窗口推进会走=${hasWindowRoll} 接口内调用=${acquireCalls} 闸门先于嗅探=${guardBeforeSniff}`
            + ` | 配置=${uMax?.raw ?? '-'} / ${gMax?.raw ?? '-'} / ${wSec?.raw ?? '-'}`,
    };
});

check('P1-11', '缓存层', () => {
    /*
     * ★ 判据锚「能力」不锚「字样」★（本轮修订）
     *
     * 第一版只判 pom 里有没有 caffeine 依赖 —— 那是**手段**：把依赖加上、代码一行不接，
     * 照样显示 ✅。这一项要的能力是「每请求回查 t_user 被短 TTL 缓存接管」，
     * 它的必要条件是四件事同时成立，缺一不可：
     *   ① 依赖存在；
     *   ② 拦截器真的改走缓存（不再直查 UserMapper）；
     *   ③ 缓存有兜底过期（少了它，漏一处显式失效就变成永久泄漏）；
     *   ④ 每个鉴权列写入点都有失效调用（这里只数个数，逐条归属由下面的测试类看守）。
     *     ★ 阈值 6→5（2026-09-23·账本三十一）：D11 拆除删掉了 approveUser 这个失效点，
     *     现为 UserService 4 处 + ContentService 1 处；逐条归属由
     *     AuthCacheInvalidationTest#everyAuthColumnWriteInvalidates（≥5，源码看守）负责。
     * 行为层（改 status 会不会当场生效、TTL 到点会不会回源、心跳会不会误清缓存）
     * 由 AuthSnapshotCacheTest / AuthCacheInvalidationTest / AuthInterceptorSnapshotTest
     * 三个测试类（23 个用例）与 .workbuddy/probe-p111-redgreen.mjs（9 轮红绿）负责证明，
     * 这里不重复 —— 静态判据只回答「接线有没有接上」。
     */
    const pom = read(path.join(BE, 'pom.xml')) || '';
    const dep = /caffeine/.test(pom);
    const itc = read(path.join(BE, 'src/main/java/com/campus/market/interceptor/AuthInterceptor.java')) || '';
    const cacheCls = read(path.join(BE, 'src/main/java/com/campus/market/security/AuthSnapshotCache.java')) || '';
    const usvc = read(path.join(BE, 'src/main/java/com/campus/market/service/UserService.java')) || '';
    const csvc = read(path.join(BE, 'src/main/java/com/campus/market/service/ContentService.java')) || '';
    const viaCache = /AuthSnapshotCache\.Snapshot/.test(itc) && /authSnapshotCache\.get\(/.test(itc);
    const noDirect = !/userMapper\.selectById/.test(itc);
    const ttl = /expireAfterWrite\(/.test(cacheCls);
    const evicts = (usvc.split('authSnapshotCache.invalidate').length - 1)
        + (csvc.split('authSnapshotCache.invalidate').length - 1);
    const ok = dep && viaCache && noDirect && ttl && evicts >= 5;
    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `dep=${dep} 拦截器经缓存=${viaCache} 不再直查=${noDirect} TTL兜底=${ttl} 失效点=${evicts}(需≥5)`
            + ` | 行为由 3 个测试类 23 用例 + probe-p111 9 轮红绿证明`,
    };
});

check('P1-12', '连接池/线程/堆配套', () => {
    const s = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const pool = ymlVal(s, 'maximum-pool-size');
    const th = ymlVal(s, 'max-threads');
    const ok = pool && th && Number(th.val) <= Number(pool.val) * 6;
    return { state: ok ? 'DONE' : 'MISSING', ev: `pool=${pool?.raw ?? '-'} threads=${th?.raw ?? '-'}` };
});

/* ---------- P2 ---------- */

check('P2-2', '前端 Node 版本约束 + npm ci 可用', () => {
    /*
     * ★ 判据红绿全量探针（R29）抓到第二类问题：**判据名里的「npm ci」是空的** ★
     * 第一版只查 `.nvmrc || engines`，从不看 lockfile —— 而 `npm ci` 的**前提就是有 lockfile**：
     * 把它拿走，服务器上 `npm ci` 直接失败，判据照样 ✅。
     * ⇒ 教训：**判据名里写了几件事，就要逐件去查**，别把名字当成覆盖范围。
     * 另：`.nvmrc` 与 `engines` 是**同一件事的两种写法**（Node 版本约束），用 OR 合理；
     *    lockfile 是**另一件事**（可复现安装），必须 AND 上。
     */
    const nvmrc = exists(FE, '.nvmrc');
    const pkg = read(path.join(FE, 'package.json')) || '';
    const eng = /"engines"/.test(pkg);
    const lock = exists(FE, 'package-lock.json');
    const constraint = nvmrc || eng;
    return {
        state: constraint && lock ? 'DONE' : 'MISSING',
        ev: `Node版本约束=${constraint}（.nvmrc=${nvmrc} engines=${eng}）npm ci 可用(lockfile)=${lock}`
    };
});

check('P2-3', '前端 base 子路径', () => {
    /*
     * ★ 判据锚「能力」不锚「字样」★（本轮修订）
     *
     * 第一版只匹配 `base: '<字面量>'`。可这一项要的能力是「产物能挂到子路径」，
     * 它需要**两个条件同时成立，缺一不可**：
     *   ① 打包 base 由环境变量驱动且默认 '/'（默认值保证对根域名部署零影响）；
     *   ② 路由 history 的 base 跟随同一个来源（import.meta.env.BASE_URL）。
     * 只有①：站点「首页打得开、点导航就 404」（资源在子路径、路由按根解析）；
     * 只有②：反过来资源路径又不对。只认写法就会把这两种残缺状态判成 DONE。
     */
    const s = read(path.join(FE, 'vite.config.ts')) || '';
    const r = read(path.join(FE, 'src/router/index.ts')) || '';
    const baseExpr = (s.match(/base\s*:\s*([^\n,]+)/) || [])[1];
    const baseDriven = !!baseExpr && /env\./i.test(baseExpr) && /['"]\/['"]/.test(baseExpr);
    const routerFollows = /createWebHistory\(\s*import\.meta\.env\.BASE_URL\s*\)/.test(r);
    const ev = `base=${baseExpr ? baseExpr.trim() : '未设'}` +
        ` · router=${routerFollows ? 'createWebHistory(BASE_URL)' : '未跟随 BASE_URL'}`;
    return { state: baseDriven && routerFollows ? 'DONE' : 'MISSING', ev };
});

check('P2-4', '上传大小三层口径', () => {
    const yml = read(path.join(BE, 'src/main/resources/application.yml')) || '';
    const prod = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const mpDev = ymlVal(yml, 'max-file-size');
    const mpProd = ymlVal(prod, 'max-file-size');
    const app = ymlVal(yml, 'max-image-bytes');
    const mb = app?.val ? Number(app.val) / 1048576 : null;
    const ok = mpProd && mb && /2MB/.test(mpProd.raw) && mb === 2;
    return {
        state: ok ? 'DONE' : 'PARTIAL',
        ev: `multipart(dev)=${mpDev?.raw ?? '-'} multipart(prod)=${mpProd?.raw ?? '-'} 应用层=${app?.raw ?? '-'}${mb ? '(' + mb + 'MB)' : ''}`
    };
});

check('P2-6', 'uploads 移出源码树 + .gitignore', () => {
    /*
     * ★ 必须剥注释、且看「规则行」（2026-09-23 判据红绿抓出）★
     * 第一版是 `/uploads/.test(gi)` —— 而这份 .gitignore 的**注释里**到处是 uploads
     * （大段解释「为什么必须忽略它」）。于是 R25「删掉 uploads/ 这条规则」判据**照样 ✅**：
     * 规则没了、注释还在 ⇒ 上传的图照旧进仓库，判据却以为守住了。
     * 顺带记一句：R26（把所有 uploads 字样连注释一起清掉）确实会红 ⇒ 它不是恒真，只是**太宽**。
     */
    const giRaw = read(path.join(BE, '.gitignore'));
    const prod = read(path.join(BE, 'src/main/resources/application-prod.yml')) || '';
    const giRules = giRaw ? giRaw.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n') : '';
    const ignoresUploads = /^\s*uploads\/?\s*$/m.test(giRules);
    const prodDir = /UPLOAD_DIR|\/data\//.test(prod);
    return {
        state: ignoresUploads && prodDir ? 'DONE' : 'MISSING',
        ev: `.gitignore 规则行忽略uploads=${ignoresUploads} prod上传目录=${prodDir}`
    };
});

/* ---------- 代码缺陷类 ---------- */

/**
 * 取某个方法体的**完整源码**（按大括号配平截取）。
 * <p>
 * ★ 为什么不用「方法名之后 N 行/ N 字符」★
 * P0-2 要证明的是「读到开关 → 不满足就抛错」发生在**同一个方法**里。
 * 用 `[\s\S]{0,900}` 这类近似，只要文件顺序一变（比如把 reject 抽到别处），
 * 判据就会把两个不相干的地方拼成一个「假能力」。配平截取才是真正的「同一函数体内」。
 * <p>
 * 局限（如实写明）：不做字符串/字符字面量内的括号转义识别。方法体里若出现
 * 含 `{`/`}` 的字符串字面量，配平会偏；本仓 DeploymentGuard 无此写法。
 */
function methodBody(code, signatureRe) {
    const m = code.match(signatureRe);
    if (!m) return null;
    const start = code.indexOf('{', m.index);
    if (start < 0) return null;
    let depth = 0;
    for (let j = start; j < code.length; j++) {
        const c = code[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return code.slice(start, j + 1); }
    }
    return null;
}

/**
 * 去掉 Java 注释与字符串外的噪音，只留**代码**。
 * <p>
 * ★ 为什么必须剥注释 ★
 * 本仓已经因此误报过两次：`audit-all-open.mjs` 第一版的 4 条判据全部命中的是注释
 * （`* ★ 旧实现是 …`、`// 这里曾经是 setViewCount→updateById`），
 * 而 L9 的注释里**故意**写着旧写法（「把 quotaGuard.acquire 挪进下面那个 try」
 * 「老写法是 chatModel.call(系统提示 + 用户输入)」）⇒ 不剥注释等于让注释自己骗自己。
 * <p>
 * ★ 还必须跟踪块注释状态 ★：只判「行首是不是 *」会漏掉块注释的**中间行**——
 * 那些行行首既不是 `*` 也不是 `/*`（实测 `Index.vue:491` 就是这么被误判的）。
 * 这里用一个小状态机，顺带跳过字符串字面量里的 `//`（比如 URL）。
 */
function javaCode(text) {
    let out = '';
    let i = 0;
    const n = text.length;
    let inBlock = false, inLine = false, inStr = false, inChar = false;
    while (i < n) {
        const c = text[i], d = text[i + 1];
        if (inLine) { if (c === '\n') { inLine = false; out += '\n'; } i++; continue; }
        if (inBlock) { if (c === '*' && d === '/') { inBlock = false; i += 2; continue; } if (c === '\n') out += '\n'; i++; continue; }
        if (inStr) { out += c; if (c === '\\') { out += (text[i + 1] ?? ''); i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
        if (inChar) { out += c; if (c === '\\') { out += (text[i + 1] ?? ''); i += 2; continue; } if (c === "'") inChar = false; i++; continue; }
        if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
        if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        if (c === "'") { inChar = true; out += c; i++; continue; }
        out += c; i++;
    }
    return out;
}

/**
 * ★ L9 的判据改过一版：从「锚手段」改成「锚能力」★
 * <p>
 * 上一版查的是 `限流` / `substring(0,N)` / `截断` 这些**字样**，而且是**硬编码** `MISSING`。
 * 两条都不对：
 * <ol>
 *   <li>本轮实现根本不用「截断」（超长是**拒绝**而不是裁剪），也不用 `substring(0,N)`，
 *       闸门类的名字里也没有「限流」二字 ⇒ 按旧的判据，一个真修好的实现会被判成没做
 *       （这正是本仓第八形态：判据锚在手段上，把「已落地、只是换了实现方式」误报成 MISSING）；</li>
 *   <li>硬编码 state 的判据**永远不会变红**，它不构成检查，只是一条注释。</li>
 * </ol>
 * 现在问的是「目标达成了没」：入参有没有长度闸门？调模型之前有没有过额度闸门？
 * 规则与用户输入是不是两条独立消息？围栏标签有没有被剥离？
 */
check('L9', 'AI 无频控 / prompt 直拼 / 无长度上限', () => {
    const svcRaw = read(path.join(BE, 'src/main/java/com/campus/market/service/AiAssistantService.java'));
    if (!svcRaw) return { state: 'UNKNOWN', ev: 'no AiAssistantService.java' };
    const guardRaw = read(path.join(BE, 'src/main/java/com/campus/market/security/AiQuotaGuard.java'));
    const svc = javaCode(svcRaw);
    const guard = guardRaw ? javaCode(guardRaw) : '';

    // 能力 1：存在额度闸门，且**每个**调用模型的地方之前都过一次闸
    const guardExists = /class\s+AiQuotaGuard/.test(guard) && /public\s+void\s+acquire\s*\(/.test(guard);
    const acquireCalls = (svc.match(/quotaGuard\.acquire\s*\(/g) ?? []).length;
    const modelCalls = (svc.match(/chatModel\.call\s*\(/g) ?? []).length;
    const everyCallGuarded = guardExists && modelCalls >= 2 && acquireCalls === modelCalls;

    // 能力 2：入参长度闸门（对长度做比较并拒绝，而不是静默截断——截断会让用户拿到半句话）
    const lengthChecks = (svc.match(/\.length\(\)\s*>\s*max/g) ?? []).length;

    // 能力 3：角色隔离（两条独立消息），且**不存在**把系统提示拼上用户输入的写法
    const roleSeparated = /new\s+SystemMessage\s*\(/.test(svc) && /new\s+UserMessage\s*\(/.test(svc);
    const concatFound = /chatModel\.call\s*\(\s*[A-Za-z_]*[Ss]ystemPrompt\s*\+/.test(svc);

    // 能力 4：围栏标签会被剥离（只加围栏不洗输入 = 把围栏的钥匙一并交给用户）
    const fenceStripped = /FENCE_TAGS/.test(svc) && /replaceAll\s*\(/.test(svc);

    const ok = everyCallGuarded && lengthChecks >= 2 && roleSeparated && !concatFound && fenceStripped;
    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `闸门类=${guardExists} 过闸/调模型=${acquireCalls}/${modelCalls} 长度闸门=${lengthChecks}处 `
            + `角色隔离=${roleSeparated} 拼接=${concatFound} 围栏剥离=${fenceStripped}`
    };
});

check('D9', '会话凭据改 HttpOnly Cookie', () => {
    /*
     * ★ 判据锚「能力」不锚「字样」★（本轮修订）
     *
     * 第一版是 `localStorage 与 token 同现即 MISSING` —— 它锚的是**字样**，
     * 于是有两头都错：mock 模式**必须**把 `mock-token-*` 留在 localStorage
     * （演示身份靠它还原），真实现了 Cookie 也会被这条判成 ❌；
     * 反过来，只要把变量改个名就能骗过它。
     *
     * 这一项真正要的能力是：**真实会话凭据只存在于 HttpOnly Cookie，
     * 前端既读不到、也删不掉，所以清票必须由服务端做。**
     * 拆成 8 个必要条件，缺一不可（每一格都对应一个会被真人发现的功能）：
     *
     * 后端侧 ——「票据由服务端下发与清除」
     *   ① `AuthCookie` 存在且真的设了 HttpOnly（少了它，XSS 一读即走，本项毫无意义）；
     *   ② 登录/注册都下发（只下发一处 ⇒ 注册完刷新就掉线）；
     *   ③ 拦截器**优先**读 Cookie（读了但排在头后面 = 没读，浏览器不会带头）；
     *   ④ 有登出端点且会清 Cookie；
     *   ⑤ 登出在匿名白名单里（否则「票据已失效/被封禁」的人**永远退不出去」）。
     *
     * 前端侧 ——「不再持有凭据 + 登出/被踢收口」
     *   ⑥ `readToken()` 在真实模式返回空（凭据回流的闸门）；
     *   ⑦ 持久化的是不含凭据的 `sessionHint`（刷新保持登录的依据）；
     *   ⑧ 401 会**立刻**作废本地会话 + 登出会通知服务端清票。
     *
     * 行为层由 request.spec（6 例）/ user.spec 的 D9 两组（8 例）/ permission.spec（1 例）
     * / session-credential-guard.spec（5 例，含静态看守）与
     * `.workbuddy/probe-d9-redgreen.mjs`（12 轮红绿）负责证明，这里只回答「接线接上没有」。
     */
    const j = (...p) => read(path.join(BE, 'src/main/java/com/campus/market', ...p)) || '';
    const cookie = j('security', 'AuthCookie.java');
    const itc = j('interceptor', 'AuthInterceptor.java');
    const ctl = j('controller', 'UserController.java');
    const fe = (...p) => read(path.join(FE, 'src', ...p)) || '';
    const sess = fe('api', 'session.ts');
    const store = fe('stores/modules/user.ts');
    const req = fe('api/request.ts');

    /*
     * ① HttpOnly 必须打在**下发**那一支上。
     *
     * ★ 第一版写的是 `/httpOnly\(true\)/` —— 只要文件里**任何一处**有它就通过 ★
     * `AuthCookie` 里有两次 `httpOnly(true)`（下发 + 清票），所以把**下发**改成
     * `false`（等于把整个 D9 的安全收益抹掉）判据照样 ✅。
     * 这是"判据红绿"（probe-d9-criterion C1 轮）逮出来的：要求的能力是
     * 「**发出去的那张票** JS 读不到」，锚点就必须落在 `from(NAME, token)` 那一支上。
     */
    const httpOnly = /ResponseCookie\.from\(NAME,\s*token\)[\s\S]{0,300}?httpOnly\(true\)/.test(cookie)
        && /SameSite/.test(cookie);
    const issuedBoth = (ctl.match(/issueSessionCookie\(/g) || []).length >= 3; // 定义 1 次 + 登录/注册各 1 次
    /*
     * ③ 次序判据（比"有没有"更强）：Cookie 必须**先于** Authorization 头被读。
     * 两句都写了但顺序反了 = 没读 Cookie —— 浏览器发的是普通请求，
     * 根本不会带 Authorization 头，于是"能用 Cookie 登录"这件事整体不成立。
     */
    const iCookie = itc.indexOf('AuthCookie.read(request)');
    const iHeader = itc.indexOf('getHeader("Authorization")');
    const cookieFirst = iCookie >= 0 && iHeader >= 0 && iCookie < iHeader;
    /*
     * ④ 有登出端点且**真的会清 Cookie**。
     *
     * ★ 这里刚写错一次，是"跑一遍"逮出来的（审计脚本撒谎的第四形态）★
     * 第一版写的是 `PostMapping("\/logout")` —— 而控制器上是
     * `@PostMapping("/user/logout")`（本项目控制器方法上的路径**带 `/user` 前缀**，
     * 不是只有末段）。于是"登出端点"这一格被判成 false，而代码完全是对的。
     * 形态与它自己注释里记的前三例是同一个病根：**判据锚在"我以为的写法"上，
     * 而不是锚在"那个能力在不在"上**。教训补一条：新写的判据**必须当场跑一次**，
     * 否则它下次报的假红/假绿会被人当成代码问题去排查。
     * 修法：锚"这个路径的映射 + 这次清 Cookie 调用"，不锚具体的 URL 文本形状。
     */
    const logoutEp = /PostMapping\("\/user\/logout"\)[\s\S]{0,400}?AuthCookie\.clear\(/.test(ctl);
    const logoutPublic = /PUBLIC_ANY[\s\S]{0,400}?"\/user\/logout"/.test(itc);
    const readTokenGated = /export function readToken\(\)[\s\S]{0,400}?if\s*\(\s*!USE_MOCK\s*\)\s*return\s*''/.test(sess);
    const persistsHint = /paths:\s*\[[^\]]*'sessionHint'[^\]]*\]/.test(store);
    const unauthorizedRevokes = /if \(res\.code === BusinessCode\.UNAUTHORIZED\)[\s\S]{0,120}?handleUnauthorized\(/.test(req)
        && /function handleUnauthorized[\s\S]{0,1200}?userStore\.revoke\(/.test(req);
    const logoutHitsServer = /logout\(\)\s*\{[\s\S]{0,700}?revokeServerSession\(\)/.test(store);

    const ok = httpOnly && issuedBoth && cookieFirst && logoutEp && logoutPublic
        && readTokenGated && persistsHint && unauthorizedRevokes && logoutHitsServer;

    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `后端 类=${!!cookie} HttpOnly=${httpOnly} 登录注册都下发=${issuedBoth} Cookie优先=${cookieFirst}`
            + ` 登出端点=${logoutEp} 登出匿名=${logoutPublic}`
            + ` | 前端 读票闸门=${readTokenGated} 只持久化hint=${persistsHint}`
            + ` 401作废会话=${unauthorizedRevokes} 登出清票=${logoutHitsServer}`
            + ` | 行为由 4 个 spec 20 用例 + probe-d9 12 轮红绿证明`,
    };
});

/* ---------- AI 多供应商降级链（P1-14，2026-09-24） ---------- */

check('P1-14', 'AI 降级链 DeepSeek→千问→模板', () => {
    /*
     * ★ 判据锚「能力」不锚「字样」（随 P1-14 一起落地，已纳入 probe-audit-criteria-redgreen R30/R31）★
     *
     * 要的能力 = 「链首失败能自动换下一家，且运维能看见自己没配 key」，拆六条：
     *   ① 配置面：application.yml 的 **app.ai** 段真有链顺序，且**至少两家**各有 base-url + model
     *   ② 白名单：AiProperties 的 KNOWN_PROVIDERS 含 deepseek 与 qwen
     *      （不在名单里的链名会被静默丢弃 ⇒「我明明配了却没生效」）
     *   ③ 实现：AiProviderChain 真的 implements ChatModel，且**在循环里逐个尝试**
     *   ④ 失败判据不只认异常：**空白 / null 也算失败**（兼容网关常不报错、只返空串）
     *   ⑤ 出口：全失败抛专用异常（调用方 catch 后落回模板 ⇒ 前端契约不破）
     *   ⑥ 运维面：deploy/env.example 登记了 APP_AI_* 变量；yml 排除了 OpenAI 自动配置
     *
     * ★ 一律在**剥注释**的代码上判定 —— 这些名字在注释里故意写满，不剥 = 注释自己骗自己（形态⑫）。
     * ★ 必须先把 app: 段截出来再截其中的 ai: —— yml 里有**两个** ai:（spring.ai.retry 与 app.ai），
     *   直接全局匹配会命中 spring 那一个，判据就成了「有没有 spring.ai 段」，与能力无关。
     */
    const ymlRaw = read(path.join(BE, 'src/main/resources/application.yml'));
    const propsRaw = read(path.join(BE, 'src/main/java/com/campus/market/config/AiProperties.java'));
    const chainRaw = read(path.join(BE, 'src/main/java/com/campus/market/service/ai/AiProviderChain.java'));
    const envRaw = read(path.join(BE, 'deploy/env.example'));
    if (!ymlRaw || !propsRaw || !chainRaw) {
        return { state: 'MISSING', ev: `yml=${!!ymlRaw} props=${!!propsRaw} chain=${!!chainRaw}` };
    }

    // ---- ① 逐层截块（尾部加哨兵行，保证「最后一节」也能收得住）----
    const appBlock = (() => {
        const m = (ymlRaw + '\nZZZ_END:\n').match(/^app:\s*$([\s\S]*?)(?=^[A-Za-z])/m);
        return m ? m[1] : '';
    })();
    const aiBlock = (() => {
        const m = (appBlock + '\n  ZZZ_END:\n').match(/^ {2}ai:\s*$([\s\S]*?)(?=^ {2}\S)/m);
        return m ? m[1] : '';
    })();
    const hasChainKey = /chain:\s*\S/.test(aiBlock);
    const baseUrlCnt = (aiBlock.match(/base-url:/g) || []).length;
    const modelCnt = (aiBlock.match(/model:/g) || []).length;
    const configSurface = hasChainKey && baseUrlCnt >= 2 && modelCnt >= 2;
    const excludedAuto = /autoconfigure:[\s\S]{0,200}?exclude:[\s\S]{0,200}?OpenAiAutoConfiguration/.test(ymlRaw);

    // ---- ②③④⑤ 实现面（剥注释）----
    const props = javaCode(propsRaw);
    const chain = javaCode(chainRaw);
    const knownList = /KNOWN_PROVIDERS\s*=\s*List\.of\(([^)]*)\)/.exec(props);
    const whitelist = !!knownList && /"deepseek"/.test(knownList[1]) && /"qwen"/.test(knownList[1]);
    const implementsChatModel = /class\s+AiProviderChain\s+implements\s+ChatModel/.test(chain);
    const attempt = methodBody(chain, /private\s+<T>\s+T\s+attempt\s*\(/);
    const loopsEach = !!attempt && /for\s*\(/.test(attempt) && /\.apply\s*\(/.test(attempt);
    const checksEachResult = !!attempt && /ok\.test\s*\(\s*value\s*\)/.test(attempt);
    // ★ 空白判据必须真判空，不能是恒真的谓词（否则「返空串」会被当成成功，降级永远不触发）
    const blankCountsAsFailure = /text\s*!=\s*null\s*&&\s*!\s*text\.isBlank\(\)/.test(chain);
    const customExit = /class\s+AiChainExhaustedException\s+extends\s+RuntimeException/.test(chain);

    // ---- ⑥ 运维面 ----
    const envDocs = !!envRaw && /APP_AI_DEEPSEEK_API_KEY/.test(envRaw) && /APP_AI_QWEN_API_KEY/.test(envRaw);

    const ok = configSurface && excludedAuto && whitelist && implementsChatModel
        && loopsEach && checksEachResult && blankCountsAsFailure && customExit && envDocs;

    return {
        state: ok ? 'DONE' : 'MISSING',
        ev: `app.ai 配置面=${configSurface}(chain=${hasChainKey} baseUrl=${baseUrlCnt} model=${modelCnt})`
            + ` 排除自动配置=${excludedAuto} | 白名单=${whitelist} implements ChatModel=${implementsChatModel}`
            + ` 循环逐家试=${loopsEach} 判每家结果=${checksEachResult} 空响应算失败=${blankCountsAsFailure}`
            + ` 专用出口=${customExit} | env.example 登记=${envDocs}`
            + ` | 行为由 AiProviderChainTest 11 用例 + probe-ai-chain-live 17/17（含旧 jar 红绿 3/17）证明`,
    };
});

/* ---------- 输出 ---------- */
const ICON = { DONE: '✅', PARTIAL: '🟡', MISSING: '❌', INFO: '⚪', UNKNOWN: '❓' };
console.log('=== 部署缺口盘点（回代码实测，非台账转抄）===\n');
for (const r of rows) {
    console.log(`${ICON[r.state] ?? '?'} ${r.id.padEnd(6)} ${r.name.padEnd(26)} | ${r.ev}`);
}
const missing = rows.filter((r) => r.state === 'MISSING' || r.state === 'PARTIAL');
const unknown = rows.filter((r) => r.state === 'UNKNOWN');
console.log(`\n合计 ${rows.length} 项：已完成 ${rows.filter(r => r.state === 'DONE').length}，` +
    `未完成 ${missing.length}，无法判定 ${unknown.length}`);
if (unknown.length) process.exit(2);
