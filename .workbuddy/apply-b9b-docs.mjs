/**
 * B9 批文档销项（增量）：补第 4 条判据缺陷 D-B9-4（P2-2 漏查 lockfile）
 *
 * 与 apply-b9-docs.mjs 同一套纪律：锚点恰好命中 1 次、幂等（锚「新内容独有句」）、写回后自证。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const A = (p) => path.join(ROOT, p);

const BE_DOC = 'campus-secondhand-backend/docs/服务器部署适配清单.md';
const LEDGER = '项目缺陷检查与修复清单.md';
const REPORT = '缺陷清单逐条核对报告.md';
const MARK = '<!-- B9B-D-B9-4 -->';

let issues = 0;
const bad = (m) => { console.error('❌ ' + m); issues++; };

function swap(file, from, to, key) {
    const p = A(file);
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes(key)) { console.log(`⏭️  ${path.basename(file)}: 已改过，跳过（${key.slice(0, 18)}…）`); return; }
    const hits = text.split(from).length - 1;
    if (hits !== 1) { bad(`${path.basename(file)}: 锚点命中 ${hits} 次（应为 1）—— 未改动：${from.slice(0, 46)}…`); return; }
    // ★ 函数替换：字面 `text.replace(from, to)` 会把 to 里的 `$` 等当作替换模式
    //   （本次事故根因：to 含 `` $` `` ⇒ 展开成「匹配点前全部内容」⇒ 全文重复）
    fs.writeFileSync(p, text.replace(from, () => to), 'utf8');
    console.log(`✅ ${path.basename(file)}: 已改`);
}

const D_B9_4_DEPLOY = '| D-B9-4 | P2-2 前端 Node 约束 / npm ci | **第十三：判据名 ≠ 覆盖范围**（名字写着「npm ci」，实现从不看 lockfile） | 移走 `package-lock.json` ⇒ 修复前**不报红**（而 `npm ci` 没 lockfile 直接失败） | 改锚能力：`(.nvmrc \\|\\| engines) && package-lock.json`。`.nvmrc`/`engines` 是同一件事的两种写法（用 OR 合理），lockfile 是另一件事（必须 AND） |';
const D_B9_4_LEDGER = '| **D-B9-4** | P2-2 `npm ci` | **第十三形态：判据名 ≠ 覆盖范围**（名写「`.nvmrc` / npm ci」，实现只查 `.nvmrc \\|\\| engines`） | 移走 `package-lock.json` ⇒ **不报红**（`npm ci` 缺 lockfile 直接失败） | `(.nvmrc \\|\\| engines) && 有 package-lock.json`：同一件事用 OR、另一件事必须 AND |';
const D_B9_4_REPORT = '- **D-B9-4（P2-2）第十三形态：判据名 ≠ 覆盖范围。** 判据名叫「`.nvmrc` / npm ci」，\n  实现只查 `.nvmrc || engines`，**从不看 `package-lock.json`** —— 而 `npm ci` 的前提就是有 lockfile。\n  把它移走，服务器上 `npm ci` 直接失败，判据照样 ✅。**已修**：`(.nvmrc || engines) && lockfile`。\n  ⇒ 纪律：**判据名里写了几件事，就要逐件去查**，别把名字当覆盖范围。';

/* ===== A. 部署清单 §7.11 ===== */
swap(BE_DOC, '- **28 条判据各 1 轮变异** + **2 组对照**', '- **29 轮变异**（27 条判据；P0-7 / P2-2 / P2-6 各 2 轮）+ **2 组对照**', '**29 轮变异**（27 条判据');
swap(BE_DOC, '### 抓到并修掉的三条「自骗判据」', '### 抓到并修掉的四条判据缺陷', '抓到并修掉的四条判据缺陷');
swap(BE_DOC, '| 剥注释 + 只认规则行（`^\\s*uploads/?\\s*$`） |',
    '| 剥注释 + 只认规则行（`^\\s*uploads/?\\s*$`） |\n' + D_B9_4_DEPLOY, 'D-B9-4');
swap(BE_DOC, '修完后复跑：**30/30 全部符合预期**', '修完后复跑：**31/31 全部符合预期**', '**31/31 全部符合预期**');

/* ===== B. 缺陷清单 §二十九 ===== */
swap(LEDGER, '## 二十九、第二十一轮（B9 批）：审计判据「红绿」全量验收 + 三条自骗判据修复（2026-09-23）',
    '## 二十九、第二十一轮（B9 批）：审计判据「红绿」全量验收 + 四条判据缺陷修复（2026-09-23）',
    '四条判据缺陷修复（2026-09-23）');
