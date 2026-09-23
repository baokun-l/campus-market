/**
 * ==================================================================
 * 真机探针：支付配置的**环境变量名到底该写成什么**？
 * ==================================================================
 *
 * 起因（读代码时发现的：注释自己也对不上）：
 *   `AlipaySandboxPayChannel` 的 Javadoc 同一行里写着
 *     {@code APP_PAY_ALIPAY_APP_ID} / … / {@code PAY_PUBLIC_BASE_URL}
 *   ——前三个带 APP_ 前缀，第四个不带。`PayProperties` 的注释也写 PAY_PUBLIC_BASE_URL。
 *   而 `app.pay.*` 在 yml 里**没有任何占位符**（resources 里连 pay: 段都没有），
 *   只能靠 Spring Boot 的 relaxed binding 从环境变量绑定：
 *     app.pay.public-base-url  ←→  APP_PAY_PUBLIC_BASE_URL
 *   少一个 APP_ 前缀就绑不上，而且**不会报任何错** ——
 *   publicBaseUrl 保持空 ⇒ notifyUrl() 返回 null ⇒ 支付宝渠道静默从收银台消失。
 *
 * 这正是本项目最怕的一类缺陷（改了配置、没反应、日志干净）。
 * 而它恰好就是唯一还挂着 ⚠️ 的 P0-11（支付回调地址）。
 *
 * 三个场景（同一份 jar、同一个库、只改环境变量名）：
 *   A 全用 APP_PAY_*（假定正确）         ⇒ 期望收银台**出现** alipay_sandbox
 *   B 全用 PAY_*（当前文档写法）          ⇒ 期望**不出现**（名字绑不上）
 *   C 密钥用 APP_PAY_*、只有回调地址用 PAY_PUBLIC_BASE_URL
 *     ⇒ 这是"用户照着文档配、其他照抄正确名字"的真实场景
 *       期望**不出现** ⇒ 证明照文档配 = 渠道静默消失
 *
 * 判据用 `GET /pay/channels`（收银台实际可用渠道）——
 * 不读配置、不看日志，只看**用户会看到什么**。
 *
 * 注意：密钥用假值即可。`available()` 只判「非空」（configured()），
 * 本探针不发起任何真实支付调用，所以假密钥足够，且不会碰任何资金通道。
 *
 * 退出码：0 = 结论明确 / 2 = 探针自身失效（起不来、登录不上）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const JAR = path.join(BE, 'target', 'campus-secondhand-backend-1.0.0.jar');
const JAVA = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const PORT = 8082;
const BASE = `http://127.0.0.1:${PORT}/api`;
const LOG_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'logs-pay-env');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar，先跑 deploy/build-release.mjs'); process.exit(2); }

/* ---------- 公共环境 ----------
 * ★ 为什么**不用** prod profile（第一版用了，探针直接失效）★
 * prod 下 `DeploymentGuard.requireRealDbPassword` 会拒绝 `DB_PASSWORD=123456`（弱口令护栏，工作正常），
 * 而本地 MySQL 的密码**就是** 123456 ⇒ 三个场景全部「进程没起来」，一条结论都给不出。
 * 本探针要测的是**环境变量的绑定行为**（relaxed binding），它与 profile 完全无关：
 *   app.pay.public-base-url ←→ APP_PAY_PUBLIC_BASE_URL 的映射不因 profile 而变。
 * 所以用默认 profile。代价：demo 渠道也会出现在收银台 —— 不影响判据（本探针只看 alipay_sandbox）。
 * dev 的 sql.init 是 always，但 schema-auto.sql 是 IF NOT EXISTS、seed 只在空表灌 ⇒ 幂等，不动数据。 */
const COMMON = {};

const FAKE_APP_ID = '2021000000000000';
const FAKE_PRIVATE = 'FAKE_PRIVATE_KEY_FOR_PROBE_ONLY';
const FAKE_PUBLIC = 'FAKE_PUBLIC_KEY_FOR_PROBE_ONLY';
const BASE_URL = 'https://market.example.edu.cn';

const SCENARIOS = [
    {
        name: 'A 全用 APP_PAY_*（假定正确）',
        env: {
            APP_PAY_ENABLED_CHANNELS: 'wallet,alipay_sandbox',
            APP_PAY_PUBLIC_BASE_URL: BASE_URL,
            APP_PAY_ALIPAY_APP_ID: FAKE_APP_ID,
            APP_PAY_ALIPAY_PRIVATE_KEY: FAKE_PRIVATE,
            APP_PAY_ALIPAY_PUBLIC_KEY: FAKE_PUBLIC
        },
        expectAlipay: true
    },
    {
        name: 'B 全用 PAY_*（当前文档写法）',
        env: {
            PAY_ENABLED_CHANNELS: 'wallet,alipay_sandbox',
            PAY_PUBLIC_BASE_URL: BASE_URL,
            PAY_ALIPAY_APP_ID: FAKE_APP_ID,
            PAY_ALIPAY_PRIVATE_KEY: FAKE_PRIVATE,
            PAY_ALIPAY_PUBLIC_KEY: FAKE_PUBLIC
        },
        expectAlipay: false
    },
    {
        name: 'C 密钥用 APP_PAY_*，只有回调地址用 PAY_PUBLIC_BASE_URL（照文档配的真实场景）',
        env: {
            APP_PAY_ENABLED_CHANNELS: 'wallet,alipay_sandbox',
            PAY_PUBLIC_BASE_URL: BASE_URL,          // ← 只有这一个"照文档"
            APP_PAY_ALIPAY_APP_ID: FAKE_APP_ID,
            APP_PAY_ALIPAY_PRIVATE_KEY: FAKE_PRIVATE,
            APP_PAY_ALIPAY_PUBLIC_KEY: FAKE_PUBLIC
        },
        expectAlipay: false
    }
];

