/**
 * ==================================================================
 * 探针：发版产物**可复现**吗？—— 并且证明这个探针**有判别力**
 * ==================================================================
 *
 * 背景（不是假想，是本仓库实测到的）：
 *   dist/ 里出现过**两个不同大小**的产物（53764139B vs 53764901B），
 *   逐条比对后 **73 个条目内容不同**（含 72 个我方 .class）。
 *   javap 反汇编定位：字符串拼接的降级策略不同 ——
 *   `invokedynamic makeConcatWithConstants` vs `String.valueOf` + indy，
 *   常量池 122 条 vs 128 条。
 *   根因：本机 `JAVA_HOME` 指向 `D:\Android\Android Studio\jbr`（JetBrains Runtime，
 *   **是 Java 21**），手工构建用的是 `jdk-17`。
 *   ⇒ 产物取决于"开发机当时开着什么 IDE"，那"我测过的包"和"我发出去的包"
 *     就无法用任何哈希对上。
 *
 * 为什么这个探针有三轮，而不是两轮：
 *   ★ 「连跑两次得到同一个 sha」**只证明了两件事相同，没证明这两件事是什么**。
 *     一个坏掉的探针（比如它其实在比对同一个文件、或者它比对的是空值）
 *     同样会输出"相同"。所以必须补一个**对照组**：故意用错误的 JDK 编一次，
 *     它**必须**与前两轮不同。若连它都相同 ⇒ 探针无判别力，结论作废。
 *   这正是本项目"只报绿不算证明，要报出红→绿"那条纪律的落地。
 *
 * 三轮：
 *   run1  走 deploy/build-release.mjs --offline（脚本自己钉 JDK 17）
 *   run2  同上，独立重建        ⇒ 期望与 run1 **相同**（可复现）
 *   run3  绕过发版脚本，直接用错误 JDK 编 ⇒ 期望与前两轮 **不同**（判别力）
 *
 * 退出码：0 = 绿且判别力成立 / 1 = 产物不可复现 / 2 = 探针自身失效或判别力不足
 * 用法：node .workbuddy/probe-reproducible.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const DIST = path.join(BE, 'dist');
const TARGET = path.join(BE, 'target');
const KEEP = path.join(ROOT, '.workbuddy', 'tmp', 'repro-keep');

/**
 * 已知的"错误 JDK"候选（用于对照组）。
 * ★ 必须排除 major === 17 ★：若本机 JAVA_HOME 恰好就是 17，
 *   对照组就退化成"又跑一遍 17" —— 它会理所当然地相同，
 *   而那个"相同"跟判别力毫无关系。宁可判定"未做检验"，也不能拿它冒充证据。
 * 一个都找不到就跳过，并**明说未做判别力检验**。
 */