swap(LEDGER, '- **28 条判据各 1 轮变异**（把代码变回旧实现）+ **2 组对照**',
    '- **29 轮变异**（27 条判据；P0-7 / P2-2 / P2-6 各 2 轮）（把代码变回旧实现）+ **2 组对照**',
    '**29 轮变异**（27 条判据；P0-7');
swap(LEDGER, '| 剥注释 + 只认规则行 |', '| 剥注释 + 只认规则行 |\n' + D_B9_4_LEDGER, 'D-B9-4');
swap(LEDGER, '修复前 **3 条该红没红 + 1 处不该红却红**；修复后 **30/30 全部符合预期**',
    '修复前 **4 条该红没红 + 1 处不该红却红**；修复后 **31/31 全部符合预期**', '**4 条该红没红');

/* ===== C. 核对报告 §二十三 ===== */
swap(REPORT, '**§二十三 = B9 批「审计判据红绿全量验收 + 三条自骗判据修复」**（2026-09-23）。27 条判据逐条红绿：**修复前 3 条该红没红**、修复后 **30/30 符合预期**',
    '**§二十三 = B9 批「审计判据红绿全量验收 + 四条判据缺陷修复」**（2026-09-23）。27 条判据逐条红绿：**修复前 4 条该红没红**、修复后 **31/31 符合预期**',
    '**§二十三 = B9 批「审计判据红绿全量验收 + 四条判据缺陷修复」**');
swap(REPORT, '⇒ 全量做一遍：28 条判据各 1 轮变异 + 2 组对照',
    '⇒ 全量做一遍：29 轮变异（27 条判据；P0-7 / P2-2 / P2-6 各 2 轮）+ 2 组对照',
    '⇒ 全量做一遍：29 轮变异');
swap(REPORT, '| P2-2 | 删 `engines`（本仓无 `.nvmrc`） | ✅ | ✅ | |',
    '| P2-2 | 删 `engines`（本仓无 `.nvmrc`） | ✅ | ✅ | |\n'
    + '| P2-2 | **移走 `package-lock.json`** | ❌ **该红没红** | ✅ 报红 | D-B9-4，见 23.3 |',
    '移走 `package-lock.json`');
swap(REPORT, '- **D-B9-3（P2-6）第十二形态：判据被注释满足。**',
    D_B9_4_REPORT + '\n- **D-B9-3（P2-6）第十二形态：判据被注释满足。**', '第十三形态：判据名 ≠ 覆盖范围');
swap(REPORT, '- 修完后全量 **30/30 符合预期**', '- 修完后全量 **31/31 符合预期**', '- 修完后全量 **31/31 符合预期**');
swap(REPORT, '- 27 条判据里 **24 条原本就有判别力**、**3 条是自骗判据**（占 11%）',
    '- 27 条判据里 **23 条原本就有判别力**、**4 条有缺陷**（3 条自骗 + 1 条覆盖不足，占 **15%**）',
    '**4 条有缺陷**（3 条自骗 + 1 条覆盖不足');

/* ===== 自证 ===== */
console.log('\n=== 自证 ===');
const texts = { BE_DOC, LEDGER, REPORT };
for (const [name, f] of Object.entries(texts)) {
    const t = fs.readFileSync(A(f), 'utf8');
    const stale = (t.split('30/30').length - 1);
    console.log(`${stale === 0 ? '✅' : '❌'} ${name}: 过期「30/30」残留 ${stale} 处`);
    if (stale) bad(name + ' 仍有过期 30/30');
}
const deploy = fs.readFileSync(A(BE_DOC), 'utf8');
const check = [
    ['§7.11 有 D-B9-4 行', deploy.includes('D-B9-4') && deploy.includes('D-B9-3')],
    ['§7.11 标题已改「四条」', deploy.includes('抓到并修掉的四条判据缺陷')],
    ['§7.11 轮数=29+2', deploy.includes('**29 轮变异**（27 条判据；P0-7 / P2-2 / P2-6 各 2 轮）+ **2 组对照**')],
    ['§7.11 收尾 31/31', deploy.includes('**31/31 全部符合预期**')],
    ['§7.11 无重复节', (deploy.split('### 抓到并修掉的四条判据缺陷').length - 1) === 1],
];
for (const [n, ok] of check) { console.log(`${ok ? '✅' : '❌'} 部署清单: ${n}`); if (!ok) bad('部署清单: ' + n); }

for (const f of [LEDGER, REPORT]) {
    const t = fs.readFileSync(A(f), 'utf8');
    const c = (t.split(MARK).length - 1); // 本脚本不写 MARK，恒 0（保留位）
    if (c) bad(`${f}: 意外 marker ${c}`);
}
console.log(`\n${issues === 0 ? '全部通过：0 处异常' : `存在 ${issues} 处异常`}`);
process.exit(issues === 0 ? 0 : 2);
