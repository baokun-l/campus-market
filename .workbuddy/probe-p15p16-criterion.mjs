/**
 * 判据红绿：证明 audit-deploy-gap.mjs 里 P1-5 / P1-6 的**新判据**真的有判别力
 *
 * ── 为什么连"判据"本身也要做红绿 ──────────────────────────────────────────
 * 本文档仓已经栽过两次「判据撒谎」：
 *   · `audit-all-open.mjs` 第一版的 4 条判据命中的全是**注释**；
 *   · P1-3 的判据锚在被**有意放弃**的手段（`<buildInfo/>`）上，把已落地误报成没做。
 * 一个永远报 ✅ 的判据不是检查，只是一条注释。所以新判据必须同时证明两件事：
 *   ① **判别力**：把「能力」拿走 ⇒ 必须变 ❌；
 *   ② **不被字样骗**：只留下"字样/注释"、能力已不存在 ⇒ 必须**仍然** ❌
 *      （第八形态锚手段、第九形态锚字样，各对应一项）。
 *
 * ── 为什么这一版判据必须剥注释（本轮的真实缺陷）──────────────────────────
 * 这两条判据的宿主文件里，**注释恰好写着判据要找的东西**：
 *   · `RequestTraceFilter` 类注释第 52 行：「用 {@code MDC.clear()} 而不是逐个 remove」；
 *   · `HealthService` 第 140 行 javadoc：「修复前写法的 {@code future.get(0, MILLISECONDS)}」。
 * 两处都是**故意**留的"这里曾经是…"。若判据直接匹配原文，把真代码整段删掉、只留注释，
 * 它照样报 ✅ —— 那就是让注释自己骗自己。R3 / R4 两轮专门为此设计。
 *
 * ── 本探针不编译 ────────────────────────────────────────────────────────
 * 它只跑 audit（纯文本分析），所以允许写入"编译不过"的突变（`.get()` 少一个参数后，
 * catch 分支永不抛出）。代价是必须**逐字节还原**，收尾用 md5 证明 —— 见 assertRestored()。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const AUDIT = path.join(ROOT, '.workbuddy', 'audit-deploy-gap.mjs');

const abs = {
  filter: path.join(BE, 'src/main/java/com/campus/market/config/RequestTraceFilter.java'),
  ctl: path.join(BE, 'src/main/java/com/campus/market/controller/HealthController.java'),
  svc: path.join(BE, 'src/main/java/com/campus/market/service/HealthService.java'),
};
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const snapshot = Object.fromEntries(Object.keys(abs).map((k) => [k, fs.readFileSync(abs[k])]));
const before = Object.fromEntries(Object.keys(abs).map((k) => [k, md5(snapshot[k])]));

function restoreAll() {
  for (const k of Object.keys(abs)) fs.writeFileSync(abs[k], snapshot[k]);
}

function assertRestored() {
  const bad = Object.keys(abs).filter((k) => md5(fs.readFileSync(abs[k])) !== before[k]);
  if (bad.length) {
    console.log(`  ✗ 还原失败：${bad.join(', ')} —— 探针中止`);
    process.exit(2);
  }
  console.log('  ✓ 逐字节还原：三个文件均与原文件逐字节一致');
}

/** 跑 audit，抓 P1-5 / P1-6 两行的 state 与证据串 */
function runAudit() {
  const out = execFileSync(process.execPath, [AUDIT], { cwd: ROOT, encoding: 'utf8' });
  const st = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(✅|❌|❓)\s+(P1-5|P1-6)\b(.*)$/);
    if (m) st[m[2]] = { state: m[1] === '✅' ? 'DONE' : m[1] === '❌' ? 'MISSING' : 'UNKNOWN', ev: m[3] };
  }
  if (!st['P1-5'] || !st['P1-6']) {
    console.log('  ✗ audit 输出里找不到 P1-5 / P1-6 —— 判据可能被改名了，探针中止');
    process.exit(2);
  }
  return st;
}

/** 精确替换（锚点必须恰好命中 1 次，否则中止） */
function mutate(key, find, replace, desc) {
  const p = abs[key];
  const src = fs.readFileSync(p, 'utf8');
  const n = src.split(find).length - 1;
  if (n !== 1) {
    console.log(`  ✗ 锚点命中 ${n} 次（要求恰好 1 次）: ${desc}`);
    process.exit(2);
  }
  fs.writeFileSync(p, src.replace(find, replace));
  console.log(`  · ${desc}`);
}

