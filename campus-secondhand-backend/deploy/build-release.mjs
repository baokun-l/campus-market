#!/usr/bin/env node
/**
 * ==================================================================
 * 发版构建脚本 —— ★ 在**开发机 / CI** 上运行，**绝不在服务器上运行** ★
 * ==================================================================
 *
 * 存在理由（部署清单 P0-7）：
 *   本项目依赖 spring-ai 里程碑版，构建需要访问 repo.spring.io。
 *   服务器若在无外网 / 只放行国内镜像的环境里构建，**构建会直接失败**。
 *   把"能不能连上境外 Maven 仓库"变成上线的前置条件，是最不必要的一类故障源。
 *   ⇒ 采用部署清单的推荐方案：**构建在本机完成，服务器只执行 java -jar。**
 *   本脚本把这条约定从"文档里的一句话"变成"一个能跑的命令 + 可校验的产物"。
 *
 * 它做了四件事：
 *   1. 用 mvnw + -Pprod 打包（demo 资源被物理剔除，见 pom.xml 的 profiles 段）；
 *   2. 产物重命名为带版本/commit/时间的名字 → 出事后能回答"线上跑的是哪个 commit"；
 *   3. 产出 .sha256 校验和 → 传输损坏与"传错文件"都能被发现；
 *   4. ★ 自检产物本身 ★：解 jar 里有没有 demo 脚本、有没有 logback-spring.xml。
 *      构建脚本自己撒谎（打出来的包跟预期不符却报成功）是最贵的失败，
 *      所以这里不信任"BUILD SUCCESS"这四个字。
 *
 * 用法：
 *   node deploy/build-release.mjs              # 跳过测试（快）
 *   node deploy/build-release.mjs --tests      # 先跑全量单测再打包
 *   node deploy/build-release.mjs --offline    # 强制离线构建（验证依赖是否齐备）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ★ 必须用 fileURLToPath ★：本仓库路径含中文，直接取 URL.pathname 会拿到
//   百分号编码的串（%E8%BD%AF%E4%BB%B6...），spawn 出去必然找不到目录。
const BE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const runTests = argv.includes('--tests');
const offline = argv.includes('--offline');

const log = (m) => console.log(m);
const die = (m) => { console.error('\n[FATAL] ' + m); process.exit(2); };

function sh(cmd, args, opts = {}) {
    // ★ .cmd / .mjs 在 Windows 上必须经 shell 启动，否则 ENOENT 且**零输出** ★
    return spawnSync(cmd, args, { shell: process.platform === 'win32', encoding: 'utf8', ...opts });
}

/* ---------- 0. ★ 把 JDK 钉死（本脚本存在的最重要理由之一） ---------- */
/**
 * ★★ 为什么必须在这里钉 JDK，而不是"用环境变量里那个" ★★
 *
 * 实测踩过：本机 `JAVA_HOME` 指向 `D:\Android\Android Studio\jbr`
 * （Android Studio 自带的 JetBrains Runtime）。于是同一个 pom、同一份源码，
 * 「手动指定 jdk-17 构建」与「让脚本沿用环境变量构建」产出的
 * `Result.class` **字节码都不一样**（字符串拼接的降级策略从 indy 变成
 * `String.valueOf` + indy，常量池条目数 122 vs 128）。
 *
 * 后果不是"小差异"：产物取决于**开发机当时开着什么 IDE**，
 * 那么"我测过的包"和"我发出去的包"就无法用任何哈希对上。
 *
 * ⇒ 所以本脚本**不信任环境变量**：自己解析出一个真正的 JDK 17，
 *   用它覆盖 JAVA_HOME，并把解析过程打印出来（可复核）。
 *   解析顺序：--java-home 参数 > JDK17_HOME > 已是 17 的 JAVA_HOME > 常见安装路径。
 *   一个都找不到就**直接失败**，绝不"凑合用 21 也能编"—— 那样就回到不可复现了。
 */
