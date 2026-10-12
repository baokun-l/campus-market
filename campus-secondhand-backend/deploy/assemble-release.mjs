/**
 * 发布件打包（复刻 deploy/build-release.mjs 的第 2~4 步）
 *
 * 为什么需要这个脚本：本会话环境禁止 Node 派生 java 子进程（spawnSync → EBUSY），
 * 所以 build-release.mjs 的 JDK 探测那一步跑不通。
 * 于是改为「用 shell 直连 Maven 构建」+「本脚本负责产物自检与命名落盘」。
 *
 * ★ 纪律：不信任 BUILD SUCCESS，必须自己解压 jar 验条目（照抄 build-release.mjs 的做法）。
 * ★ git HEAD / 版本号由 shell 通过环境变量传入（本脚本不派生子进程）。
 *
 * 用法：
 *   HEAD_SHA=5a8e58a VERSION=1.0.0 JAVA_HOME_USED="C:\Program Files\Java\jdk-17" \
 *     node echo/assemble-release.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BE = 'campus-secondhand-backend';
const version = process.env.VERSION || '0.0.0';
const gitSha = process.env.HEAD_SHA || '';
const javaHomeUsed = process.env.JAVA_HOME_USED || '(未记录)';

function die(msg) {
  console.error('\n[FATAL] ' + msg + '\n');
  process.exit(1);
}

/* ---------- 1. 找产物 ---------- */
const target = path.join(BE, 'target');
if (!fs.existsSync(target)) die('target/ 不存在，构建没跑成功');
const built = fs.readdirSync(target).find((f) => /^campus-secondhand-backend-.*\.jar$/.test(f) && !/\.original$/.test(f));
if (!built) die('target/ 下找不到可执行 jar');
const srcJar = path.join(target, built);
console.log(`源产物   ${built}`);

/* ---------- 2. ★ 产物自检（不信任 BUILD SUCCESS） ---------- */
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
    const cmtLen = buf.readUInt32LE(off + 32);
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

// 额外：本次要确认的关键组件真在包里（新包才有的东西）
const hasAiChain = names.some((n) => n.endsWith('service/ai/AiProviderChain.class'));
const hasReconcile = names.some((n) => n.endsWith('job/PaymentReconcileJob.class'));

/**
 * ★★ 「本次新增组件」自检（2026-10-12 补）★★
 *
 * 上面那两条（AiProviderChain / PaymentReconcileJob）是 09-26 那次发版的新增物，
 * 对**今天**来说它们已经是"任何旧包都有"的东西了 —— 拿它们当判据，
 * 一个 09-26 的包也能全部通过。**判据会过期，而它过期时不会报错。**
 *
 * 所以每次发版必须把「这一次才有的 class」列进来。本次是「校园币充值」：
 * 这 5 个类在 09-26 的包里**一个都不存在**，因此它们才是"包是新的"的有效证据。
 * （实测：拿旧包跑这段会明确报缺失，而不是静默通过。）
 */
const RECHARGE_CLASSES = [
  'controller/WalletController.class',
  'service/WalletService.class',
  'dto/WalletRechargeRequest.class',
  'dto/WalletRechargeResult.class',
  'dto/WalletSummary.class'
];
const rechargeMissing = RECHARGE_CLASSES.filter((c) => !names.some((n) => n.endsWith(c)));

console.log('\n== 产物自检 ==');
console.log(`  条目总数                         ${names.length}`);
console.log(`  demo 资源（必须 0）               ${demoRes.length}${demoRes.length ? '  ← ' + demoRes.join(', ') : '  OK'}`);
console.log(`  logback-spring.xml               ${hasLogback ? 'OK' : '缺失 ← 生产将没有日志文件'}`);
console.log(`  application-prod.yml             ${hasProdYml ? 'OK' : '缺失 ← prod profile 起不来'}`);
console.log(`  AiProviderChain.class            ${hasAiChain ? 'OK（AI 降级链在包里）' : '缺失 ← 这是旧包的特征！'}`);
console.log(`  PaymentReconcileJob.class        ${hasReconcile ? 'OK（支付对账在包里）' : '缺失 ← 这是旧包的特征！'}`);
console.log(`  ★ 本次新增「充值」5 个 class       ${rechargeMissing.length === 0 ? 'OK（全部在包里）' : '缺失 ' + rechargeMissing.join(', ') + '  ← 这是旧包的特征！'}`);

