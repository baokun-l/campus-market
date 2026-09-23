/**
 * ==================================================================
 * 真机探针：AI 助手的「长度上限 + 调用闸门」到底有没有生效？
 * ==================================================================
 *
 * 对应缺陷 L9（原先三处，全仓 grep 命中 0）：
 *   ① 无长度上限 —— 单次请求可以塞进任意长度文本，把「生成 50-100 字描述」
 *      的成本放大成一次任意规模的生成；
 *   ② 无频控     —— 两个接口都要登录，但任何学生账号写个 for 循环就能打上万次，
 *      每次都是真实的 token 支出；
 *   ③ 输入直拼 prompt —— 见下方「为什么本探针不测第 ③ 条」。
 *
 * 判据全部锚在**用户能看到什么**（响应体的 code 与 message），
 * 不读配置、不看日志、不 grep 源码。
 *
 * ------------------------------------------------------------------
 * 场景 A（默认配置：上限 200 / 用户额度 30）
 *   A1 超长提问（201 字）        → 期望 code=1001 且提示里带「200」
 *   A2 恰好 200 字               → 期望 code=0（界面能打出来的量不能被后端拒掉）
 *   A3 空提问                    → 期望 code=1001
 *   A4 标题 201 字（生成描述）    → 期望 code=1001
 *
 * 场景 B（AI_GUARD_USER_MAX_CALLS=1，专为验证**次序**而设）
 *   B1 超长提问                  → 期望 1001 且提示是「过长」而不是「频繁」
 *   B2 合法提问                  → 期望 code=0
 *   B3 再来一次合法提问          → 期望 1001 且提示带「频繁」
 *
 *   ★ B1/B2 合起来证明的是「长度校验排在额度消耗之前」★
 *   若顺序反了，B1 会先把那唯一的 1 次额度吃掉，B2 就会拿到「频繁」而不是正常返回。
 *   这条判据刻意不依赖任何计时 —— 计时会随网络状况漂移，而次序是确定的。
 *   顺带，B3 同时证明了 `AI_GUARD_USER_MAX_CALLS` 这个环境变量**真的绑上了**
 *   （yml 占位符 → @Value）。这正是本项目踩过的「配置改了没反应」那一类：
 *   变量名少一个前缀就不报错、只是绑不上。
 *
 * ------------------------------------------------------------------
 * ★★ 为什么本探针<b>不</b>测第 ③ 条（输入直拼 prompt）★★
 *
 * 因为它在真机上**没有可观测出口**：本机没有可用的模型 key，
 * 无论我们把消息拼成一条还是两条，用户看到的都是同一段「降级模板文案」。
 * 硬测的话只能去 grep 源码 —— 那是「锚手段」，本项目已经因此误报过两次。
 * 第 ③ 条的证据是单测：`AiAssistantServiceTest` 用一个记录桩把
 * **真正传给模型的消息**存下来，断言「系统提示里绝不出现用户输入」。
 * 探针与单测各管一段，这里如实说明边界，不假装探针覆盖了它。
 *
 * ------------------------------------------------------------------
 * 用法：
 *   node .workbuddy/e2e-ai-guard.mjs --jar=<要测的 jar> [--label=修复前]
 * 不带 --jar 时用 campus-secondhand-backend/target 下的默认产物。
 *
 * 探针会自己检查 jar 里有没有 `AiQuotaGuard.class`，并打印出来 ——
 * 这是为了防「以为在测修复前、其实两者都是修复后」这种**对照失效**：
 * 两次结果一样时，先怀疑对照，而不是先庆祝。
 *
 * 退出码：0 = 全部符合预期 / 1 = 有判据不符 / 2 = 探针自身失效（起不来、登录不上）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const JAVA = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const PORT = 8082;
const BASE = `http://127.0.0.1:${PORT}/api`;
const LOG_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'logs-ai-guard');

const argOf = (name, dflt) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
};
/**
 * ★ 必须是绝对路径 ★
 * 本探针起 java 时用的是 `cwd: BE`，相对路径会被解析成「相对后端目录」，
 * 于是 `--jar=campus-secondhand-backend/dist/x.jar` 会变成
 * `campus-secondhand-backend/campus-secondhand-backend/dist/x.jar` ⇒ Unable to access jarfile。
 * （第一版就踩了这个：jar 自证那一步用的是探针自己的 cwd，能读到；java 那一步读不到。）
 */
