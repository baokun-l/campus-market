/**
 * 真机探针：上传「次数闸门 + 魔数嗅探」（P1-10）在**真实进程**里到底成不成立。
 *
 * 用法：
 *   node .workbuddy/e2e-p110.mjs                                  # 用 dist/ 最新产物 ⇒ 期望能力「在」
 *   node .workbuddy/e2e-p110.mjs --jar=<路径> --expect=absent      # 用修复前产物 ⇒ 期望能力「不在」
 *
 * ── ★ 为什么两侧都锚 dist/ 的发版产物，而且用 jar 内容自证身份 ★ ──────────────
 * `target/` 里的 jar 会被下一次构建覆盖，红对照两侧因此都锚在 dist/ 的发版产物上；
 * 同时用「jar 里有没有 UploadQuotaGuard.class / ImageType.class」给这次运行自证身份 ——
 * 否则「对照组报红」很可能只是因为拿错了包，那种红比不报还糟。
 *
 * ── ★ 这轮只发 4 次上传请求，但这 4 次同时验三件事 ★ ──────────────────────
 * 闸门是**每用户窗口内 3 张**（用命令行把 user-max-uploads 压到 3，global 置 0=不限，
 * 这样观测到的拒绝必然来自「用户维度」，而不是被全站维度顺手兜住 —— 两个维度混在一起，
 * 报红时根本分不清是哪一条在起作用）。
 *
 *   请求①  html 字节、名字 x.png、声明 image/png   → 期望被魔数拒
 *   请求②  JPEG 字节、名字 evil.png、声明 image/png → 期望通过，且**存成 .jpg**
 *   请求③  同上，但名字带 `../../` 穿越             → 期望通过，落盘名里一个字符都不来自客户端
 *   请求④  同一张 JPEG                              → 期望被闸门拒
 *
 * 请求①②③ 都过闸门（**被魔数拒掉的那次同样计数**），所以走到④时用户额度恰好用满 3 张。
 * 这一点让④承担了双重证明：既证明「闸门存在」，也证明「**被拒的请求也被计数**」——
 * 假如有人把闸门挪到魔数校验之后，① 就不计数，④ 落在 count=2 上会被放行，本探针必须报红。
 *
 * ── 判定的两类口径（这两类的期望值**故意不同**）────────────────────────────
 *   · 能力类 capsPresent：随版本变化 —— 修复前应当**全 false**（这就是「红」），修复后全 true。
 *   · 安全类 capsSafe  ：与版本无关，**两组都必须成立**。安全属性不该因为换个包就消失，
 *                        若修复前反而「更安全」，说明判据测错了东西。
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
const LOGDIR = path.join(TMP, 'logs-p110');
const UPLOADDIR = path.join(TMP, 'uploads-p110');
const BASE = `http://127.0.0.1:${PORT}/api`;

/** 闸门额度：压到 3 张，且全站维度关闭（0 = 不限），让拒绝只可能来自用户维度 */
const USER_LIMIT = 3;
const WINDOW_SECONDS = 60;

const argv = process.argv.slice(2);
const arg = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : null;
};
const EXPECT = arg('expect') ?? 'present';
const jarArg = arg('jar');
/* ★ --jar 必须解析成绝对路径 ★（spawn 的 cwd 是 campus-secondhand-backend，
   而人习惯写相对**项目根**的路径） */
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
const jarContains = (needle) => fs.readFileSync(JAR).includes(Buffer.from(needle, 'utf8'));

/* ---------------- 前置 ---------------- */
if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar：' + JAR); process.exit(2); }
if (portBusy()) { console.error(`[FATAL] ${PORT} 被占用，先停后端`); process.exit(2); }
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(UPLOADDIR, { recursive: true });
fs.rmSync(LOGDIR, { recursive: true, force: true });

const jarName = path.basename(JAR);
const fp = (jarName.match(/-([0-9a-f]{12})-\d{12}\.jar$/) || [])[1] ?? null;   // 产物里的源码指纹
const HAS_GUARD = jarContains('security/UploadQuotaGuard.class');
const HAS_IMAGETYPE = jarContains('common/ImageType.class');

