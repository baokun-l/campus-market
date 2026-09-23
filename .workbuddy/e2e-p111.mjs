/**
 * 真机探针：鉴权快照缓存（P1-11）在**真实进程**里到底成不成立。
 *
 * 用法：
 *   node .workbuddy/e2e-p111.mjs                                   # 用 dist/ 最新产物 ⇒ 期望能力「在」
 *   node .workbuddy/e2e-p111.mjs --jar=<产物> --expect=absent      # 用修复前产物 ⇒ 期望能力「不在」
 *
 * ── ★ 为什么这一层不能只靠单测与红绿探针 ★ ────────────────────────────────
 * 单测里 `AuthSnapshotCache` 是 `new` 出来的（显式构造），红绿探针改的是**源码**。
 * 两者都绕过了「真实装配 + 真实 HTTP 链路」：Bean 有没有被扫到、拦截器注入的是不是
 * 缓存而不是 UserMapper、命令行参数有没有真的到达变量 —— 这些只在真机上才暴露。
 * 本项目已经有过「单测全绿、注册链路其实没通」的先例，所以这一层必须单独跑。
 *
 * ── ★ 缓存这东西「看不见」，所以必须给它造一个可观测出口 ★ ────────────────────
 * 缓存生效时接口更快，而**计时判据不可靠**（本仓纪律：次序判据 > 计时判据）。
 * 所以这里不去量耗时，而是**绕过应用直接改库**（`UPDATE t_user SET status=...`）：
 *   · 应用不知道这次改动 ⇒ 没有显式失效 ⇒ 只能靠缓存里的旧快照回答
 *   · 于是「改库后**立刻**仍然放行」就成了一条**确定性的**「缓存存在」证据
 * 这条同时也是本类最关键的安全约束的**反面**：过期窗口有界（TTL 兜底）。
 * 两者配对，缺一不可 —— 只有前者是「缓存泄漏」，只有后者是「没缓存」。
 *
 * ── 两类判定的期望值**故意不同** ────────────────────────────────────────
 *   · 能力类 capsPresent：随版本变化。修复前必须**全 false**（这就是「红」），修复后全 true。
 *   · 安全类 capsSafe  ：与版本无关，**两组都必须成立**。它们是**防掩盖判据**：
 *                        若某次改动把「显式失效」和「缓存」一起干掉，能力类会红，
 *                        但若没有安全类，就看不出「撤销链」是不是也一起坏了。
 *                        安全属性不该因为换个包就消失；修复前反而更「安全」也可以接受
 *                        （修复前没有缓存，封禁本来就是立即生效），但**绝不能更不安全**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const DIST = path.join(BE, 'dist');
const JAVA = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const MYSQL = 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe';
const PORT = 8080;
const TMP = path.join(ROOT, '.workbuddy', 'tmp');
const LOGDIR = path.join(TMP, 'logs-p111');
const UPLOADDIR = path.join(TMP, 'uploads-p111');
const BASE = `http://127.0.0.1:${PORT}/api`;

/** 与 `AuthSnapshotCache.TTL_SECONDS` 同源；判据里用 2.5× 余量（见下） */
const TTL_SECONDS = 10;
const TTL_POLL_DEADLINE_MS = TTL_SECONDS * 1000 * 2.5;

/** 被观测的用户（种子账号 zhangsan）；口令会用完**复原** */
const UID = 4;
const UNAME = 'zhangsan';
const UPASS = '123456';
const ADMIN = { username: 'admin', password: 'admin123' };

const argv = process.argv.slice(2);
const arg = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : null;
};
const EXPECT = arg('expect') ?? 'present';
/* ★ --jar 必须解析成绝对路径 ★（spawn 的 cwd 是 campus-secondhand-backend） */
const jarArg = arg('jar');
let JAR = jarArg ? path.resolve(ROOT, jarArg) : null;
if (!JAR) {
    // ★ 按产物名里的 12 位时间戳取最新，别用文件名排序 ★（字母序 ≠ 时间序）
    const jars = fs.readdirSync(DIST).filter((f) => f.endsWith('.jar'))
        .map((f) => ({ f, ts: (f.match(/-(\d{12})\.jar$/) ?? [])[1] ?? '0' }))
        .sort((a, b) => a.ts.localeCompare(b.ts));
    JAR = path.join(DIST, jars[jars.length - 1].f);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};