const JAR = path.resolve(argOf('jar', path.join(BE, 'target', 'campus-secondhand-backend-1.0.0.jar')));
const LABEL = argOf('label', '未标注');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

if (!fs.existsSync(JAR)) {
    console.error(`[FATAL] 找不到 jar：${JAR}\n        先跑 deploy/build-release.mjs 或 mvn package`);
    process.exit(2);
}

/* ---------- jar 自证：这一次测的到底是不是「修复前」 ---------- */

/** 读 jar 中央目录，返回条目名列表（本仓 jar-entries/diff-two-jars 同一套做法） */
function jarEntries(jar) {
    const b = fs.readFileSync(jar);
    let eocd = -1;
    for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
        if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是合法的 zip/jar（找不到 EOCD）');
    const n = b.readUInt16LE(eocd + 10);
    let p = b.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < n; i++) {
        const nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
        out.push(b.toString('utf8', p + 46, p + 46 + nl));
        p += 46 + nl + el + cl;
    }
    return out;
}

const entries = jarEntries(JAR);
const hasGuard = entries.some((e) => e.endsWith('AiQuotaGuard.class'));
const hasAiTestStub = entries.some((e) => e.includes('AiAssistantServiceTest'));

log('=== AI 助手闸门 / 长度上限 真机实测（默认 profile，端口 8082）===');
log(`  被测产物  [${LABEL}]`);
log(`            ${JAR}`);
log(`  产物大小  ${fs.statSync(JAR).size} 字节`);
log(`  产物自证  AiQuotaGuard.class ${hasGuard ? '✓ 在（修复后产物）' : '✗ 不在（修复前产物）'}`
    + ` / 测试类 ${hasAiTestStub ? '在' : '不在'}`);

/* ---------- HTTP ---------- */

async function call(method, p, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 忽略 */ }
    return { httpStatus: res.status, text, json };
}

const MSG = (n) => '问'.repeat(n);

/** 起一个进程 → 登录 → 交给 fn → 关掉。返回 null 表示探针自身失效（调用方应 exit 2） */
async function withServer(extraEnv, fn) {
    if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
    const child = spawn(JAVA, ['-jar', JAR, `--server.port=${PORT}`, `--app.log-dir=${LOG_DIR}`], {
        cwd: BE, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { out += c.toString('utf8'); });

    const kill = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* 已退出 */ } };

    let ready = false;
    for (let i = 0; i < 80; i++) {
        await sleep(1500);
        try {
            const r = await fetch(`${BASE}/goods?page=1&pageSize=1`);
            if (typeof (await r.json()).code === 'number') { ready = true; break; }
        } catch { /* 还没起来 */ }
    }
    if (!ready) {
        log('  ✗ 进程没起来。日志末尾：');
        log(out.slice(-900).split(/\r?\n/).map((l) => '      ' + l).join('\n'));
        kill();
        return null;
    }

    try {
        const login = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
        const token = login.json?.data?.token;
        if (!token) {
            log(`  ✗ 登录失败：${login.text.slice(0, 200)}`);
            return null;
        }
        return await fn(token);
    } finally {
        kill();
        await sleep(2000);
    }
}

/** 把一条响应压成一行摘要，报告里好看 */
const brief = (r) => `code=${r.json?.code} msg=${JSON.stringify(
    (r.json?.message ?? (r.json?.data?.reply ? String(r.json.data.reply).slice(0, 24) + '…' : '')).slice(0, 60))}`;

const checks = [];
const check = (name, cond, detail) => {
    checks.push({ name, cond, detail });
    log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
};

/* ---------- 场景 A：默认配置 ---------- */
log('\n---------- 场景 A：默认配置（长度上限 200 / 用户额度 30）----------');

const A = await withServer({}, async (token) => {
    const r = {};
    r.overlong = await call('POST', '/ai/chat', { token, body: { message: MSG(201) } });
    log(`  A1 超长提问(201)      → ${brief(r.overlong)}`);
    r.exact = await call('POST', '/ai/chat', { token, body: { message: MSG(200) } });
    log(`  A2 恰好 200 字        → ${brief(r.exact)}`);
    r.blank = await call('POST', '/ai/chat', { token, body: { message: '   ' } });
    log(`  A3 空提问             → ${brief(r.blank)}`);
    r.longTitle = await call('POST', '/ai/generate-description', {
        token, body: { title: MSG(201), keywords: '九成新' }
    });
    log(`  A4 标题 201 字        → ${brief(r.longTitle)}`);
    r.longKeywords = await call('POST', '/ai/generate-description', {
        token, body: { title: '高数教材', keywords: MSG(201) }
    });
    log(`  A5 关键词 201 字      → ${brief(r.longKeywords)}`);
    return r;
});