function javaMajor(javaExe) {
    const r = spawnSync(`"${javaExe}"`, ['-version'], { encoding: 'latin1', shell: true });
    const m = ((r.stderr || '') + (r.stdout || '')).match(/version "(\d+)/);
    return m ? Number(m[1]) : null;
}
const WRONG_JDK = [
    process.env.JAVA_HOME,
    'D:\\Android\\Android Studio\\jbr',
    'C:\\Program Files\\Java\\jdk-21',
    '/usr/lib/jvm/java-21-openjdk-amd64'
]
    .filter(Boolean)
    .filter((p) => fs.existsSync(path.join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')))
    .filter((p) => {
        const major = javaMajor(path.join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
        if (major === 17) { log(`  [对照候选排除] ${p} → java 17（与目标一致，无法用作对照）`); return false; }
        return true;
    });

const log = (m) => console.log(m);
const fail = (m) => { console.error('\n[FATAL] ' + m); process.exit(2); };

/* ---------- jar 读取：中央目录 + 逐条内容 sha ---------- */
function readEntries(jarPath) {
    const buf = fs.readFileSync(jarPath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail('不是合法 zip/jar：' + jarPath);
    const total = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const map = new Map();
    for (let n = 0; n < total; n++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) fail('中央目录解析失败 @' + off);
        const method = buf.readUInt16LE(off + 10);
        const csize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const cmtLen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        if (buf.readUInt32LE(lho) !== 0x04034b50) fail('本地头解析失败：' + name);
        const lNameLen = buf.readUInt16LE(lho + 26);
        const lExtraLen = buf.readUInt16LE(lho + 28);
        const start = lho + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + csize);
        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else fail('未知压缩方法 ' + method + ' @' + name);
        map.set(name, crypto.createHash('sha256').update(data).digest('hex'));
        off += 46 + nameLen + extraLen + cmtLen;
    }
    if (map.size === 0) fail('jar 条目数为 0：' + jarPath);
    return map;
}

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const wipe = (p) => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); };

/** 把一个 jar 收进留档目录并返回记录（两轮若同分钟同名，不留档就会被覆盖） */
function archive(jarPath, label) {
    const name = path.basename(jarPath);
    const size = fs.statSync(jarPath).size;
    if (size < 10 * 1048576) fail(`${label} 产物只有 ${size}B，不像 fat jar`);
    const sha = sha256File(jarPath);
    const dir = path.join(KEEP, label);
    wipe(dir);
    fs.mkdirSync(dir, { recursive: true });
    const kept = path.join(dir, name);
    fs.copyFileSync(jarPath, kept);
    log(`\n  [留档] ${label}: ${name}  ${size}B  sha256=${sha.slice(0, 16)}...`);
    return { name, size, sha, path: kept };
}

/* ---------- 三种构建方式 ---------- */
function viaReleaseScript(label) {
    wipe(DIST);
    wipe(TARGET);
    // ★ 用 process.execPath ★：不依赖 PATH 里的 node，也不用 shell —— .mjs 不是 .cmd。
    const r = spawnSync(process.execPath, ['deploy/build-release.mjs', '--offline'], { cwd: BE, stdio: 'inherit' });
    if (r.status !== 0) fail(`${label} 构建失败（退出码 ${r.status}）`);
    const jars = fs.readdirSync(DIST).filter((f) => f.endsWith('.jar'));
    if (jars.length !== 1) fail(`${label} 期望 dist 里恰好 1 个 jar，实际 ${jars.length} 个`);
    return archive(path.join(DIST, jars[0]), label);
}

/**
 * 对照组：绕过 build-release.mjs，**故意**把 JAVA_HOME 指向错误的 JDK。
 * 目的不是"复现一个 bug"，而是检验上面那个"相同"的结论**是不是瞎说的**。
 */
function viaWrongJdk(label, javaHome) {
    wipe(DIST);
    wipe(TARGET);
    log(`\n========== ${label}（对照组：故意用错误 JDK）==========`);
    log(`  JAVA_HOME = ${javaHome}`);
    const mvnw = process.platform === 'win32' ? 'mvnw.cmd' : './mvnw';
    const r = spawnSync(mvnw, ['-Pprod', '-o', 'clean', 'package', '-DskipTests'], {
        cwd: BE,
        env: { ...process.env, JAVA_HOME: javaHome },
        shell: process.platform === 'win32',
        stdio: 'inherit'
    });
    if (r.status !== 0) fail(`${label} 构建失败（退出码 ${r.status}）`);
    const jar = path.join(TARGET, 'campus-secondhand-backend-1.0.0.jar');
    if (!fs.existsSync(jar)) fail(`${label} 找不到 target 里的 jar`);
    // 记录编译器版本，让"对照组到底用了什么"有据可查
    const v = spawnSync(`"${path.join(javaHome, 'bin', 'java.exe')}"`, ['-version'], { encoding: 'latin1', shell: true });
    const vm = ((v.stderr || '') + (v.stdout || '')).match(/version "([^"]+)"/);
    log(`  实际编译器 java ${vm ? vm[1] : '?'}`);
    return archive(jar, label);
}

/* ---------- 主流程 ---------- */
log('=== 可复现性探针：run1 / run2（应相同）+ run3（对照组，应不同）===');
wipe(KEEP);