const ROUNDS = [
  {
    name: 'R1 · 只保留"设置"、删掉"清理"',
    why: 'P1-6 最关键的一半。只 put 不 clear，线程复用时下个请求会顶着上个请求的身份。',
    mutations: () => [
      mutate('filter', 'MDC.clear();', '// mutated: 不再清理',
        'RequestTraceFilter：删掉 finally 里的 MDC.clear()（类注释里那句 {@code MDC.clear()} 故意留着）'),
    ],
    expect: { 'P1-6': 'MISSING' },
    stay: { 'P1-5': 'DONE' },
    evMust: { 'P1-6': '只设置未清理' },
  },
  {
    name: 'R2 · 端点路径带上前缀',
    why: '能力还在、只是换了路径 —— 判据若锚"字样"就会把它误判成没了。',
    mutations: () => [
      mutate('ctl', '@GetMapping("/health")', '@GetMapping("/api/health")',
        'HealthController：映射改到 /api/health（不再有独立的 /health 端点）'),
    ],
    expect: { 'P1-5': 'MISSING' },
    stay: { 'P1-6': 'DONE' },
  },
  {
    name: 'R3 · 探测不设上界（且注释里仍留着限时写法）',
    why: '★ 同时验证判据剥注释：HealthService:140 的 javadoc 里就写着 future.get(0, MILLISECONDS)，'
      + '不剥注释的判据会被这句注释骗住、继续报 ✅。',
    mutations: () => [
      mutate('svc', 'future.get(dbTimeoutMs, TimeUnit.MILLISECONDS)', 'future.get()',
        'HealthService：future.get() 去掉超时参数（库挂住时探针自己先挂住，无上界）'),
    ],
    expect: { 'P1-5': 'MISSING' },
    stay: { 'P1-6': 'DONE' },
  },
  {
    name: 'R4 · 能力拿走、字样留满（防"锚字样"）',
    why: '★ 第八/九形态的正面靶子：控制器里还留着 @GetMapping("/health") 这句注释原文，'
      + '但真实映射已经不是 /health 了。不剥注释的判据必然被骗。',
    mutations: () => [
      mutate('ctl', '@GetMapping("/health")', '@GetMapping("/api/health")',
        'HealthController：真实映射改到 /api/health'),
      mutate('ctl', 'public class HealthController {',
        '// 旧写法曾在此映射： @GetMapping("/health")\npublic class HealthController {',
        'HealthController：在类声明前补一行"旧写法"注释（字样有了、能力没了）'),
    ],
    expect: { 'P1-5': 'MISSING' },
    stay: { 'P1-6': 'DONE' },
  },
];

console.log('=== 判据红绿 P1-5 / P1-6：把「能力」拿走，audit 判据必须变红 ===');
console.log('  基线 md5：' + Object.entries(before).map(([k, v]) => `${k}=${v.slice(0, 8)}`).join('  '));

const base = runAudit();
console.log(`  修复版现状：P1-5=${base['P1-5'].state}  P1-6=${base['P1-6'].state}`);
if (base['P1-5'].state !== 'DONE' || base['P1-6'].state !== 'DONE') {
  console.log('  ✗ 修复版本身就判不通过 —— 先修代码，再谈判据红绿');
  process.exit(2);
}

let allOk = true;
for (const r of ROUNDS) {
  console.log(`\n############ ${r.name} ############`);
  console.log(`  为什么要这一轮：${r.why}`);
  r.mutations();

  const st = runAudit();
  let ok = true;
  for (const [id, want] of Object.entries(r.expect)) {
    const got = st[id].state;
    const pass = got === want;
    ok = ok && pass;
    console.log(`  ${pass ? '✓' : '✗'} ${id} 期望 ${want}，实际 ${got}${pass ? '' : '  ⇐ 未报红，判据没有判别力'}`);
    const evWant = r.evMust?.[id];
    if (pass && evWant) {
      const evPass = st[id].ev.includes(evWant);
      ok = ok && evPass;
      console.log(`      ${evPass ? '✓' : '✗'} 证据串里${evPass ? '有' : '缺'}「${evWant}」：${st[id].ev.trim().slice(0, 120)}`);
    }
  }
  for (const [id, want] of Object.entries(r.stay ?? {})) {
    const got = st[id].state;
    const pass = got === want;
    ok = ok && pass;
    console.log(`  ${pass ? '✓' : '✗'} 防误伤：${id} 应当仍是 ${want}，实际 ${got}`);
  }
  if (!ok) allOk = false;

  restoreAll();
  assertRestored();
}

console.log('\n############ 收尾：还原版再跑一次 audit（期望两项全绿）############');
const fin = runAudit();
for (const id of ['P1-5', 'P1-6']) {
  const pass = fin[id].state === 'DONE';
  if (!pass) allOk = false;
  console.log(`  ${pass ? '✓' : '✗'} ${id} = ${fin[id].state}`);
}
assertRestored();

console.log('\n========== 结论 ==========');
console.log(allOk
  ? `  ⇒ 判据红→绿成立：${ROUNDS.length} 轮突变各自把目标项打成 ❌、关联项未误伤，`
    + '还原后两项均回到 ✅。其中 R3 / R4 专门证明「不剥注释就会被注释骗」。'
  : '  ⇒ 判据红绿未全部成立，见上面的 ✗');
process.exit(allOk ? 0 : 1);
