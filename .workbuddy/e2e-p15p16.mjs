/**
 * 真机探针：健康检查（P1-5）与请求上下文（P1-6）在**真实进程**里到底成不成立
 *
 * 用法：
 *   node .workbuddy/e2e-p15p16.mjs                                  # 用 dist/ 最新产物 ⇒ 期望能力「在」
 *   node .workbuddy/e2e-p15p16.mjs --jar=<路径> --expect=absent      # 用修复前产物 ⇒ 期望能力「不在」
 *
 * ── ★ 为什么必须传 jar，而不是写死 target/ ★ ─────────────────────────────
 * `target/` 里的 jar 会被下一次构建覆盖（实测它与 dist/ 同名产物的 md5 并不相同），
 * 红对照两侧因此都锚在 dist/ 的**发版产物**上；同时用「jar 内有没有 RequestTraceFilter.class」
 * 给这次运行**自证身份** —— 否则"对照组报红"很可能只是因为拿错了包，
 * 那种红比不报还糟（会让人以为判别力已经验证过了）。
 *
 * ── 判定的两类口径（这两类的期望值**故意不同**）────────────────────────────
 *   · 能力类 capsPresent：随版本变化 —— 修复前应当**全 false**（这就是"红"），修复后全 true。
 *   · 安全类 capsSafe  ：与版本无关，**两组都必须成立**。安全属性不该因为换个包就消失，
 *                        若修复前反而"更安全"，说明我的判据测错了东西。
 *   把两者混在一起，就会出现「对照组报红」是安全断言在误报的情况。
 *
 * ── 关于"日志注入"在真机上能测到什么 ──────────────────────────────────────
 * 裸 CRLF 放进 HTTP 头值在协议层就被挡（Tomcat 直接 400），所以真机上攻击者**送不出**
 * 真正的换行。应用层真正要防的是「非法字符被原样写进日志」，因此这里用
 * **空格** 与 **字面 %0d%0a** 两种非法值来代表（它们能合法地到达应用）。
 * 判据是「响应头没有沿用非法值」+「日志里不出现该原始串」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const DIST = path.join(BE, 'dist');
const JAVA = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const PORT = 8080;
const TMP = path.join(ROOT, '.workbuddy', 'tmp');
const LOGDIR = path.join(TMP, 'logs-p15p16');
const BASE = `http://127.0.0.1:${PORT}/api`;

const argv = process.argv.slice(2);
const arg = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : null;
};
const EXPECT = arg('expect') ?? 'present';
const jarArg = arg('jar');
/*
 * ★ --jar 必须解析成绝对路径 ★
 * spawn 的 cwd 是 campus-secondhand-backend，而人（和文档）习惯写相对**项目根**的路径 ⇒
 * 直接抛 "Unable to access jarfile …"（对照组第一轮就是这么白跑了一次）。
 */
let JAR = jarArg ? path.resolve(ROOT, jarArg) : null;
if (!JAR) {
    // ★ 按产物名里的 12 位时间戳取最新，别用文件名排序 ★
    // 文件名排序会骗人：`cb36…` < `ddc5…`（字母序），于是"最后一个"反而是更早构建的那个。
    // 本探针第一版就是这么取到了旧包，结果 buildIdInBody 报红 —— 那不是代码错，是取包错。
    const jars = fs.readdirSync(DIST).filter((f) => f.endsWith('.jar'))
        .map((f) => ({ f, ts: (f.match(/-(\d{12})\.jar$/) ?? [])[1] ?? '0' }))
        .sort((a, b) => a.ts.localeCompare(b.ts));
    JAR = path.join(DIST, jars[jars.length - 1].f);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};
let pass = 0, fail = 0;

