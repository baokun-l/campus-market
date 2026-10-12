/**
 * 两份前端副本同步 / 回流（T2 正本 ⇄ T3 副本）
 *
 * 背景：本项目前端有两份必须保持一致的副本 ——
 *   正本 T2 = 实践任务2：Web前端开发(Vue3+Element Plus+ECharts)/campus-secondhand-frontend
 *   副本 T3 = 实践任务3：后端开发(前后端分离)/campus-secondhand-frontend
 * 只改一份是本项目最容易犯、也最晚被发现的错（往往几个月后才发现交上去的是旧版）。
 *
 * ★ 2026-09-20 重写 —— 修掉两个真实咬过人的设计缺陷 ★
 *
 * ① 同步方向被写死成 T3 → T2，且脚本名叫「回流」，读起来像是在「把改动搬回正本」。
 *    实际上 `src = join(T3, rel)` 是硬编码：**在正本 T2 里改完代码再跑它会静默地把改动覆盖回旧版**
 *    （副本还是旧的 → 用旧内容盖掉新内容），而且它只会打印「覆盖 N 个文件」，
 *    看起来一切正常。方向这种事不能靠默认值猜，现在必须显式传 `--from`，不给就报错退出。
 *
 * ② 待同步文件清单是硬编码的 12 个路径。
 *    而 `sync-check.mjs` 比对的是**整棵目录树** —— 两边口径不一致，
 *    后果是：新增一个 `src/utils/address.ts`，check 报「差异 1 项」，sync 却报「回流完成」。
 *    （本次修复就正好踩到：address.ts / address.spec.ts 都是新增文件。）
 *    现在改成与 check **完全同源**的遍历 + **共用同一份忽略清单**，两边再也跑不偏。
 *
 * 用法：
 *   node .workbuddy/sync-front.mjs --dry                        # 只列差异，不动任何文件（先看再改）
 *   node .workbuddy/sync-front.mjs --from=t2                    # 以正本 T2 为准覆盖副本 T3
 *   node .workbuddy/sync-front.mjs --from=t3                    # 以副本 T3 为准回填正本 T2
 *   node .workbuddy/sync-front.mjs --from=t2 --only=src/utils/address.ts
 *
 * 安全保证：
 *   · 每个被覆盖的文件，覆盖前都会先备份到
 *     <实践任务3>/.workbuddy/bak-presync-<时间戳>-<from>/ 下（保留相对路径结构）。
 *   · 「只存在于目标侧」的文件**只报告、不删除** —— 在用户桌面上做未明确要求的删除是不可接受的，
 *     这种情况请人工确认后再处理。
 *
 * 退出码：0 = 成功（或 --dry 无差异）；1 = --dry 有差异 / 执行失败；2 = 参数错误。
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发';
const T2 = join(ROOT, '实践任务2：Web前端开发(Vue3+Element Plus+ECharts)', 'campus-secondhand-frontend');
const T3 = join(ROOT, '实践任务3：后端开发(前后端分离)', 'campus-secondhand-frontend');
const BAK_ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)\\.workbuddy';

/*
 * ★ 与 sync-check.mjs 共用同一份忽略清单 ★
 * 两边的清单一旦分家，就会出现「check 说有差异、sync 说已同步」这种自相矛盾的结论，
 * 而人只会相信更乐观的那一个。改动这里时，务必同步改 sync-check.mjs。
 */
const IGNORE = [
  /^node_modules\//,
  /^dist\//,
  /^\.workbuddy\//,
  /^\.idea\//,
  /^\.vite\//,
  /vitest\.config\.ts\.timestamp-.*\.mjs$/,
  /^\.eslintcache$/,
  /^tsconfig\.tsbuildinfo$/,
  // ★ 2026-10-12 补：本地构建备份目录，与 sync-check.mjs 保持同源（见那边的注释）★
  /^_旧dist-/,
  // ★ 2026-10-12 再补：`dist-deploy/`（受限环境下 vite 的替代输出目录）。
  //   与 sync-check.mjs 必须同源 —— 否则会出现「check 说有 107 处差异、
  //   sync 说已同步」，而人只会相信更乐观的那个。
  /^dist-deploy\//,
  /^coverage\//,
  // `npm run test:audit` 的口径报告：本机运行产物（与 sync-check.mjs 同源）
  /^\.vitest-report\.json$/
];
const isNoise = (k) => IGNORE.some((re) => re.test(k));