function javaMajor(javaExe) {
    const r = spawnSync(`"${javaExe}"`, ['-version'], { encoding: 'utf8', shell: true });
    const t = (r.stderr || '') + (r.stdout || '');
    const m = t.match(/version "(\d+)/);
    return m ? Number(m[1]) : null;
}

const javaHomeArg = (argv.find((a) => a.startsWith('--java-home=')) || '').split('=')[1];
const candidates = [
    javaHomeArg,
    process.env.JDK17_HOME,
    process.env.JAVA_HOME,
    'C:\\Program Files\\Java\\jdk-17',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.11.9-hotspot',
    '/usr/lib/jvm/java-17-openjdk-amd64',
    '/usr/lib/jvm/temurin-17-jdk-amd64'
].filter(Boolean);

let javaHome = null;
for (const c of candidates) {
    const exe = path.join(c, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (!fs.existsSync(exe)) continue;
    const major = javaMajor(exe);
    if (major === 17) { javaHome = c; break; }
    log(`  [跳过] ${c} → java ${major ?? '?'}（本项目要求 17）`);
}
if (!javaHome) {
    die('找不到 JDK 17。构建必须钉在一个干净的 17 上，否则产物会随开发机变化。\n' +
        '        请设置 JDK17_HOME，或传 --java-home=<path>。');
}

log('== 发版构建 ==');
log(`JDK      ${javaHome}`);
if (process.env.JAVA_HOME && process.env.JAVA_HOME !== javaHome) {
    log(`  ⚠️  环境变量 JAVA_HOME 指向 ${process.env.JAVA_HOME}（不是 17）—— 已忽略，改用上面的路径。`);
    log('     忽略是刻意的：本机 JAVA_HOME 曾指向 Android Studio 的 JBR，');
    log('     用它编出来的 class 与 JDK 17 并不相同，产物就不可复现了。');
}
const env = { ...process.env, JAVA_HOME: javaHome };
const pomText = fs.readFileSync(path.join(BE, 'pom.xml'), 'utf8');

/**
 * 取**本项目**的版本号。
 * ★ 不能用「第一个 <version>」★：pom 里第一个 <version> 是父工程 spring-boot-starter-parent
 * 的版本（3.2.5），照抄就会把产物命名成 campus-market-3.2.5-...，与依赖版本混淆。
 * 必须定位到本项目 artifactId 之后的那个 <version>。
 */
const version = (() => {
    const own = pomText.match(
        /<artifactId>\s*campus-secondhand-backend\s*<\/artifactId>\s*<version>\s*([^<\s]+)\s*<\/version>/
    );
    if (own) return own[1];
    // 退化路径也必须自证：拿不准就报出来，别默默填一个像样的错值
    console.warn('[WARN] 未能从 pom 定位本项目版本，退回 0.0.0（产物名将不可比对版本）');
    return '0.0.0';
})();

const gitSha = (() => {
    const r = sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: BE });
    return r.status === 0 ? r.stdout.trim() : '';
})();
const dirty = (() => {
    if (!gitSha) return false;
    const r = sh('git', ['status', '--porcelain'], { cwd: BE });
    return r.status === 0 && r.stdout.trim().length > 0;
})();

/**
 * ★ 源码指纹 ★
 * 本仓库当前**不一定是 git 仓库**（实测：有 .github/ 但没有 .git）。
 * 没有 commit 可记时，"线上跑的是哪份代码"这个问题就没人回答得了 ——
 * 而它恰恰是出事后的第一个问题。所以这里对「会进包的所有源码」做一次
 * 内容摘要（相对路径 + 文件内容，排序后统一 hash）：
 *   · 与 git 无关，任何机器上都能算，结果可比对；
 *   · 只要有一个字节的源码不同，指纹就不同 ⇒ 可用来判断"两个包是不是同一份代码"。
 * 注意：它只覆盖 src/ 与 pom.xml（进包的东西），不含 maven 依赖版本之外的环境差异。
 */
function sourceFingerprint() {
    const files = [];
    const collect = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) collect(p);
            else if (!/\.(class|jar)$/.test(e.name)) files.push(p);
        }
    };
    collect(path.join(BE, 'src'));
    files.push(path.join(BE, 'pom.xml'));
    const h = crypto.createHash('sha256');
    for (const f of files.sort()) {
        h.update(path.relative(BE, f).replace(/\\/g, '/'));
        h.update('\0');
        h.update(fs.readFileSync(f));
        h.update('\0');
    }
    return { hash: h.digest('hex').slice(0, 12), count: files.length };
}
const fp = sourceFingerprint();

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // yyyyMMddHHmm
const rev = gitSha || fp.hash;   // 有 commit 用 commit，没有就用源码指纹
const revLabel = gitSha ? `commit ${gitSha}` : `源码指纹 ${fp.hash}（无 git 仓库，用内容摘要代替 commit）`;

log(`版本 ${version}  ${revLabel}  时间 ${stamp}`);
log(`  源码指纹 ${fp.hash}（${fp.count} 个文件参与计算）`);
if (!gitSha) {
    log('  ⚠️  当前目录不是 git 仓库：无法记录 commit。');
    log('     产物名里的 12 位标识来自源码指纹，仍可用来比对"两个包是不是同一份代码"，');
    log('     但**无法反查历史**（不知道它是从哪次提交来的）。建议尽早 git init。');
}
if (dirty) log('  ⚠️  工作区有未提交改动：产物与任何 commit 都不完全对应，建议在干净工作区发版。');

/* ---------- 1. 构建 ---------- */
const mvnw = process.platform === 'win32' ? 'mvnw.cmd' : './mvnw';
const args = ['-Pprod'];
if (offline) args.push('-o');
args.push(runTests ? 'clean' : 'clean', 'package');
if (!runTests) args.push('-DskipTests');

