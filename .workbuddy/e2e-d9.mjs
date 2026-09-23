/**
 * 真机探针：会话凭据改 HttpOnly Cookie（D9）在**真实进程**里到底成不成立。
 *
 * 用法：
 *   node .workbuddy/e2e-d9.mjs                                     # 用 dist/ 最新产物 ⇒ 期望能力「在」
 *   node .workbuddy/e2e-d9.mjs --jar=<产物> --expect=absent        # 用修复前产物 ⇒ 期望「不在」
 *
 * ── ★ 为什么这条必须上真机 ★ ────────────────────────────────────────────
 * 「Cookie 有没有下发」不是业务逻辑，是**响应头**上的事：`Set-Cookie` 的
 * HttpOnly / SameSite / Path / Max-Age 四个属性任一写错，浏览器就静默不认它 ——
 * 表现是「登录接口明明返回成功，下一个请求却是未登录」，且**服务端没有任何报错**。
 * 单测里断言的是 `AuthCookie.write` 拼出来的字符串，真机上要验的是
 * 这个字符串有没有真的出现在 HTTP 响应头里、以及浏览器视角下它是否可用。
 *
 * ── ★ 两条通道的边界 ★ ────────────────────────────────────────────────
 * 主通道是 Cookie（JS 读不到 ⇒ XSS 拿不走）；`Authorization` 头保留为第二条通道
 * （现有探针、脚本、Swagger「Try it out」都靠它）。本探针必须同时证明：
 *   · 只用 Cookie 能通过（主通道真的通了）
 *   · 只用 Bearer 也能通过（兼容通道**没有**被这次改动砍掉）
 *   · Cookie 优先：同时带「有效 Cookie + 无效 Bearer」必须仍通过
 * 最后一条是**次序判据**：若哪天有人把读取顺序改反了，它会立刻报红。
 *
 * ── 两类判定的期望值**故意不同** ────────────────────────────────────────
 *   · 能力类 capsPresent：随版本变化。修复前必须全 false（「红」），修复后全 true。
 *   · 安全类 capsSafe  ：**两组都必须成立**，是防掩盖判据。尤其：
 *       - HTTP 下**不能**有 Secure：带了浏览器直接丢弃 ⇒ 本地开发「登录完就未登录」；
 *       - 登出必须**幂等且不要求登录**：会话已失效时反而是最需要退出的时刻；
 *       - 响应体里的 token 契约**不变**（既有客户端与探针仍可用）。
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
const LOGDIR = path.join(TMP, 'logs-d9');
const UPLOADDIR = path.join(TMP, 'uploads-d9');
const BASE = `http://127.0.0.1:${PORT}/api`;
const COOKIE = 'c2c-token';

const argv = process.argv.slice(2);
const arg = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : null;
};
const EXPECT = arg('expect') ?? 'present';
const jarArg = arg('jar');
let JAR = jarArg ? path.resolve(ROOT, jarArg) : null;
if (!JAR) {
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
/** 单行 SQL（多行经 cmd.exe 会被换行截断 —— 本仓踩过） */
function sql(q) {
    return execFileSync(MYSQL, ['-uroot', '-p123456', '--default-character-set=utf8mb4', '-N', '-B', '-e', q],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const jarContains = (needle) => fs.readFileSync(JAR).includes(Buffer.from(needle, 'utf8'));

/* 临时账号：注册链路要验「注册即下发 Cookie」，但演示库有严格基线（u=6）⇒ 收尾按用户名删除 */
const TMPUSER = 'zzd9' + String(Date.now() % 1000000).padStart(6, '0');

/* ---------------- 前置 ---------------- */
if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar：' + JAR); process.exit(2); }
if (portBusy()) { console.error(`[FATAL] ${PORT} 被占用，先停后端`); process.exit(2); }
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(UPLOADDIR, { recursive: true });
fs.rmSync(LOGDIR, { recursive: true, force: true });

const HAS_COOKIE_CLASS = jarContains('security/AuthCookie.class');
console.log('=== 真机探针 D9（会话凭据改 HttpOnly Cookie）===');
console.log(`  产物   ${path.basename(JAR)}`);
console.log(`  模式   expect=${EXPECT}`);
console.log(`  自证   jar 内含 AuthCookie.class=${HAS_COOKIE_CLASS}`);

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
            if (typeof j.code === 'number') return true;
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

/* ---------------- 请求工具（手工管理 Cookie：fetch 不会自动存）---------------- */
async function call(method, p, { token, cookie, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (cookie) headers['Cookie'] = `${COOKIE}=${cookie}`;
    const res = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    return { status: res.status, json, text, setCookies };
}
/** 从 Set-Cookie 里取出会话票据的值（取不到返回 null） */
function cookieValue(res) {
    for (const c of res.setCookies) {
        const m = c.match(new RegExp(`^${COOKIE}=([^;]*)`));
        if (m) return m[1];
    }
    return null;
}
const sessionCookieHeader = (res) => res.setCookies.find((c) => c.startsWith(COOKIE + '=')) ?? '';
const profile = (opts) => call('GET', '/user/profile', opts);

const caps = {};
const notes = [];
let cleaned = false;
function cleanup() {
    if (cleaned) return;
    cleaned = true;
    // 临时账号按用户名删除（演示库基线 u=6；该账号刚建，无任何关联数据）
    const n = sql(`DELETE FROM campus_market.t_user WHERE username='${TMPUSER}'`);
    notes.push(`已删除临时账号 ${TMPUSER}`);
}

/* ============ 第 1 段：登录下发 HttpOnly Cookie ============ */
const login = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
const TOKEN = login.json?.data?.token;
if (!TOKEN) {
    console.error(`[FATAL] 登录失败：code=${login.json?.code} msg=${login.json?.message}`);
    killTree(child.pid); process.exit(2);
}
const SC = sessionCookieHeader(login);
const CK = cookieValue(login);

caps.loginSetsCookie = !!CK;
caps.cookieIsHttpOnly = /;\s*httponly/i.test(SC);
caps.cookieIsSameSiteLax = /;\s*samesite=lax/i.test(SC);
caps.cookiePathRoot = /;\s*path=\//i.test(SC);
caps.cookieMatchesBodyToken = !!CK && CK === TOKEN;   // 同一个票据，不是另一个东西
notes.push(`登录 Set-Cookie: ${SC.replace(TOKEN, TOKEN.slice(0, 12) + '…')}`);

/* ============ 第 2 段：三条通道各自的可用性（次序判据）============ */
{
    const byCookieOnly = await profile({ cookie: CK });
    caps.cookieAloneAuthenticates = byCookieOnly.json?.code === 0;

    const byBearerOnly = await profile({ token: TOKEN });
    caps.bearerChannelStillWorks = byBearerOnly.json?.code === 0;   // 兼容通道没被砍

    // ★ Cookie 优先：有效 Cookie + **无效** Bearer ⇒ 必须仍通过（顺序反了就会 401）
    const cookieWins = await profile({ cookie: CK, token: 'not.a.real.jwt' });
    caps.cookieWinsOverBadBearer = cookieWins.json?.code === 0;
    notes.push(`Cookie+Bearer(有效+无效) 同时携带：code=${cookieWins.json?.code}（期望 0）`);

    const anon = await profile({});
    caps.anonymousStillRejected = anon.json?.code === 401;

    /*
     * ★ 与版本无关的安全项：拒绝时不许回显票据或内部细节 ★
     * 这条在修复前后都必须成立 —— 「把 token 写在错误信息里」和「把堆栈回给客户端」
     * 都是纯粹的信息泄漏，不该因为换了存储通道而出现。
     */
    const leak = `${anon.json?.message ?? ''}${cookieWins.json?.message ?? ''}${byBearerOnly.json?.message ?? ''}`;
    caps.noTokenOrInternalDetailLeak = !/eyJ|Exception|java\.|C:\\|at com\./.test(leak);
}

/* ============ 第 3 段：注册也下发（第二个入口同样要过闸）============ */
{
    const reg = await call('POST', '/user/register',
        { body: { username: TMPUSER, password: 'zz123456', nickname: 'D9临时' } });
    caps.registerAccepted = reg.json?.code === 0;
    const rc = sessionCookieHeader(reg);
    caps.registerSetsCookie = !!cookieValue(reg) && /;\s*httponly/i.test(rc);
    if (caps.registerSetsCookie) {
        const p = await profile({ cookie: cookieValue(reg) });
        caps.registerCookieUsable = p.json?.code === 0;
    } else {
        caps.registerCookieUsable = false;
    }
    notes.push(`注册（${TMPUSER}）：code=${reg.json?.code} 下发 Cookie=${caps.registerSetsCookie}`);
}

/* ============ 第 4 段：登出必须由服务端清票（前端删不掉 HttpOnly）============ */
{
    const out = await call('POST', '/user/logout', { cookie: CK });
    const osc = sessionCookieHeader(out);
    caps.logoutClearsCookie = out.json?.code === 0 && /max-age=0/i.test(osc);
    caps.logoutClearsWithSamePath = /;\s*path=\//i.test(osc);   // 属性不一致 = 删了个不存在的 Cookie
    notes.push(`登出 Set-Cookie: ${osc}`);

    // ★ 幂等 + 不要求登录：会话已失效时反而是最需要退出的时刻
    const out2 = await call('POST', '/user/logout', {});
    const out3 = await call('POST', '/user/logout', { token: TOKEN });
    caps.logoutAnonymousOk = out2.json?.code === 0;
    caps.logoutIdempotent = out3.json?.code === 0;
}

/* ============ 第 5 段：HTTP 下不能带 Secure（带了浏览器直接丢弃）============ */
{
    const l2 = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
    const sc2 = sessionCookieHeader(l2);
    caps.loginOkForSecureCheck = l2.json?.code === 0;
    caps.noSecureFlagOnHttp = sc2.length > 0 && !/;\s*secure/i.test(sc2);
    // 契约保持：响应体里仍有 token（既有客户端与探针不受影响）
    caps.tokenStillInBody = typeof l2.json?.data?.token === 'string' && l2.json.data.token.length > 20;
}

killTree(child.pid);
await sleep(300);
cleanup();

/* ---------------- 判定 ---------------- */
/*
 * ★ 分类是被「红对照」纠正过的 ★
 * 第一版把 `logoutAnonymousOk` / `logoutIdempotent` / `noSecureFlagOnHttp` 放在安全项里，
 * 结果修复前产物（那时 `/user/logout` **这个端点还不存在**）三项必然为假 ⇒ 对照组报红。
 * 它们其实是**随版本变化的能力**（端点不存在时，「它不要求登录」无从谈起），
 * 已挪到 `CAP_PRESENT`。这条纪律：安全项必须是**两组都为真**的，否则它就不是安全项，
 * 只是另一条被伪装成安全项的能力判据 —— 而伪装会让「红对照」永远通不过。
 */
const CAP_PRESENT = [
    'loginSetsCookie',
    'cookieIsHttpOnly',
    'cookieIsSameSiteLax',
    'cookiePathRoot',
    'cookieMatchesBodyToken',
    'cookieAloneAuthenticates',
    'cookieWinsOverBadBearer',
    'registerSetsCookie',
    'registerCookieUsable',
    'logoutClearsCookie',
    'logoutClearsWithSamePath',
    'logoutAnonymousOk',
    'logoutIdempotent',
    'noSecureFlagOnHttp',
];
const CAP_SAFE = [
    'bearerChannelStillWorks',
    'anonymousStillRejected',
    'noTokenOrInternalDetailLeak',
    'registerAccepted',
    'loginOkForSecureCheck',
    'tokenStillInBody',
];

console.log('---------- 观测记录 ----------');
for (const n of notes) console.log('  · ' + n);
console.log('---------- 能力项（随版本变化）----------');
for (const k of CAP_PRESENT) {
    ok(EXPECT === 'present' ? k : `${k} 应不存在`, EXPECT === 'present' ? caps[k] === true : caps[k] === false);
}
console.log('---------- 安全项（两组都必须成立）----------');
for (const k of CAP_SAFE) ok(k, caps[k] === true);

console.log('---------- 探针自证 ----------');
/*
 * 「jar 里有没有 AuthCookie.class」必须与「登录响应里有没有 HttpOnly Cookie」同向。
 * 否则「对照组报红」很可能只是拿错了包 —— 那种红比不报还糟。
 */
const consistent = HAS_COOKIE_CLASS === (caps.cookieIsHttpOnly === true);
ok('jar 内 class 与真机行为同向', consistent,
    `AuthCookie.class=${HAS_COOKIE_CLASS}/响应头含 HttpOnly=${caps.cookieIsHttpOnly}`);

console.log(`\n=== 汇总：${pass} PASS / ${fail} FAIL（expect=${EXPECT}）===`);
if (!consistent) { console.log('⚠️ 探针失效：jar 自证与行为不一致，本次结论作废'); process.exit(2); }
if (EXPECT === 'present') {
    console.log(fail === 0
        ? '⇒ 修复后：HttpOnly Cookie 通道在真机上成立，Bearer 兼容通道与响应体契约均未破坏'
        : '⇒ 修复后仍有失败项，见上');
} else {
    console.log(fail === 0
        ? '⇒ 修复前（对照组）：响应头里**没有** HttpOnly Cookie（能力确实不存在），且既有通道依旧可用'
        : '⇒ 对照组出现意外结果，见上');
}
process.exit(fail === 0 ? 0 : 1);
