/**
 * 修复 apply-b9b-docs.mjs 造成的文档重复（`服务器部署适配清单.md` 被整段复制一遍）
 *
 * 根因（已用证据锁定，不是猜的）：
 *   swap() 用 `text.replace(from, to)` 做**字符串**替换 —— JS 规定替换串里的
 *   `` $` `` 表示「匹配点之前的全部内容」。锚点是
 *   `| 剥注释 + 只认规则行（`^\s*uploads/?\s*$`） |`，其中 `\s*$` 后面紧跟反引号
 *   ⇒ 恰好构成 `` $` `` ⇒ 替换时把「匹配点之前的全部文档」又插了一遍。
 *
 * 受损结构（已用字节级取证验证，fix 脚本里每步再自证一遍）：
 *   行 iRow（首个 `| D-B9-3 |` 行）=== ROWHEAD + 文档首行   ← 已实测为 true
 *     ROWHEAD = 该行前 132 字符，止于 `…uploads/?\s*`（`` $` `` 被展开处）
 *   其后 = PREFIX（= 匹配点前的全部原文，含一份完整旧文档 + 截断的 D-B9-3 行）+ `） |`
 *   行 i4（首个 `| D-B9-4 |` 行）起 = D_ROW + 匹配点之后的全部原文（§7.11 收尾 + §8）
 *
 * 修复 = [1..iRow) + (ROWHEAD + 完整第五格) + [i4..end]，随后对整体做 3 处过期数字回填。
 * 每一步自证；任何一步不符 → 退出码 2、不写盘（避免二次破坏）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const FILE = path.join(ROOT, 'campus-secondhand-backend', 'docs', '服务器部署适配清单.md');

const cnt = (s, pat) => s.split(pat).length - 1;
let issues = 0;
const bad = (m) => { console.error('❌ ' + m); issues++; };

const text = fs.readFileSync(FILE, 'utf8');
const before = { lines: text.split('\n').length, chars: text.length };
const L = text.split('\n');

/* ---- 取证 1：行级结构必须与推演完全一致 ---- */
const iRow = L.findIndex((l) => l.startsWith('| D-B9-3 |'));
const i4 = L.findIndex((l) => l.startsWith('| D-B9-4 |'));
if (iRow < 0 || i4 < 0 || i4 <= iRow) { bad(`行定位失败 iRow=${iRow} i4=${i4}`); }
if (issues === 0) {
    const cut = L[iRow].indexOf('# 校园二手集市');
    if (cut <= 0) bad(`截断点异常 cut=${cut}`);
    else if (L[iRow] !== L[iRow].slice(0, cut) + L[0])
        bad('受损行 ≠ ROWHEAD+文档首行：结构与推演不符，不敢动手');
    else if (!L[iRow].slice(0, cut).endsWith('uploads/?\\s*'))
        bad('ROWHEAD 没有止于 `uploads/?\\s*`：截断点错位');
    else {
        console.log(`✅ 结构取证通过：iRow=${iRow + 1} i4=${i4 + 1} cut=${cut}（ROWHEAD ${cut} 字符）`);
    }
}

/* ---- 取证 2：前缀区干净、尾部区完整 ---- */
const P1 = L.slice(0, iRow).join('\n');
const REST = L.slice(i4);
const RESTs = REST.join('\n');
if (issues === 0) {
    if (cnt(P1, 'D-B9-4') !== 0) bad('前缀区不应含 D-B9-4');
    if (cnt(P1, '抓到并修掉的四条判据缺陷') !== 1) bad('前缀区应有且仅有 1 处「四条」标题（swap#2 已应用）');
    if (cnt(P1, '**29 轮变异**（27 条判据') !== 1) bad('前缀区应有 1 处「29 轮变异」（swap#1 已应用）');
    if (!RESTs.startsWith('| D-B9-4 |')) bad('尾部区必须以 D-B9-4 行开头');
    if (cnt(RESTs, '修完后复跑：**31/31 全部符合预期**') !== 1) bad('尾部区缺「31/31」收尾（swap#4 已应用）');
    if (cnt(RESTs, '## 8. 附：本次审查的证据索引') !== 1) bad('尾部区缺 §8 附录');
}
if (issues > 0) { console.error(`\n[INFRA] 取证未过（${issues} 项）—— 不写盘`); process.exit(2); }

