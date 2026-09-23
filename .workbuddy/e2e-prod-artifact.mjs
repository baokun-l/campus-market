/**
 * 真机探针：**发版产物（-Pprod 的 jar）到底能不能跑起来**。
 *
 * 为什么单开一个：`-Pprod` 会从包里**物理剔除** application-demo.yml 与 db/demo-*.sql。
 * 剔除本身有红绿证明（见 probe-build-selfcheck.mjs），但"剔多了"这件事没人管：
 * 一旦资源集写错（比如把整个 db/ 或 application.yml 也排除掉），
 * 打包照样 BUILD SUCCESS、jar 条目数看起来也正常，
 * 直到部署到服务器上才发现**服务起不来** —— 而那时离上线只剩几分钟。
 *
 * 断言：
 *   A. 目标 jar 确实是 prod 包（demo 资源 = 0）—— 否则测的不是发版产物，直接退出码 2
 *   B. 它能真的起来并对外提供接口（不是"构建成功"就算数）
 *   C. 日志落盘能力在 prod 包里照样生效（logback-spring.xml 没被误排除）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const JAR = path.join(BE, 'target', 'campus-secondhand-backend-1.0.0.jar');
const JAVA = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const PORT = 8081;
const LOG_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'logs-prodjar');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? '  → ' + extra : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 读 jar 条目（与发版脚本同一套判据） ---------- */
function entries(jarPath) {
    const buf = fs.readFileSync(jarPath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { console.error('[FATAL] 不是合法 jar'); process.exit(2); }
    const total = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let n = 0; n < total; n++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) { console.error('[FATAL] 中央目录损坏'); process.exit(2); }
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const cmtLen = buf.readUInt16LE(off + 32);
        names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
        off += 46 + nameLen + extraLen + cmtLen;
    }
    return names;
}

if (!fs.existsSync(JAR)) { console.error('[FATAL] 找不到 jar'); process.exit(2); }
const names = entries(JAR);
const demo = names.filter((n) => /application-demo\.yml|db\/demo-/.test(n));
console.log(`jar 条目 ${names.length}，demo 资源 ${demo.length}`);

// A：目标必须是 prod 包，否则这条探针测的是另一个东西
if (demo.length !== 0) {
    console.error('[FATAL] 当前 target/ 里的不是 -Pprod 产物（仍有 demo 资源）⇒ 拒绝给出结论。');
    console.error('        先跑：node deploy/build-release.mjs --offline');
    process.exit(2);
}
ok('A1 目标 jar 是 prod 包（demo 资源 = 0）', true);
ok('A2 关键资源仍在包里（application.yml）', names.some((n) => n.endsWith('application.yml')));
ok('A3 关键资源仍在包里（application-prod.yml）', names.some((n) => n.endsWith('application-prod.yml')));
ok('A4 关键资源仍在包里（logback-spring.xml）', names.some((n) => n.endsWith('logback-spring.xml')));
ok('A5 mapper XML 仍在包里（MyBatis 映射）', names.some((n) => /mapper\/.*\.xml$/.test(n)));

/* ---------- B/C：真机起一次 ---------- */
if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
const child = spawn(JAVA, ['-jar', JAR, `--server.port=${PORT}`, `--app.log-dir=${LOG_DIR}`], {
    cwd: BE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
let out = '';
child.stdout.on('data', (c) => { out += c.toString('utf8'); });
child.stderr.on('data', (c) => { out += c.toString('utf8'); });

let ready = false, log = null;
for (let i = 0; i < 80; i++) {
    await sleep(1500);
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/goods?page=1&pageSize=3`);
        log = await res.json();
        if (typeof log.code === 'number') { ready = true; break; }
    } catch { /* 还没起来 */ }
}

if (!ready) {
    console.error('[FATAL] prod 包没起来（这是必须修的问题，不是探针问题）：\n' + out.slice(-3000));
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { }
    process.exit(2);
}
ok('B1 prod 包能真的启动并对外提供接口', true);
ok('B2 /api/goods 返回 code=0（不是启动成功但业务层报错）', log.code === 0, `code=${log.code} msg=${log.message}`);
ok('B3 分页体结构正常（list 非 records）', log.data && Array.isArray(log.data.list) && typeof log.data.total === 'number');
ok('B4 数据确实读到了（演示库非空）', log.data && log.data.list.length > 0, `list.length=${log.data?.list?.length}`);

await sleep(800);
const mainLog = path.join(LOG_DIR, 'campus-market.log');
ok('C1 prod 包里 logback 配置生效（日志文件已生成）', fs.existsSync(mainLog));
ok('C2 日志有内容', fs.existsSync(mainLog) && fs.readFileSync(mainLog, 'utf8').length > 0);

try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { }

console.log(`\n=== 汇总：${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
