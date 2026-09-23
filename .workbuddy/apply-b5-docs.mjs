#!/usr/bin/env node
/**
 * B5 批文档回填（L10 活动 id 发号器 + 全项目唯一发号器）。
 *
 * 纪律（沿用 apply-b4-docs.mjs）：
 *  - 锚点必须**恰好命中 1 次**；0 次或 >1 次一律退出码 2
 *  - 幂等：已应用过的步骤自动跳过
 *  - 改完复核表格列数与相邻行一致
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LIST = path.join(ROOT, '项目缺陷检查与修复清单.md');
const REPORT = path.join(ROOT, '缺陷清单逐条核对报告.md');
const DESIGN = path.join(ROOT, 'campus-secondhand-backend', 'docs', '后端设计说明.md');

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s, 'utf8');

let bad = 0;
const ok = (m) => console.log('  [OK] ' + m);
const err = (m) => { console.error('  [!!] ' + m); bad++; };

/** 整行替换：按行首前缀找，必须恰好 1 行 */
function repLine(file, prefix, newLine, label, marker) {
  const s = read(file);
  if (marker && s.includes(marker)) { ok(`${label}（已应用，跳过）`); return; }
  const lines = s.split('\n');
  const hits = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith(prefix));
  if (hits.length !== 1) { err(`${label}: 前缀命中 ${hits.length} 行（要求 1）`); return; }
  lines[hits[0][1]] = newLine;
  write(file, lines.join('\n'));
  ok(label);
}

function appendSection(file, marker, newFile, label) {
  const s = read(file);
  if (s.includes(marker)) { ok(`${label}（已存在，跳过）`); return; }
  const add = read(newFile).replace(/^\s*\n/, '').replace(/\s*$/, '') + '\n';
  write(file, s.replace(/\s*$/, '') + '\n\n' + add);
  ok(label);
}

console.log('== 一、清单：L10 行销项 ==');
repLine(LIST, '| L10 | 限时活动 ID',
  '| L10 | 限时活动 ID 用 `static AtomicLong ID_SEQ` 进程内自增，**多实例撞号**（主键冲突 → 500）；且 base36 两段无分隔符拼接有歧义 | `ActivityService.java` | **✅ 已修复 2026-09-22**（新增 `common/InstanceSeqGenerator`，订单号与活动 id **共用同一份**发号状态机；活动 id 改为 `act_` + 17 位时间戳 + 1 位实例号 + 2 位毫秒内序号 = 24 字符，形态可唯一切分。★ 这条**比原记录重要**：它是 L5 的同族漏网，且让「改一处必查另一处」从靠纪律变成靠结构。详见第二十三节） |',
  '行 L10 销项', '详见第二十三节');
appendSection(LIST, '## 二十三、第十六轮', path.join(HERE, '_new-b5-section23.md'), '追加 §二十三');

console.log('== 二、核对报告：L10 行销项 + §十八 ==');
repLine(REPORT, '| L10 | 限时活动 ID 进程内自增',
  '| L10 | 限时活动 ID 进程内自增（**同 L5 族**） | ✅ 已修（B5） | `ActivityService`；`common/InstanceSeqGenerator`（新增） | ✅ **已修复 2026-09-22** | 旧实现 `private static final AtomicLong ID_SEQ` + `"act_"+base36(毫秒)+base36(seq)` 已删除；现为 `act_` + 17 位时间戳 + 1 位实例号 + 2 位毫秒内序号 = **24 字符**，与订单号**共用同一个** `InstanceSeqGenerator`。结构断言（④组）钉住：两个 Service 都不许再有 `Atomic*` 字段、都必须持有该发号器。★ 红绿：旧实现放回去后 **6 例报红**；真机 `e2e-b5.mjs` **21 PASS / 0 FAIL**。详见 §十八 |',
  '行 L10 销项', '详见 §十八');
appendSection(REPORT, '## 十八、B5 批', path.join(HERE, '_new-b5-section23.md'), '追加 §十八');

console.log('== 三、后端设计说明：附二十一 ==');
appendSection(DESIGN, '## 附二十一、', path.join(HERE, '_new-b5-appendix21.md'), '追加 附二十一');

console.log('');
if (bad) { console.error(`共 ${bad} 处失败 —— 退出码 2`); process.exit(2); }

// 列数复核
console.log('列数复核：');
for (const [f, p, want] of [[LIST, '| L10 | 限时活动 ID', 4], [REPORT, '| L10 | 限时活动 ID', 6]]) {
  const line = read(f).split('\n').find((l) => l.startsWith(p));
  const cols = line ? line.split('|').length - 2 : -1;
  console.log(`  ${path.basename(f)} [L10] 列数=${cols}（应 ${want}）${cols === want ? ' ✓' : ' ✗'}`);
  if (cols !== want) bad++;
}
if (bad) process.exit(2);
console.log('全部改动已应用。');
for (const f of [LIST, REPORT, DESIGN]) console.log('  ' + path.basename(f) + ': ' + fs.statSync(f).size + 'B');