if (!A) {
    log('\n[FATAL] 场景 A 的进程没起来 / 登录不上 ⇒ 实验设置有问题，本轮不作任何结论。');
    process.exit(2);
}

log('');
check('A1 超长提问被拒（1001）且提示带上限值 200',
    A.overlong.json?.code === 1001 && String(A.overlong.json?.message ?? '').includes('200'),
    `实际 ${brief(A.overlong)}`);
check('A2 恰好 200 字被放行（code=0）',
    A.exact.json?.code === 0,
    `实际 ${brief(A.exact)} —— 界面能打出来的量被后端拒掉，属于把可用性修坏了`);
check('A3 空提问被拒（1001）',
    A.blank.json?.code === 1001,
    `实际 ${brief(A.blank)}`);
check('A4 超长标题被拒（1001）',
    A.longTitle.json?.code === 1001,
    `实际 ${brief(A.longTitle)}`);
check('A5 超长关键词被拒（1001）',
    A.longKeywords.json?.code === 1001,
    `实际 ${brief(A.longKeywords)}`);

/* ---------- 场景 B：额度=1，验证「长度校验排在额度消耗之前」 ---------- */
log('\n---------- 场景 B：AI_GUARD_USER_MAX_CALLS=1（次序判据 + 环境变量绑定）----------');
log('  env AI_GUARD_USER_MAX_CALLS=1');

const B = await withServer({ AI_GUARD_USER_MAX_CALLS: '1' }, async (token) => {
    const r = {};
    r.overlong = await call('POST', '/ai/chat', { token, body: { message: MSG(201) } });
    log(`  B1 超长提问           → ${brief(r.overlong)}`);
    r.ok = await call('POST', '/ai/chat', { token, body: { message: '怎么退款' } });
    log(`  B2 合法提问（第 1 次） → ${brief(r.ok)}`);
    r.again = await call('POST', '/ai/chat', { token, body: { message: '怎么退款' } });
    log(`  B3 合法提问（第 2 次） → ${brief(r.again)}`);
    return r;
});

if (!B) {
    log('\n[FATAL] 场景 B 的进程没起来 ⇒ 无法验证次序，本轮结论不完整。');
    process.exit(2);
}

log('');
check('B1 超长请求被拦在「过长」而不是「频繁」',
    B.overlong.json?.code === 1001 && String(B.overlong.json?.message ?? '').includes('过长'),
    `实际 ${brief(B.overlong)} —— 若提示的是「频繁」，说明长度校验排在额度消耗之后`);
check('★ B2 超长请求没有吃掉额度：随后第一次合法提问正常返回（code=0）',
    B.ok.json?.code === 0,
    `实际 ${brief(B.ok)} —— 拿到「频繁」就说明 B1 先把额度消费掉了，即次序反了`);
check('B3 额度确实生效：第二次合法提问被拒（1001）且提示带「频繁」',
    B.again.json?.code === 1001 && String(B.again.json?.message ?? '').includes('频繁'),
    `实际 ${brief(B.again)} —— 若仍返回 code=0，说明 AI_GUARD_USER_MAX_CALLS 没绑上`
    + '（yml 占位符 → @Value 没打通，就是本项目「配置改了没反应」那一类）');

/* ---------- 汇总 ---------- */
const bad = checks.filter((c) => !c.cond).length;
log('\n========== 汇总 ==========');
log(`  被测产物 [${LABEL}]  AiQuotaGuard.class ${hasGuard ? '✓' : '✗'}`);
log(`  ${checks.length - bad} PASS / ${bad} FAIL`);
log(bad === 0
    ? `  ⇒ 全部符合预期：长度上限与调用闸门都生效，且长度校验排在额度消耗之前。`
    : `  ⇒ 有 ${bad} 条不符（若本产物是「修复前」，这正是预期的红）。`);

process.exit(bad === 0 ? 0 : 1);