async function call(method, p, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { text, json };
}

async function runScenario(s) {
    log(`\n========== ${s.name} ==========`);
    for (const [k, v] of Object.entries(s.env)) log(`  env ${k}=${v}`);
    if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });

    const child = spawn(JAVA, ['-jar', JAR, `--server.port=${PORT}`, `--app.log-dir=${LOG_DIR}`], {
        cwd: BE, env: { ...process.env, ...COMMON, ...s.env },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { out += c.toString('utf8'); });

    let ready = false;
    for (let i = 0; i < 80; i++) {
        await sleep(1500);
        try {
            const r = await fetch(`${BASE}/goods?page=1&pageSize=1`);
            if (typeof (await r.json()).code === 'number') { ready = true; break; }
        } catch { /* 还没起来 */ }
    }

    if (!ready) {
        // 起不来也要如实记录：可能是护栏拦下（那是好事），也可能是别的问题
        const guard = out.split(/\r?\n/).filter((l) => /DeploymentGuard|FATAL|拒绝启动|缺少|missing/i.test(l)).slice(-6);
        log('  ✗ 进程没起来。日志末尾相关行：');
        guard.forEach((l) => log('      ' + l.trim()));
        log('  原始末尾：\n' + out.slice(-800).split(/\r?\n/).map((l) => '      ' + l).join('\n'));
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { }
        return { started: false, codes: null, guard: guard.join(' | ') };
    }

    const login = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
    const token = login.json?.data?.token;
    if (!token) {
        log(`  ✗ 登录失败：${login.text.slice(0, 200)}`);
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { }
        return { started: true, codes: null, loginFailed: true };
    }

    const ch = await call('GET', '/pay/channels', { token });
    const codes = (ch.json?.data ?? []).map((c) => c.code);
    log(`  GET /pay/channels → ${JSON.stringify(codes)}`);

    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { }
    await sleep(2000);
    return { started: true, codes };
}

/* ---------- 主流程 ---------- */
log('=== 支付配置环境变量名实测（默认 profile，端口 8082）===');
log(`jar  ${JAR}`);

const results = [];
for (const s of SCENARIOS) {
    results.push({ s, r: await runScenario(s) });
}

log('\n========== 汇总 ==========');
for (const { s, r } of results) {
    const state = !r.started ? (r.guard ? '启动被拦：' + r.guard.slice(0, 90) : '启动失败')
        : r.codes === null ? '登录失败'
            : (r.codes.includes('alipay_sandbox') ? 'alipay_sandbox 出现' : 'alipay_sandbox 消失');
    const exp = s.expectAlipay ? '期望出现' : '期望消失';
    log(`  ${s.name.slice(0, 12)}…  ${exp}  →  实际 ${state}`);
}

/* ---------- 判定 ---------- */
const A = results[0].r, B = results[1].r, C = results[2].r;
let fatal = 0;

if (!A.started || !A.codes) {
    log('\n[FATAL] 场景 A 就没起来 ⇒ 实验设置有问题，无法对变量名下任何结论。');
    fatal = 1;
} else if (!A.codes.includes('alipay_sandbox')) {
    log('\n[FATAL] 场景 A（APP_PAY_* 全配）里 alipay_sandbox **仍然没出现** ⇒');
    log('        说明连 APP_PAY_* 也绑不上，或还有别的必要条件缺着。');
    log('        此时**不能**得出"B 的名字错了"——A 本来就不成立。必须先查清 A。');
    fatal = 1;
}

if (fatal) process.exit(2);

const bHas = B.codes?.includes('alipay_sandbox') ?? false;
const cHas = C.codes?.includes('alipay_sandbox') ?? false;

log('\n========== 结论 ==========');
log(`  A（APP_PAY_* 全配）            alipay_sandbox ${A.codes.includes('alipay_sandbox') ? '✓ 出现' : '✗ 消失'}`);
log(`  B（PAY_* 全配，文档写法）        alipay_sandbox ${bHas ? '出现' : '✗ 消失'}${B.started ? '' : '（进程未启动）'}`);
log(`  C（仅回调地址用文档写法）        alipay_sandbox ${cHas ? '出现' : '✗ 消失'}${C.started ? '' : '（进程未启动）'}`);

let bad = 0;
const assert = (name, cond) => { log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) bad++; };

assert('A：APP_PAY_* 命名能被 Spring 绑定（正对照成立）', A.codes.includes('alipay_sandbox'));
assert('B：全用 PAY_* 绑不上 ⇒ 渠道静默消失', !bHas);
assert('C：仅回调地址少 APP_ 前缀 ⇒ 渠道同样消失（照文档配就是这个后果）', !cHas);

log('');
if (bad === 0) {
    log('⇒ 结论：`app.pay.*` 的环境变量必须写成 **APP_PAY_***（relaxed binding）。');
    log('   文档里写的 PAY_PUBLIC_BASE_URL 是**错的** —— 照它配置，支付宝渠道会静默从收银台消失，');
    log('   而且没有任何报错。'); 
} else {
    log(`⇒ ${bad} 条与预期不符，见上面逐条结果。`);
}
process.exit(bad === 0 ? 0 : 1);