log(`\n== 执行：${mvnw} ${args.join(' ')} ==`);
// ★ env 必须传进去 ★：上面解析出的 JDK 17 只有覆盖了 JAVA_HOME 才真正生效。
//   漏传这一行 = 钉 JDK 变成一句注释 —— 代码对、日志漂亮、产物照样随机器漂移。
const build = sh(mvnw, args, { cwd: BE, env, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) die(`构建失败（退出码 ${build.status}）`);

/* ---------- 2. 产物 ---------- */
const target = path.join(BE, 'target');
const built = fs.readdirSync(target).find((f) => /^campus-secondhand-backend-.*\.jar$/.test(f) && !/\.original$/.test(f));
if (!built) die('target/ 下找不到可执行 jar');
const srcJar = path.join(target, built);

/* ---------- 3. ★ 自检产物（不信任 BUILD SUCCESS） ---------- */
function jarEntries(jarPath) {
    const buf = fs.readFileSync(jarPath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) die('产物不是合法 zip/jar，拒绝继续（绝不静默放行）');
    const total = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let n = 0; n < total; n++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) die('中央目录解析失败');
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const cmtLen = buf.readUInt16LE(off + 32);
        names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
        off += 46 + nameLen + extraLen + cmtLen;
    }
    if (names.length === 0) die('产物条目数为 0');
    return names;
}

const names = jarEntries(srcJar);
const demoRes = names.filter((n) => /application-demo\.yml|db\/demo-/.test(n));
const hasLogback = names.some((n) => n.endsWith('logback-spring.xml'));
const hasProdYml = names.some((n) => n.endsWith('application-prod.yml'));

log('\n== 产物自检 ==');
log(`  条目总数            ${names.length}`);
log(`  demo 资源（必须 0）  ${demoRes.length}${demoRes.length ? '  ← ' + demoRes.join(', ') : '  OK'}`);
log(`  logback-spring.xml  ${hasLogback ? 'OK' : '缺失 ← 生产将没有日志文件'}`);
log(`  application-prod.yml ${hasProdYml ? 'OK' : '缺失 ← prod profile 起不来'}`);

let bad = 0;
const assert = (cond, msg) => { if (!cond) { bad++; log('  ✗ ' + msg); } };
assert(demoRes.length === 0, '产物里仍有 demo 资源：检查是否真的带了 -Pprod');
assert(hasLogback, '产物里没有 logback-spring.xml');
assert(hasProdYml, '产物里没有 application-prod.yml');
if (bad > 0) die(`产物自检未通过（${bad} 项）—— 拒绝产出发布件`);

/* ---------- 4. 落 dist/ + sha256 ---------- */
const distDir = path.join(BE, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outName = `campus-market-${version}-${rev}-${stamp}.jar`;
const outJar = path.join(distDir, outName);
fs.copyFileSync(srcJar, outJar);

const sha = crypto.createHash('sha256').update(fs.readFileSync(outJar)).digest('hex');
fs.writeFileSync(outJar + '.sha256', `${sha}  ${outName}\n`, 'utf8');

// 发布件旁边留一份"这份包是怎么来的"，交接/回溯时不用去翻聊天记录
fs.writeFileSync(outJar.replace(/\.jar$/, '.info.txt'), [
    `artifact   ${outName}`,
    `version    ${version}`,
    `revision   ${gitSha || '(无 git 仓库)'}`,
    `sourceHash ${fp.hash} (${fp.count} files)`,
    `builtAt    ${new Date().toISOString()}`,
    `builtBy    ${process.env.USERNAME || process.env.USER || 'unknown'}@${process.platform}`,
    // ★ 记实际用的那个 ★，不能记 JAVA_HOME：那正是被忽略掉的那个值。
    //   若这里写 JAVA_HOME，日后的"复现不出来"会被误导到错误方向。
    `java       ${javaHome}  (钉死 JDK 17)`,
    `javaHomeEnv ${process.env.JAVA_HOME || '(未设置)'}${process.env.JAVA_HOME && process.env.JAVA_HOME !== javaHome ? '  ← 已忽略' : ''}`,
    `profile    prod (-Pprod, demo 资源已剔除)`,
    `sha256     ${sha}`,
    ''
].join('\n'), 'utf8');

const sizeMb = (fs.statSync(outJar).size / 1048576).toFixed(1);
log(`\n== 产出 ==`);
log(`  ${outName}  (${sizeMb} MB)`);
log(`  sha256 ${sha}`);
log(`  同目录另有 .sha256 与 .info.txt（记录版本/源码指纹/构建环境）`);

log(`
== 服务器侧（★ 服务器上不装 Maven、不构建）==
  1) 上传产物与校验和：
       scp dist/${outName} dist/${outName}.sha256 campus@<host>:/tmp/
  2) 服务器上校验（不通过就别往下走）：
       cd /tmp && sha256sum -c ${outName}.sha256
  3) 放置并重启（简单做法）：
       sudo install -m 644 /tmp/${outName} /opt/campus-market/app.jar
       sudo systemctl restart campus-market
       sudo systemctl status campus-market --no-pager
       tail -n 50 /data/campus/logs/campus-market.log
  （想保留历史版本可回溯，用 dist/<版本>/ + current 软链的方式，见部署清单 P1-3）
`);
process.exit(0);