console.log('=== 真机探针 P1-10（上传次数闸门 + 魔数嗅探）===');
console.log(`  产物   ${jarName}`);
console.log(`  模式   expect=${EXPECT}`);
console.log(`  自证   jar 内含 UploadQuotaGuard.class=${HAS_GUARD}  ImageType.class=${HAS_IMAGETYPE}`);
if (!fp) console.log('  ⚠️ 产物名里没有 12 位源码指纹');

/* ---------------- 起进程 ---------------- */
const child = spawn(JAVA, [
    '-jar', JAR,
    `--server.port=${PORT}`,
    `--app.log-dir=${LOGDIR}`,
    `--app.upload.dir=${UPLOADDIR}`,
    `--app.upload-guard.user-max-uploads=${USER_LIMIT}`,
    '--app.upload-guard.global-max-uploads=0',
    `--app.upload-guard.window-seconds=${WINDOW_SECONDS}`,
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

/* ---------------- 请求工具 ---------------- */
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
async function upload(token, { bytes, filename, type } = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type }), filename);
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(`${BASE}/upload/image`, { method: 'POST', headers, body: fd });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
}

/** 1x1 真实 JPEG（最小合法图） */
const JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
);
/** 一段「长得像 HTML 的文本」：声明成 image/png 也拦不住它，只有看字节才拦得住 */
const HTML = Buffer.from('<!DOCTYPE html><html><body>not an image at all</body></html>', 'utf8');

const caps = {};

/* ---------------- 第 0 步：登录 ---------------- */
const login = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
const token = login.json?.data?.token;
if (!token) {
    console.error(`[FATAL] 登录失败：code=${login.json?.code} msg=${login.json?.message}`);
    killTree(child.pid);
    process.exit(2);
}

/* 安全类 · 匿名上传必须被拦（与版本无关：修复前后都得拒） */
{
    const r = await upload(null, { bytes: JPEG, filename: 'a.jpg', type: 'image/jpeg' });
    caps.anonymousUploadRejected = r.json?.code === 401;
}

/* ---------------- 请求①：html 字节，却声明成 png ⇒ 只有魔数能拦 ---------------- */
const r1 = await upload(token, { bytes: HTML, filename: 'x.png', type: 'image/png' });
caps.rejectsDeclaredImageWithNonImageBytes = r1.json?.code === 1001;
caps.noInternalDetailInRejection = !/Exception|java\.|C:\\|at com\./.test(r1.json?.message ?? '');

/* ---------------- 请求②：JPEG 字节，名字却叫 png ⇒ 扩展名必须由字节说了算 ---------------- */
const r2 = await upload(token, { bytes: JPEG, filename: 'evil.png', type: 'image/png' });
const url2 = r2.json?.data?.url ?? '';
caps.acceptsRealImage = r2.json?.code === 0 && !!url2;
caps.extensionComesFromBytes = /\.jpg$/.test(url2);

/* ---------------- 请求③：文件名带路径穿越 ⇒ 客户端名字一个字符都不该进落盘路径 ---------------- */
const r3 = await upload(token, { bytes: JPEG, filename: '../../../evil.png', type: 'image/png' });
const url3 = r3.json?.data?.url ?? '';
caps.traversalNameNeutralised = r3.json?.code === 0
    && !url3.includes('..') && !/evil/i.test(url3)
    && new RegExp(`^/uploads/\\d{4}/\\d{2}/[0-9a-f]{32}\\.(jpg|jpeg|png|gif|webp|bmp)$`).test(url3);

/* ---------------- 请求④：前三次都用掉了额度（含被魔数拒掉的那次）⇒ 这里必须被闸门拒 ------- */
const r4 = await upload(token, { bytes: JPEG, filename: 'over.jpg', type: 'image/jpeg' });
caps.quotaBlocksFourthAttempt = r4.json?.code === 1001;
/*
 * ★ 配置可到达性的真机出口 ★
 * 额度是命令行注入的（3 张 / 60 秒）。若「配置有没有到达变量」这一环断了，
 * 拒绝提示里的数字就不会是 3 与 60 —— 这是本仓「配置静默失效」那条教训留下的出口：
 * 光看配置写对了不算数，得让它在**响应体**上留下可观测的量。
 */