/* ---------- 参数解析 ---------- */
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const fromArg = args.find((a) => a.startsWith('--from='));
const onlyArg = args.find((a) => a.startsWith('--only='));

if (!dry && !fromArg) {
  console.error('✗ 必须显式指定方向：--from=t2（正本→副本）或 --from=t3（副本→正本）。');
  console.error('  这个脚本以前有个写死的默认方向，结果是「看着成功、实际覆盖回旧版」。');
  console.error('  先跑 `--dry` 看清差异，再决定方向。');
  process.exit(2);
}
const FROM = fromArg ? fromArg.slice('--from='.length) : null;
if (FROM && FROM !== 't2' && FROM !== 't3') {
  console.error(`✗ --from 只接受 t2 / t3，收到：${FROM}`);
  process.exit(2);
}
const SRC_DIR = FROM === 't2' ? T2 : T3;
const DST_DIR = FROM === 't2' ? T3 : T2;
const SRC_NAME = FROM === 't2' ? 'T2(正本)' : 'T3(副本)';
const DST_NAME = FROM === 't2' ? 'T3(副本)' : 'T2(正本)';

const only = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
  : [];

/* ---------- 遍历 ---------- */
/*
 * ★ 下探前先剪掉噪音目录 ★
 * 原来是无条件递归：`node_modules`（几万条）与 `_旧dist-*`（上百条）都会被 stat 一遍
 * 再被 IGNORE 全部丢弃。代价是 `sync-check.mjs` 在 120 秒内跑不完、被超时杀掉 ——
 * 而现象是「命令没有输出」，很容易被读成「脚本坏了」甚至「没有差异」。
 * 这些目录下的文件本就会被 IGNORE 全量过滤，提前剪枝不改变任何判定结果。
 */
const PRUNE_DIRS = ['node_modules', 'dist', 'dist-deploy', 'dist-opt', '.workbuddy', '.idea', '.vite', 'coverage'];
const shouldPrune = (name) => PRUNE_DIRS.includes(name) || name.startsWith('_旧dist-');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (shouldPrune(name)) continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}
function snapshot(base) {
  const map = new Map();
  for (const f of walk(base)) {
    const rel = relative(base, f).replace(/\\/g, '/');
    if (isNoise(rel)) continue;
    map.set(rel, f);
  }
  return map;
}

const t2Snap = snapshot(T2);
const t3Snap = snapshot(T3);

/*
 * 差异分三类，**与方向无关** —— 先算清楚事实，再按方向决定要搬什么。
 * 这样在 --dry（没给方向）时也能给出对称、无倾向的报告：
 * 硬把某个方向当默认再据此措辞，就会把「T2 独有的新文件」说成
 * 「只存在于目标侧、本脚本不会删除」—— 同一份事实，两种吓人的读法。
 */
const bothDifferent = [];
const onlyT2 = [];
const onlyT3 = [];
for (const [rel, a] of t2Snap) {
  const b = t3Snap.get(rel);
  if (b === undefined) onlyT2.push(rel);
  else if (!readFileSync(a).equals(readFileSync(b))) bothDifferent.push(rel);
}
for (const rel of t3Snap.keys()) if (!t2Snap.has(rel)) onlyT3.push(rel);

let toCopy = [];
if (FROM) {
  toCopy = [
    // 源侧独有 → 作为新增复制过去
    ...(FROM === 't2' ? onlyT2 : onlyT3).map((rel) => ({ rel, kind: '新增' })),
    // 两侧都有但内容不同 → 用源侧覆盖
    ...bothDifferent.map((rel) => ({ rel, kind: '覆盖' }))
  ].filter((t) => !only.length || only.includes(t.rel));
  toCopy.sort((a, b) => a.rel.localeCompare(b.rel));
}

