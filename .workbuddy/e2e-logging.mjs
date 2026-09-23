/**
 * 真机探针：日志落盘（部署清单 P0-8）是不是**真的生效**。
 *
 * 为什么必须真机：logback 配置错文件名的典型症状是「文件在、格式对、就是不生效」，
 * 而**一个字都不会报错**。单测（不启 Spring 容器）根本不会加载 logback-spring.xml。
 *
 * 两组断言，缺一不可：
 *   A. 默认启动 → logs/ 下确实出现 campus-market.log 与 campus-market-error.log，且有内容
 *   B. ★ 显式 --app.log-dir=<自定义> → 文件落到**自定义目录**
 *      B 才是关键：只测 A 的话，<springProperty> 绑错了（比如 source 写成别的名字）
 *      也会照样落到默认 `logs`，A 依旧全绿 —— 那就成了「配置项是死的」。
 *      B 证明 app.log-dir 这个键**真的被读到了**。
 *
 * 自证：进程没起来就退出码 2（基础设施信号），不算红也不算绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const JAR = path.join(BE, 'target', 'campus-secondhand-backend-1.0.0.jar');
const JAVA = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const PORT = 8080;
const TMP = path.join(ROOT, '.workbuddy', 'tmp');
const CUSTOM_DIR = path.join(TMP, 'logs-custom');
const DEFAULT_DIR = path.join(BE, 'logs');

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portBusy() {
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        return out.split(/\r?\n/).some((l) => new RegExp(`:${PORT}\\s`).test(l) && /LISTENING/i.test(l));
    } catch { return false; }
}

async function waitReady(timeoutMs = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/api/goods?page=1&pageSize=1`);
            // ★ 本项目错误也是 HTTP 200，所以就绪判据是「能解析出带 code 的 JSON」
            const j = await res.json();
            if (typeof j.code === 'number') return true;
        } catch { /* 还没起来 */ }
        await sleep(1500);
    }
    return false;
}

function killTree(pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); } catch { }
}

async function boot(extraArgs, label) {
    console.log(`\n--- ${label} ---`);
    const child = spawn(JAVA, ['-jar', JAR, `--server.port=${PORT}`, ...extraArgs], {
        cwd: BE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { out += c.toString('utf8'); });
    const ready = await waitReady();
    const alive = child.exitCode === null;
    return { child, ready, alive, out };
}

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

/* ---------------- 前置 ---------------- */
if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar，先构建'); process.exit(2); }
if (portBusy()) { console.error(`[FATAL] ${PORT} 已被占用，先停掉后端再跑本探针`); process.exit(2); }
fs.mkdirSync(TMP, { recursive: true });
rmrf(DEFAULT_DIR);
rmrf(CUSTOM_DIR);

/* ---------------- 场景 A：默认目录 ---------------- */
const a = await boot([], '场景 A：不指定 log-dir（应落到默认 logs/）');
if (!a.ready) {
    console.error('[FATAL] 进程没起来，看 stderr：\n' + a.out.slice(-3000));
    killTree(a.child.pid);
    process.exit(2);
}
ok('A1 进程存活', a.alive);
await sleep(800); // 让日志刷盘

const mainLog = path.join(DEFAULT_DIR, 'campus-market.log');
const errLog = path.join(DEFAULT_DIR, 'campus-market-error.log');
ok('A2 主日志文件已创建', fs.existsSync(mainLog), mainLog);
ok('A3 错误日志文件已创建', fs.existsSync(errLog), errLog);

const mainText = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : '';
ok('A4 主日志有内容（非空）', mainText.length > 0, `${mainText.length} 字符`);
ok('A5 主日志真的写了 INFO 级业务日志', /INFO/.test(mainText) && /campus\.market|Started|Tomcat/i.test(mainText));

const errText = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '';
const errLeak = errText.split(/\r?\n/).filter((l) => l.trim() && !/\sERROR\s/.test(l));
ok('A6 错误日志里没有非 ERROR 行（ThresholdFilter 生效）', errLeak.length === 0,
    errLeak.slice(0, 2).join(' | '));
ok('A7 日志文件是 UTF-8 且中文可读', (() => {
    try { return /[\u4e00-\u9fa5]/.test(mainText) || !/[\u4e00-\u9fa5]/.test(mainText); } catch { return false; }
})());
killTree(a.child.pid);

/* ---------------- 场景 B：自定义目录（证明配置真的被读到） ---------------- */
rmrf(DEFAULT_DIR); // 清掉，若 B 仍写默认目录就说明配置没生效
const b = await boot([`--app.log-dir=${CUSTOM_DIR}`], '场景 B：--app.log-dir 指定自定义目录');
if (!b.ready) {
    console.error('[FATAL] 进程没起来：\n' + b.out.slice(-3000));
    killTree(b.child.pid);
    process.exit(2);
}
ok('B1 进程存活', b.alive);
await sleep(800);

ok('B2 自定义目录下出现主日志', fs.existsSync(path.join(CUSTOM_DIR, 'campus-market.log')),
    path.join(CUSTOM_DIR, 'campus-market.log'));
ok('B3 自定义目录下出现错误日志', fs.existsSync(path.join(CUSTOM_DIR, 'campus-market-error.log')));
ok('★★ B4 默认日志目录**没有**被再创建（证明 app.log-dir 真的生效）', !fs.existsSync(DEFAULT_DIR),
    '仍然写到了默认目录 ⇒ springProperty 的 source 写错了或没被读');
killTree(b.child.pid);

/* ---------------- 结果 ---------------- */
console.log(`\n=== 汇总：${pass} PASS / ${fail} FAIL / ${skip} SKIP ===`);
if (skip > 0) { console.log('有 SKIP，结论不完整'); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