function portBusy() {
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        return out.split(/\r?\n/).some((l) => new RegExp(`:${PORT}\\s`).test(l) && /LISTENING/i.test(l));
    } catch { return false; }
}
function killTree(pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); } catch { }
}

/**
 * 绕过应用直接改库。
 * ★ SQL 一律写成单行 ★：多行 SQL 经 cmd.exe 会被换行截断（本仓踩过），
 * 这里虽然用 execFileSync 不走 shell，仍保持单行以免将来被挪进 shell 调用时静默失效。
 */
function sql(q) {
    return execFileSync(MYSQL, ['-uroot', '-p123456', '--default-character-set=utf8mb4', '-N', '-B', '-e', q],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const setStatus = (s) => sql(`UPDATE campus_market.t_user SET status='${s}' WHERE id=${UID}`);
const dbStatus = () => sql(`SELECT status FROM campus_market.t_user WHERE id=${UID}`);
const dbVer = () => sql(`SELECT token_version FROM campus_market.t_user WHERE id=${UID}`);

/** zip 的中央目录里条目名是明文，直接搜类名即可 */
const jarContains = (needle) => fs.readFileSync(JAR).includes(Buffer.from(needle, 'utf8'));

/* ---------------- 前置 ---------------- */
if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar：' + JAR); process.exit(2); }
if (portBusy()) { console.error(`[FATAL] ${PORT} 被占用，先停后端`); process.exit(2); }
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(UPLOADDIR, { recursive: true });
fs.rmSync(LOGDIR, { recursive: true, force: true });

const jarName = path.basename(JAR);
const HAS_CACHE_CLASS = jarContains('security/AuthSnapshotCache.class');

console.log('=== 真机探针 P1-11（鉴权快照缓存）===');
console.log(`  产物   ${jarName}`);
console.log(`  模式   expect=${EXPECT}`);
console.log(`  自证   jar 内含 AuthSnapshotCache.class=${HAS_CACHE_CLASS}`);
console.log(`  库中   ${UNAME}(id=${UID}) status=${dbStatus()} token_version=${dbVer()}`);

/* ---------------- 起进程 ---------------- */
const child = spawn(JAVA, [
    '-jar', JAR,
    `--server.port=${PORT}`,
    `--app.log-dir=${LOGDIR}`,
    `--app.upload.dir=${UPLOADDIR}`,
], { cwd: BE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let boot = '';
child.stdout.on('data', (c) => { boot += c.toString('utf8'); });
child.stderr.on('data', (c) => { boot += c.toString('utf8'); });

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
const ready = await waitReady();
if (!ready) {
    console.error('[FATAL] 进程没起来：\n' + boot.slice(-3000));
    killTree(child.pid);
    process.exit(2);
}
console.log('  进程已就绪\n');

async function call(method, p, { token, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
}
const login = async (u, p) => (await call('POST', '/user/login', { body: { username: u, password: p } })).json;
const profile = (token) => call('GET', '/user/profile', { token });
/*
 * ★ 观测「拦截器有没有放行」必须挑一个**不带服务层状态校验**的端点 ★
 *
 * 第一版用 `/user/profile`，结果直改库后**立刻**拿到了 `403 账号已被封禁`，
 * 看起来像「缓存没生效」。回代码取证才发现：`UserService#getProfile` 里还有
 * **第二道**封禁判定（`userMapper.selectById` 直查库 → `forbidden("账号已被封禁")`）。
 * 也就是说那次 403 说明的是「拦截器放行了、下游把它拦了」，缓存其实生效了 ——
 * 判据测错了对象（本仓纪律：报红先怀疑断言对象，别先怀疑被测实现）。
 *
 * `/user/heartbeat` 只写 `last_active_at`，**没有任何状态校验**，
 * 于是它的响应码就只由拦截器决定：这正是观测缓存所需的那条干净出口。
 */
const beat = (token) => call('POST', '/user/heartbeat', { token });
/** 轮询到期望码；返回 {hit, waitedMs, last} */
async function poll(fn, wantCode, deadlineMs) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < deadlineMs) {
        last = await fn();
        if (last.json?.code === wantCode) return { hit: true, waitedMs: Date.now() - t0, last };
        await sleep(1000);
    }
    return { hit: false, waitedMs: Date.now() - t0, last };
}

const caps = {};
const notes = [];
/** 无论怎么退出都要复原演示库（探针只能证明结论，不能留下副作用） */
let restored = false;
function restoreDb() {
    if (restored) return;
    restored = true;
    setStatus('active');
    notes.push('已复原 t_user.status=active');
}

/* ---------------- 登录 ---------------- */
const zLogin = await login(UNAME, UPASS);
const Z = zLogin?.data?.token;
if (!Z) {
    console.error(`[FATAL] ${UNAME} 登录失败：code=${zLogin?.code} msg=${zLogin?.message}`);
    killTree(child.pid); process.exit(2);
}
const admLogin = await login(ADMIN.username, ADMIN.password);
const A = admLogin?.data?.token;
if (!A) {
    console.error(`[FATAL] admin 登录失败：code=${admLogin?.code} msg=${admLogin?.message}`);
    killTree(child.pid); process.exit(2);
}

/* ============ 第 1 段：缓存存在性（背地里改库 ⇒ 旧快照仍放行）+ TTL 有界 ============ */
{
    const p0 = await beat(Z);
    caps.baselineUsable = p0.json?.code === 0;

    await sleep(1500);                       // 让「装载快照」与「改库」之间隔开 ~1.5s
    setStatus('banned');                     // ★ 绕过应用：应用不知道，所以不可能显式失效
    const tBan = Date.now();
    const immediate = await beat(Z);          // 1.5s < TTL(10s) ⇒ 应当仍读到旧快照
    const elapsed = Date.now() - tBan;
    caps.cacheHoldsSnapshotWhileDbChanged = immediate.json?.code === 0;
    notes.push(`直改库后立刻 heartbeat：code=${immediate.json?.code}（距改库 ${elapsed}ms，TTL=${TTL_SECONDS}s）`);

    /*
     * 附带记录（**不是**判据，是事实交代）：同一窗口内 `/user/profile` 会因为
     * `UserService#getProfile` 的第二道直查库校验而**立刻**拒绝。
     * 即「封禁生效延迟」取决于端点是否自带状态校验 —— 这条差异写进设计说明，
     * 不在这里判红绿（它既非 P1-11 引入的缺陷，也不随版本变化到需要判据看守）。
     */
    const profAfter = await profile(Z);
    notes.push(`同窗口 /user/profile：code=${profAfter.json?.code} msg=${profAfter.json?.message}（服务层直查库的第二道判定）`);

    const flip = await poll(() => beat(Z), 401, TTL_POLL_DEADLINE_MS);
    caps.ttlEventuallyReflectsDb = flip.hit;
    notes.push(`直改库后 heartbeat 转为 401：${flip.hit ? flip.waitedMs + 'ms' : '超时未变'}（上界 ${TTL_POLL_DEADLINE_MS}ms）`);

    restoreDb();
    const back = await poll(() => beat(Z), 0, TTL_POLL_DEADLINE_MS);
    caps.restoreEventuallyReachable = back.hit;
    notes.push(`复原后 heartbeat 恢复放行：${back.hit ? back.waitedMs + 'ms' : '超时未恢复'}`);
}

/* ============ 第 2 段：显式失效必须「立刻」生效（次序判据，无 sleep）============ */
{
    const before = await profile(Z);
    caps.usableAgainBeforeBan = before.json?.code === 0;

    await call('POST', `/admin/users/${UID}/ban`, { token: A, body: { banned: true } });
    const banned = await profile(Z);           // ★ 同一个 token，紧接着的下一次请求
    caps.banTakesEffectImmediately = banned.json?.code === 401;
    notes.push(`后台封禁后下一请求：code=${banned.json?.code}（期望 401）`);

    await call('POST', `/admin/users/${UID}/ban`, { token: A, body: { banned: false } });
    const unbanned = await profile(Z);
    caps.unbanTakesEffectImmediately = unbanned.json?.code === 0;
    notes.push(`后台解封后下一请求：code=${unbanned.json?.code}（期望 0）`);
}

/* ============ 第 3 段：改密 ⇒ token_version +1 ⇒ 旧票立刻作废（用完复原口令）====== */
{
    const verBefore = Number(dbVer());
    const tmp = 'p111_tmp_pass';
    const ch = await call('PATCH', '/user/password', { token: Z, body: { oldPassword: UPASS, newPassword: tmp } });
    caps.passwordChangeAccepted = ch.json?.code === 0;

    const old = await profile(Z);
    caps.passwordChangeRevokesOldTokenImmediately = old.json?.code === 401;
    notes.push(`改密后旧票：code=${old.json?.code}（期望 401）`);
    caps.tokenVersionIncremented = Number(dbVer()) === verBefore + 1;

    // 复原口令（用新口令换回来），并顺手验证「新票可用」
    const z2 = await login(UNAME, tmp);
    const Z2 = z2?.data?.token;
    caps.reloginWithNewPasswordWorks = !!Z2 && (await profile(Z2)).json?.code === 0;
    if (Z2) {
        await call('PATCH', '/user/password', { token: Z2, body: { oldPassword: tmp, newPassword: UPASS } });
    }
    // ★ 复原必须**自证**：拿不回 123456 就等于把演示库搞坏了，宁可作废本次结论
    const back = await login(UNAME, UPASS);
    caps.passwordRestored = !!back?.data?.token;
    if (!caps.passwordRestored) {
        console.error(`[FATAL] ${UNAME} 口令未复原成 ${UPASS}！演示库需要人工修复`);
        killTree(child.pid);
        process.exit(2);
    }
    notes.push(`口令已复原为 ${UPASS}（token_version 现为 ${dbVer()}）`);
}

/* ============ 第 4 段：与版本无关的安全项 ============ */
{
    const anon = await profile(null);
    caps.anonymousRejected = anon.json?.code === 401;

    const forged = await profile('not.a.real.jwt');
    caps.forgedTokenRejected = forged.json?.code === 401;

    caps.noInternalDetailLeak = !/Exception|java\.|C:\\|at com\./.test(
        `${forged.json?.message ?? ''}${anon.json?.message ?? ''}`);
}

killTree(child.pid);
await sleep(300);
restoreDb();

/* ---------------- 判定 ---------------- */
const CAP_PRESENT = [
    'cacheHoldsSnapshotWhileDbChanged',   // ★ 缓存存在的确定性证据（背地里改库仍放行）
];
const CAP_SAFE = [
    'baselineUsable',
    'ttlEventuallyReflectsDb',            // TTL 兜底：过期窗口有界
    'restoreEventuallyReachable',
    'usableAgainBeforeBan',
    'banTakesEffectImmediately',          // 显式失效：封禁立刻生效
    'unbanTakesEffectImmediately',        // 解封也要失效（否则缓存里留着 banned）
    'passwordChangeAccepted',
    'passwordChangeRevokesOldTokenImmediately',
    'tokenVersionIncremented',
    'reloginWithNewPasswordWorks',
    'passwordRestored',
    'anonymousRejected',
    'forgedTokenRejected',
    'noInternalDetailLeak',
];

console.log('---------- 观测记录 ----------');
for (const n of notes) console.log('  · ' + n);
console.log('---------- 能力项（随版本变化）----------');
for (const k of CAP_PRESENT) {
    ok(EXPECT === 'present' ? k : `${k} 应不存在`, EXPECT === 'present' ? caps[k] === true : caps[k] === false);
}
console.log('---------- 安全项（两组都必须成立）----------');
for (const k of CAP_SAFE) ok(k, caps[k] === true);

/* ---------------- 自证：jar 内容与行为必须同向 ---------------- */
console.log('---------- 探针自证 ----------');
const consistent = HAS_CACHE_CLASS === (caps.cacheHoldsSnapshotWhileDbChanged === true);
ok('jar 内 class 与真机行为同向', consistent,
    `AuthSnapshotCache.class=${HAS_CACHE_CLASS}/缓存可观测=${caps.cacheHoldsSnapshotWhileDbChanged}`);

console.log(`\n=== 汇总：${pass} PASS / ${fail} FAIL（expect=${EXPECT}）===`);
if (!consistent) { console.log('⚠️ 探针失效：jar 自证与行为不一致，本次结论作废'); process.exit(2); }
if (EXPECT === 'present') {
    console.log(fail === 0
        ? '⇒ 修复后：缓存生效，且显式失效与 TTL 兜底两层在真机上成立'
        : '⇒ 修复后仍有失败项，见上');
} else {
    console.log(fail === 0
        ? '⇒ 修复前（对照组）：「缓存存在」这项能力**确实不存在**，且撤销链依旧立即生效 —— 真机红对照成立'
        : '⇒ 对照组出现意外结果，见上');
}
process.exit(fail === 0 ? 0 : 1);