function portBusy() {
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        return out.split(/\r?\n/).some((l) => new RegExp(`:${PORT}\\s`).test(l) && /LISTENING/i.test(l));
    } catch { return false; }
}
function killTree(pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); } catch { }
}
async function waitReady(timeoutMs = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const j = await (await fetch(`${BASE}/goods?page=1&pageSize=1`)).json();
            if (typeof j.code === 'number') return true;   // 错误也是 200，就绪判据只能看 body
        } catch { /* 还没起来 */ }
        await sleep(1500);
    }
    return false;
}
/** zip 的中央目录里条目名是明文，直接搜类名即可（不必解包 51MB 的 jar） */
function jarContains(needle) {
    return fs.readFileSync(JAR).includes(Buffer.from(needle, 'utf8'));
}
const readLog = () => {
    const p = path.join(LOGDIR, 'campus-market.log');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/* ---------------- 前置 ---------------- */
if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar：' + JAR); process.exit(2); }
if (portBusy()) { console.error(`[FATAL] ${PORT} 被占用，先停后端`); process.exit(2); }
fs.mkdirSync(TMP, { recursive: true });
fs.rmSync(LOGDIR, { recursive: true, force: true });

const jarName = path.basename(JAR);
const fp = (jarName.match(/-([0-9a-f]{12})-\d{12}\.jar$/) || [])[1] ?? null;   // 产物里的源码指纹
const HAS_FILTER = jarContains('config/RequestTraceFilter.class');
const HAS_HEALTH = jarContains('service/HealthService.class');

console.log('=== 真机探针 P1-5 / P1-6 ===');
console.log(`  产物   ${jarName}`);
console.log(`  模式   expect=${EXPECT}`);
console.log(`  自证   jar 内含 RequestTraceFilter.class=${HAS_FILTER}  HealthService.class=${HAS_HEALTH}`);
if (!fp) console.log('  ⚠️ 产物名里没有 12 位源码指纹，build 字段的断言会退化为只查非空');

/* ---------------- 起进程 ---------------- */
const child = spawn(JAVA, [
    '-jar', JAR,
    `--server.port=${PORT}`,
    `--app.log-dir=${LOGDIR}`,
    // 让定时任务每 5 秒跑一次：为了给「job-* 的 traceId 真的进了日志」造一个可观测出口
    '--app.goods-maintenance.offline-cron=*/5 * * * * ?',
    '--app.goods-maintenance.offline-enabled=true',
], { cwd: BE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let boot = '';
child.stdout.on('data', (c) => { boot += c.toString('utf8'); });
child.stderr.on('data', (c) => { boot += c.toString('utf8'); });

const ready = await waitReady();
if (!ready) {
    console.error('[FATAL] 进程没起来：\n' + boot.slice(-3000));
    killTree(child.pid);
    process.exit(2);
}
console.log('  进程已就绪\n');
await sleep(500);

/* ---------------- 采集能力 ---------------- */
const caps = {};

/* P1-5 · 健康检查 */
const healthRes = await fetch(`${BASE}/health`);
const healthText = await healthRes.text();
let health = {};
try { health = JSON.parse(healthText); } catch { /* 不是 JSON */ }
const hd = health?.data ?? {};
caps.healthEndpointExists = typeof health?.data?.status === 'string';
caps.healthStatusIsUp = hd.status === 'UP';
caps.dbStatusReported = hd.db?.status === 'UP';
caps.logWritableReported = hd.log?.writable === true;
caps.buildIdInBody = fp ? String(hd.build ?? '').includes(fp) : String(hd.build ?? '').length > 0;
caps.noInternalDetailLeak = !/jdbc:|C:\\\\|Access denied|password/i.test(healthText);

/* P1-6 · 请求上下文 */
const TID = 'e2e-happy-0001';
const r1 = await fetch(`${BASE}/health`, { headers: { 'X-Request-Id': TID } });
caps.traceIdEchoed = r1.headers.get('x-request-id') === TID;
caps.exposeHeaderPresent = (r1.headers.get('access-control-expose-headers') ?? '').includes('X-Request-Id');

/*
 * ★ 为什么"进日志"这条不能用 /api/health 去验 ★
 * 成功的请求**一行日志都不打**（本项目没有 access log）。拿健康检查当靶子，
 * 这条断言永远失败 —— 而那不是缺陷，是本项目的既有形态。真正需要上下文的
 * 恰恰是异常/告警的那一行。所以这里换一个**必然命中 GlobalExceptionHandler 分支**的请求：
 *   GET /api/goods?page=abc  →  Integer 转不了 abc  →  MethodArgumentTypeMismatchException
 *                            →  GlobalExceptionHandler:54  log.warn("参数类型不匹配…")
 * 而 /goods 的 GET 是公开路由，不需要登录。
 * ★ 这同时如实交代了边界的另一面：MDC 的价值只在"真打了日志"的那些行上兑现。
 */
const LOGHIT = 'e2e-loghit-0001';
await fetch(`${BASE}/goods?page=abc&pageSize=1`, { headers: { 'X-Request-Id': LOGHIT } });
await sleep(600);                                   // 等刷盘

let log = readLog();
caps.traceIdAppearsInLog = log.includes(LOGHIT);
const hitLine = log.split(/\r?\n/).find((l) => l.includes(LOGHIT)) ?? '';
caps.logLineHasFullContext = /uid=/.test(hitLine) && hitLine.includes('GET') && hitLine.includes('/api/goods');

const r2 = await fetch(`${BASE}/health`);
const gen = r2.headers.get('x-request-id') ?? '';
caps.generatesIdWhenAbsent = /^[0-9a-f]{16}$/.test(gen);

const A = 'e2e-cross-aaaa', B = 'e2e-cross-bbbb';
const [ra, rb] = await Promise.all([
    fetch(`${BASE}/health`, { headers: { 'X-Request-Id': A } }),
    fetch(`${BASE}/health`, { headers: { 'X-Request-Id': B } }),
]);
caps.noCrossTalk = ra.headers.get('x-request-id') === A && rb.headers.get('x-request-id') === B;

/* 安全类 · 非法 id 不得被沿用、更不得进日志 */
const EVIL = 'e2e evil 0001';
const EVIL2 = '%0d%0aINJECTED';
const r3 = await fetch(`${BASE}/health`, { headers: { 'X-Request-Id': EVIL } });
const r4 = await fetch(`${BASE}/health`, { headers: { 'X-Request-Id': EVIL2 } });
const h3 = r3.headers.get('x-request-id') ?? '', h4 = r4.headers.get('x-request-id') ?? '';
caps.injectionBlockedInHeader = h3 !== EVIL && h4 !== EVIL2 && !/[\r\n]/.test(h3 + h4);
await sleep(400);
log = readLog();
caps.injectionAbsentFromLog = !log.includes('INJECTED') && !log.includes(EVIL);

/* 安全类 · 白名单只放行 GET ⇒ 未登录的 POST 不得成功 */
const postRes = await fetch(`${BASE}/health`, { method: 'POST' });
const postBody = await postRes.json().catch(() => ({}));
caps.postHealthNotSucceeding = postBody.code !== 0;

/* P1-6 · 定时任务的 traceId（cron 每 5 秒，最多等 30 秒） */
let jobSeen = false;
for (let i = 0; i < 20 && !jobSeen; i++) {
    jobSeen = readLog().includes('job-goods-offline-');
    if (!jobSeen) await sleep(1500);
}
caps.jobTraceIdInLog = jobSeen;

killTree(child.pid);
await sleep(300);

/* ---------------- 判定 ---------------- */
const CAP_PRESENT = ['healthEndpointExists', 'healthStatusIsUp', 'dbStatusReported', 'logWritableReported',
    'buildIdInBody', 'traceIdEchoed', 'exposeHeaderPresent', 'traceIdAppearsInLog', 'logLineHasFullContext',
    'generatesIdWhenAbsent', 'noCrossTalk', 'jobTraceIdInLog'];
const CAP_SAFE = ['noInternalDetailLeak', 'injectionBlockedInHeader', 'injectionAbsentFromLog', 'postHealthNotSucceeding'];

console.log('---------- 能力项（随版本变化）----------');
for (const k of CAP_PRESENT) {
    ok(EXPECT === 'present' ? k : `${k} 应不存在`, EXPECT === 'present' ? caps[k] === true : caps[k] === false);
}
console.log('---------- 安全项（两组都必须成立）----------');
for (const k of CAP_SAFE) ok(k, caps[k] === true);

/* ---------------- 自证：jar 内容与行为必须一致 ---------------- */
console.log('---------- 探针自证 ----------');
const consistent = HAS_FILTER === caps.healthEndpointExists && HAS_HEALTH === caps.healthEndpointExists;
ok('jar 内是否含新 class 与「端点在不在」结论一致', consistent,
    `filter=${HAS_FILTER} health=${HAS_HEALTH} endpoint=${caps.healthEndpointExists}`);

console.log(`\n=== 汇总：${pass} PASS / ${fail} FAIL（expect=${EXPECT}）===`);
if (!consistent) { console.log('探针失效：jar 自证与行为不一致，本次结论作废'); process.exit(2); }
if (EXPECT === 'present') {
    console.log(fail === 0
        ? '⇒ 修复后：健康检查与请求上下文的全部能力/安全项在真机上成立'
        : '⇒ 修复后仍有失败项，见上');
} else {
    console.log(fail === 0
        ? '⇒ 修复前（对照组）：这些能力**确实不存在** —— 真机红对照成立（同一探针在新产物上才会全绿）'
        : '⇒ 对照组出现意外结果，见上');
}
process.exit(fail === 0 ? 0 : 1);