if (!FROM) {
  console.log('[--dry 只读模式] 未指定方向，下面是与方向无关的差异清单：\n');
  if (onlyT2.length) {
    console.log(`仅 T2(正本) 有 ${onlyT2.length} 个文件（若以 T2 为准会被复制到 T3）：`);
    for (const rel of onlyT2) console.log(`  + ${rel}`);
  }
  if (onlyT3.length) {
    console.log(`仅 T3(副本) 有 ${onlyT3.length} 个文件（若以 T3 为准会被复制到 T2）：`);
    for (const rel of onlyT3) console.log(`  + ${rel}`);
  }
  if (bothDifferent.length) {
    console.log(`两侧都有但内容不同 ${bothDifferent.length} 个文件（会被所选方向的源侧覆盖）：`);
    for (const rel of bothDifferent) console.log(`  ~ ${rel}`);
  }
  if (!onlyT2.length && !onlyT3.length && !bothDifferent.length) {
    console.log('✅ 两侧已经完全一致，无需同步');
    process.exit(0);
  }
  console.log('\n[--dry] 未修改任何文件。选定方向后执行：--from=t2 或 --from=t3');
  console.log('  --from=t2 → 正本覆盖副本（你在正本里改的代码，搬进副本）');
  console.log('  --from=t3 → 副本回填正本（你在副本里改的代码，搬回正本）');
  process.exit(1);
}

console.log(`基准目录：${SRC_NAME}  →  目标目录：${DST_NAME}`);
if (only.length) console.log(`限定文件：${only.join(', ')}`);

const onlyDst = FROM === 't2' ? onlyT3 : onlyT2;

if (toCopy.length === 0 && onlyDst.length === 0) {
  console.log('\n✅ 两侧已经完全一致，无需同步');
  process.exit(0);
}

if (toCopy.length) {
  // 只在预演时打印整体计划；真正执行时逐条打印（见下方写入循环），避免同一份清单出现两遍
  if (dry) {
    console.log(`\n将处理 ${toCopy.length} 个文件：`);
    for (const t of toCopy) console.log(`  ${t.kind}  ${t.rel}`);
  }
}
if (onlyDst.length) {
  console.log(`\n⚠️ 以下 ${onlyDst.length} 个文件只存在于 ${DST_NAME}，本脚本不会删除它们：`);
  for (const rel of onlyDst) console.log(`  ONLY-IN-${FROM === 't2' ? 'T3' : 'T2'}  ${rel}`);
  console.log('  若确认是废弃文件，请人工删除后重跑校验。');
}
if (toCopy.length === 0) {
  console.log('\n没有需要写入的文件。');
  process.exit(1);
}

// --dry 恒为只读：即使带了 --from，也只做方向相关的预演，绝不落盘
if (dry) {
  console.log('\n[--dry] 未修改任何文件。确认无误后去掉 --dry 执行。');
  process.exit(1);
}

/* ---------- 执行：先备份再覆盖 ---------- */
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const BAK = join(BAK_ROOT, `bak-presync-${stamp}-from-${FROM}`);
const BAK_ABS = `${BAK_ROOT}\\bak-presync-${stamp}-from-${FROM}`;

let copied = 0, added = 0, backedUp = 0;
for (const t of toCopy) {
  const srcAbs = join(SRC_DIR, t.rel);
  const dstAbs = join(DST_DIR, t.rel);
  if (existsSync(dstAbs)) {
    const bak = join(BAK, t.rel);
    mkdirSync(dirname(bak), { recursive: true });
    copyFileSync(dstAbs, bak);
    backedUp++;
  } else {
    added++;
  }
  mkdirSync(dirname(dstAbs), { recursive: true });
  writeFileSync(dstAbs, readFileSync(srcAbs));
  copied++;
  console.log(`  ${t.kind}  ${t.rel}`);
}

console.log(`\n同步完成：写入 ${copied} 个文件（其中新增 ${added} 个），${DST_NAME} 被覆盖前备份 ${backedUp} 个`);
console.log(`备份目录：${BAK_ABS}`);
console.log('下一步：node .workbuddy/sync-check.mjs  →  应显示「两份前端完全同步」');