/* ---- 重建 ---- */
const ROW = L[iRow].slice(0, L[iRow].indexOf('# 校园二手集市')) + '$`） |';
let repaired = P1 + '\n' + ROW + '\n' + RESTs;

/* ---- 重建自证：去重是否成功 ---- */
for (const [n, pat, want] of [
    ['「## 0. 一句话结论」', '## 0. 一句话结论', 1],
    ['「抓到并修掉的四条判据缺陷」', '抓到并修掉的四条判据缺陷', 1],
    ['「D-B9-4」', 'D-B9-4', 1],
    ['「D-B9-3」', 'D-B9-3', 1],
    ['「## 8. 附：本次审查的证据索引」', '## 8. 附：本次审查的证据索引', 1],
    ['完整第五格（剥注释判据）', '剥注释 + 只认规则行（`^\\s*uploads/?\\s*$`） |', 1],
]) {
    const c = cnt(repaired, pat);
    console.log(`${c === want ? '✅' : '❌'} ${n} = ${c}（应为 ${want}）`);
    if (c !== want) bad(n + ' 计数不符');
}
if (cnt(repaired, '**31/31 全部符合预期**') < 1) bad('缺「31/31 全部符合预期」');
if (cnt(repaired, '**29 轮变异**（27 条判据；P0-7 / P2-2 / P2-6 各 2 轮）+ **2 组对照**') !== 1)
    bad('缺「29 轮变异」B9B 表述');

/* ---- 过期数字回填（split/join，锚「新内容独有」语境，逐处断言命中数） ---- */
function rep(from, to, want) {
    const c = cnt(repaired, from);
    if (c !== want) { bad(`回填锚「${from.slice(0, 30)}…」命中 ${c} 次（应为 ${want}）`); return; }
    repaired = repaired.split(from).join(to);
    console.log(`✅ 回填：${from.slice(0, 34)}… ×${c}`);
}
// 探针从 30 轮（R01-R28）扩到 31 轮（+R29）：29 变异 + 2 对照；该红没红 3 → 4 条
rep('**30 轮 / 28 条判据逐条红绿 + 2 组对照**', '**31 轮 / 29 判据轮逐条红绿 + 2 组对照**', 1);
rep('probe-audit-criteria-redgreen.mjs      # 30 轮；', 'probe-audit-criteria-redgreen.mjs      # 31 轮；', 1);
rep('**30 轮全部符合预期**（28 判据轮 + 2 对照）；修复前 3 条判据该红没红',
    '**31 轮全部符合预期**（29 判据轮 + 2 对照）；修复前 4 条判据该红没红', 1);

/* ---- 回填后再验：过期字样必须清零（★ 必须在 rep 之后检查） ---- */
for (const [n, pat] of [['过期「30/30」', '30/30'], ['过期「30 轮」', '30 轮'], ['过期「28 判据轮」', '28 判据轮'], ['过期「28 条判据」', '28 条判据'], ['过期「3 条判据该红没红」', '修复前 3 条判据该红没红']]) {
    const c = cnt(repaired, pat);
    console.log(`${c === 0 ? '✅' : '❌'} ${n} = ${c}（应为 0）`);
    if (c) bad(n + ' 仍残留');
}

if (issues > 0) { console.error(`\n[INFRA] 自证未过（${issues} 项）—— 不写盘`); process.exit(2); }

/* ---- 写盘 ---- */
fs.writeFileSync(FILE, repaired, 'utf8');
const after = fs.readFileSync(FILE, 'utf8');
console.log(`\n✅ 已写盘：${before.lines} 行 / ${before.chars} 字符 → ${after.split('\n').length} 行 / ${after.length} 字符`);
console.log(`[INFRA] 修复完成，全部自证通过 EXIT=0`);