let bad = 0;
const assert = (cond, msg) => { if (!cond) { bad++; console.log('  X ' + msg); } };
assert(demoRes.length === 0, '产物里仍有 demo 资源：检查是否真的带了 -Pprod');
assert(hasLogback, '产物里没有 logback-spring.xml');
assert(hasProdYml, '产物里没有 application-prod.yml');
assert(hasAiChain, '产物里没有 AiProviderChain.class');
assert(hasReconcile, '产物里没有 PaymentReconcileJob.class');
assert(rechargeMissing.length === 0, `产物里缺少本次新增的充值组件：${rechargeMissing.join(', ')}`);
if (bad > 0) die(`产物自检未通过（${bad} 项）—— 拒绝产出发布件`);

/* ---------- 3. 源码指纹（照抄 build-release.mjs：只覆盖 src/ + pom.xml） ---------- */
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

/* ---------- 4. 落 dist/ + sha256 + info ---------- */
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // yyyyMMddHHmm

/**
 * ★★ 工作区 dirty 时不能用 commit 命名产物（2026-10-12 补）★★
 *
 * 起因：本次发版时 `git HEAD` 仍是 `5a8e58a`，但 `src/` 下有 12 处未提交改动
 * （整块「校园币充值」功能都还没提交）。若照旧用 `gitSha` 做文件名的一部分，
 * 产物会叫 `campus-market-1.0.0-5a8e58a-<stamp>.jar` ——
 * 而 09-26 那份**已经过完整验证**的包叫 `campus-market-1.0.0-5a8e58a-202609261358.jar`。
 *
 * 两者**内容不同**（一个没有充值、一个有），却带着同一个 commit 号。
 * 这正好制造出最难查的一类事故：拿 commit 号去对，对得上；拿 sha256 去对，对不上；
 * 然后人开始怀疑是"构建不可复现"，而真相是**这一次压根不该带那个 commit 号**。
 *
 * ⇒ 所以：dirty 时**主动放弃 commit 号**，改用源码指纹命名。
 *   文件名于是变成「这份包对应哪个源码状态」，而不是「作者以为它对应哪个提交」。
 *   commit 号仍然记进 .info.txt（附上 dirty 标注），信息一条都没丢。
 *   由 shell 传 SRC_DIRTY=1 声明（本脚本不派生子进程，跑不了 git status）。
 */
const srcDirty = process.env.SRC_DIRTY === '1';
const rev = (gitSha && !srcDirty) ? gitSha : fp.hash;
const revNote = srcDirty
  ? `源码指纹 ${fp.hash}（工作区有未提交改动，${gitSha || '无 commit'} 不能代表本包内容）`
  : (gitSha ? `commit ${gitSha}` : `源码指纹 ${fp.hash}（无 git 仓库）`);

const distDir = path.join(BE, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outName = `campus-market-${version}-${rev}-${stamp}.jar`;
const outJar = path.join(distDir, outName);
fs.copyFileSync(srcJar, outJar);

const sha = crypto.createHash('sha256').update(fs.readFileSync(outJar)).digest('hex');
fs.writeFileSync(outJar + '.sha256', `${sha}  ${outName}\n`, 'utf8');
fs.writeFileSync(outJar.replace(/\.jar$/, '.info.txt'), [
  `artifact   ${outName}`,
  `version    ${version}`,
  `revision   ${gitSha || '(无 git 仓库)'}${srcDirty ? '  ← 工作区 dirty，本包包含其后的未提交改动，**不要用这个 commit 号比对内容**' : ''}`,
  `sourceHash ${fp.hash} (${fp.count} files)`,
  `builtAt    ${new Date().toISOString()}`,
  `builtBy    ${process.env.USERNAME || process.env.USER || 'unknown'}@${process.platform}`,
  `java       ${javaHomeUsed}  (钉死 JDK 17，由 shell 显式传入 JAVA_HOME)`,
  `profile    prod (-Pprod, demo 资源已剔除)`,
  `sha256     ${sha}`,
  ''
].join('\n'), 'utf8');

const sizeMb = (fs.statSync(outJar).size / 1048576).toFixed(1);
console.log('\n== 产出 ==');
console.log(`  ${outName}  (${sizeMb} MB)`);
console.log(`  sha256 ${sha}`);
console.log(`  ${revNote}`);
console.log(`  源码指纹 ${fp.hash}（${fp.count} 个文件参与计算）`);
console.log(`  时间戳 ${stamp}`);
if (srcDirty) {
  console.log('\n  ⚠️  工作区 dirty ⇒ 产物名用源码指纹而不是 commit 号。');
  console.log('     想用 commit 号命名，请先提交（git add -A && git commit）。');
} else {
  console.log('\n★ 核对：revision 必须等于当前 git HEAD');
}