const a = viaReleaseScript('run1');
const b = viaReleaseScript('run2');

log('\n========== 判定 1：可复现性 ==========');
log(`run1  ${a.size}B  ${a.sha}`);
log(`run2  ${b.size}B  ${b.sha}`);
const reproducible = a.sha === b.sha;

if (!reproducible) {
    log('\n✗ 红：两次产物 sha256 不同。逐条目定位差异…');
    const ea = readEntries(a.path), eb = readEntries(b.path);
    const onlyA = [...ea.keys()].filter((k) => !eb.has(k));
    const onlyB = [...eb.keys()].filter((k) => !ea.has(k));
    const diff = [...ea.keys()].filter((k) => eb.has(k) && ea.get(k) !== eb.get(k));
    log(`  条目数  run1=${ea.size}  run2=${eb.size}`);
    log(`  仅 run1 有：${onlyA.length}${onlyA.length ? '  ' + onlyA.slice(0, 8).join(', ') : ''}`);
    log(`  仅 run2 有：${onlyB.length}${onlyB.length ? '  ' + onlyB.slice(0, 8).join(', ') : ''}`);
    log(`  内容不同  ：${diff.length}`);
    for (const d of diff.slice(0, 40)) log(`      · ${d}`);
    if (diff.length > 40) log(`      … 另有 ${diff.length - 40} 条`);
    const mine = diff.filter((d) => /^BOOT-INF\/classes\/.*\.class$/.test(d));
    log(`\n  其中我方 .class ${mine.length} 条 ⇒ ${mine.length ? '编译器不一致（JDK 没钉住）' : '多为元数据（MANIFEST/pom.properties）⇒ outputTimestamp 没覆盖到'}`);
    process.exit(1);
}
log('\n✓ 可复现：两次产物 **字节完全相同**。');

/* ---------- 判定 2：判别力（不能省） ---------- */
log('\n========== 判定 2：探针判别力（对照组）==========');
if (WRONG_JDK.length === 0) {
    log('⚠️  本机找不到"非 17 的 JDK"可用于对照 ⇒ **未做判别力检验**。');
    log('    结论只到"两次相同"这一步，不能声称已证明探针能分辨差异。');
    process.exit(2);
}
const c = viaWrongJdk('run3', WRONG_JDK[0]);

log('\n========== 判定 2 结果 ==========');
log(`run1(17)  ${a.size}B  ${a.sha.slice(0, 16)}...`);
log(`run2(17)  ${b.size}B  ${b.sha.slice(0, 16)}...`);
log(`run3(错)  ${c.size}B  ${c.sha.slice(0, 16)}...`);

if (c.sha === a.sha) {
    log('\n✗ 对照组产物与 run1 **完全相同** —— 探针没有判别力，前面的"绿"不可信。');
    log('  两种可能：① 探针读的不是同一批文件/读到了空值；② 该项目里换 JDK 真的不影响产物。');
    log('  无论哪种，都不能声称"已证明构建可复现"。');
    process.exit(2);
}

const ea = readEntries(a.path), ec = readEntries(c.path);
const diff = [...ea.keys()].filter((k) => ec.has(k) && ea.get(k) !== ec.get(k));
const mine = diff.filter((k) => /^BOOT-INF\/classes\/.*\.class$/.test(k));
log(`\n✓ 判别力成立：错误 JDK 的产物与前两轮**不同**。`);
log(`  逐条定位：${diff.length} 个条目不同，其中我方 .class ${mine.length} 个`);
for (const d of mine.slice(0, 10)) log(`      · ${d}`);
if (mine.length > 10) log(`      … 另有 ${mine.length - 10} 个`);

/* 别把对照组（错误 JDK 编的）留在 target/ 里误导后续 */
wipe(TARGET);
log('\n  （已清空 target/，避免留下对照组编出的产物）');
log('\n=== 总结：run1 == run2（可复现）且 run3 ≠ run1（有判别力）===');
log(`发布件 sha256 = ${a.sha}`);
process.exit(0);