const m4 = String(r4.json?.message ?? '');
caps.quotaMessageCarriesEffectiveConfig = m4.includes(String(USER_LIMIT)) && m4.includes(String(WINDOW_SECONDS));

/* ---------------- 上传下来的图必须匿名可读（否则 <img> 全裂）---------------- */
{
    /*
     * ★ 这里必须带上 context-path `/api` ★
     * 接口返回的 `url` 是 `/uploads/2026/09/xxx.jpg`（**不含** /api），
     * 而静态资源映射挂在应用的 context-path 之下，前端 `<img src>` 用的也是
     * `/api/uploads/...`。第一版探针直接取 `url` 去 GET，拿回 404，差点被读成
     * 「上传能写但读不回来」的产品缺陷 —— 实际是探针少拼了一段前缀。
     */
    const res = await fetch(`http://127.0.0.1:${PORT}/api${url2}`);
    const buf = Buffer.from(await res.arrayBuffer());
    caps.uploadedFileReadableAnonymously = res.status === 200
        && buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

killTree(child.pid);
await sleep(300);

/* ---------------- 判定 ---------------- */
const CAP_PRESENT = [
    'rejectsDeclaredImageWithNonImageBytes',   // 魔数嗅探：声明挡不住，字节才挡得住
    'extensionComesFromBytes',                 // 落盘扩展名取自字节
    'quotaBlocksFourthAttempt',                // 闸门存在，且被拒的请求也计数
    'quotaMessageCarriesEffectiveConfig',      // 配置真的到达了变量（可观测出口）
];
const CAP_SAFE = [
    'anonymousUploadRejected',
    'noInternalDetailInRejection',
    'traversalNameNeutralised',
    'acceptsRealImage',
    'uploadedFileReadableAnonymously',
];

const detail = EXPECT === 'present' ? '' : `（修复前：code=${r4.json?.code} url2=${url2 || '-'}）`;
console.log('---------- 能力项（随版本变化）----------');
for (const k of CAP_PRESENT) {
    ok(EXPECT === 'present' ? k : `${k} 应不存在`, EXPECT === 'present' ? caps[k] === true : caps[k] === false);
}
console.log('---------- 安全项（两组都必须成立）----------' + detail);
for (const k of CAP_SAFE) {
    ok(k, caps[k] === true);
}

/* ---------------- 自证：jar 内容与行为必须一致 ---------------- */
console.log('---------- 探针自证 ----------');
/*
 * 「jar 里有没有那两个新 class」必须与「闸门/魔数到底生不生效」同向：
 *   有 class ⇒ 魔数必须真的在拦（请求①被拒）且闸门必须真的在拦（请求④被拒）
 *   没 class ⇒ 这两个能力必须**都不存在**
 * 两者不一致 ⇒ 说明这次拿到的包跟它的行为对不上，本次结论作废（宁可作废也不能给错结论）。
 */
const magicEffect = caps.rejectsDeclaredImageWithNonImageBytes === true;
const quotaEffect = caps.quotaBlocksFourthAttempt === true;
const consistent = HAS_IMAGETYPE === magicEffect && HAS_GUARD === quotaEffect;
ok('jar 内 class 与真机行为同向', consistent,
    `ImageType=${HAS_IMAGETYPE}/magic=${magicEffect}  UploadQuotaGuard=${HAS_GUARD}/quota=${quotaEffect}`);

console.log(`\n=== 汇总：${pass} PASS / ${fail} FAIL（expect=${EXPECT}）===`);
if (!consistent) { console.log('⚠️ 探针失效：jar 自证与行为不一致，本次结论作废'); process.exit(2); }
if (EXPECT === 'present') {
    console.log(fail === 0
        ? '⇒ 修复后：上传次数闸门与魔数嗅探的全部能力/安全项在真机上成立'
        : '⇒ 修复后仍有失败项，见上');
} else {
    console.log(fail === 0
        ? '⇒ 修复前（对照组）：这些能力**确实不存在** —— 真机红对照成立（同一探针在新产物上才会全绿）'
        : '⇒ 对照组出现意外结果，见上');
}
process.exit(fail === 0 ? 0 : 1);
