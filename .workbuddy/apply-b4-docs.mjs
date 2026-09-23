#!/usr/bin/env node
/**
 * B4 批文档回填（一次跑完三份文档）。
 *
 * 纪律：每条改动都用「锚点必须恰好命中 1 次」自证；任一不满足 ⇒ 退出码 2，
 *      绝不在没命中时静默地"以为改了"。
 * 幂等：已在文件里的内容会被检测到并跳过（第二次跑不重复追加）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));           // .workbuddy
const ROOT = path.dirname(HERE);                                     // 项目根
const BE = path.join(ROOT, 'campus-secondhand-backend');

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s, 'utf8');

let fatal = 0;
const ok = (m) => console.log('  [OK] ' + m);
const err = (m) => { console.error('  [!!] ' + m); fatal++; };

/** 精确替换：锚点必须恰好出现 1 次 */
function replaceOnce(file, anchor, repl, label) {
  const s = read(file);
  const n = s.split(anchor).length - 1;
  if (n !== 1) { err(`${label}: 锚点命中 ${n} 次（要求 1）—— ${file}`); return false; }
  write(file, s.replace(anchor, repl));
  ok(`${label}`);
  return true;
}

/** 追加：若已包含则该 sectionId 视为已应用 */
function appendSection(file, sectionId, newFile, label) {
  const s = read(file);
  if (s.includes(sectionId)) { ok(`${label}（已存在，跳过）`); return true; }
  const add = read(newFile).replace(/^\s*\n/, '').replace(/\s*$/, '') + '\n';
  write(file, s.replace(/\s*$/, '') + '\n\n' + add);
  ok(`${label}`);
  return true;
}

const LIST = path.join(ROOT, '项目缺陷检查与修复清单.md');
const REPORT = path.join(ROOT, '缺陷清单逐条核对报告.md');
const DESIGN = path.join(BE, 'docs', '后端设计说明.md');

for (const f of [LIST, REPORT, DESIGN]) if (!fs.existsSync(f)) err('缺文件: ' + f);
if (fatal) process.exit(2);

console.log('== 1. 项目缺陷检查与修复清单.md ==');

// §二 三行状态回填（原行只有 3 列，缺状态列）
replaceOnce(LIST,
  '| L5 | 订单号生成依赖单实例内存自增，多实例会撞号 | `OrderService.java:622-626` |',
  '| L5 | 订单号生成依赖单实例内存自增，多实例会撞号 | `OrderService.java:622-626` | **✅ 已修复 2026-09-22**（重写发号器：`yyyyMMddHHmmssSSS` ＋ 1 位实例号 ＋ 2 位毫秒内序号，仍 20 位；★ 复核后**比原记录严重一档** —— 旧实现 `%1000` **静默回绕**，同一毫秒内第 N 次与第 N+1000 次生成**完全相同的订单号**，**单实例内部**即可触发。详见第二十二节） |',
  '行 57  L5 状态');

replaceOnce(LIST,
  '| L6 | 消息为轮询非推送 | `views/message/Index.vue:216` |',
  '| L6 | 消息为轮询非推送 | `views/message/Index.vue:216` | **✅ 已修复 2026-09-22**（★ 定性被纠正：真缺陷是**请求叠加**（后回的旧快照盖掉先回的新快照 ⇒ 列表偶尔「跳回上一条」）与**隐藏标签页空转**，**与推不推送无关**；新增 `src/utils/visiblePoll.ts`，WebSocket **明确不做**。详见第二十二节） |',
  '行 58  L6 状态');

replaceOnce(LIST,
  '| L8 | `requireOwner` 对 `operatorId == null` 静默放行，靠注释约定保证安全 | `GoodsService.java:365-371` |',
  '| L8 | `requireOwner` 对 `operatorId == null` 静默放行，靠注释约定保证安全 | `GoodsService.java:365-371` | **✅ 已修复 2026-09-22**（★ 方法头注释「系统内部联动」的辩护经复核**不成立**：商品审核改状态根本不走 `GoodsService`，全仓 4 个调用点**全传 non-null** ⇒ 该旁路**零生产调用者**；已改**失败关闭**（403）并**删掉两个只能传 null 的重载**。详见第二十二节） |',
  '行 60  L8 状态');

// §21.9 遗留里那条「B4 待办」标记为已完成（避免看起来仍是待办）
replaceOnce(LIST,
  '- **B4** 一致性：L5 订单号单实例内存自增（多实例撞号）、L8 `requireOwner` 对 `operatorId==null`\n  **静默放行**、L6 消息 `setInterval` 轮询非推送。',
  '- ~~**B4** 一致性：L5 订单号单实例内存自增（多实例撞号）、L8 `requireOwner` 对 `operatorId==null`\n  **静默放行**、L6 消息 `setInterval` 轮询非推送。~~ → **✅ 已于 2026-09-22 完成，见第二十二节**',
  '§21.9 遗留标记');

appendSection(LIST, '## 二十二、第十五轮', path.join(HERE, '_new-b4-section22.md'), '追加 §二十二');

console.log('== 2. 缺陷清单逐条核对报告.md ==');

replaceOnce(REPORT,
  '| L5 | 订单号依赖单实例内存自增 | 🟡 未修 | `OrderService.generateOrderId` **:1058**（文档写 `622-626`） | ❌ **仍存在** | 时间戳 + 进程内 `ORDER_SEQ`。注释只解决了"同毫秒"，**多实例部署仍撞号** |',
  '| L5 | 订单号依赖单实例内存自增 | ✅ 已修（B4） | `OrderService.generateOrderId`（**已重写**；文档写 `622-626`） | ✅ **已修复 2026-09-22** | ★ 复核后**比原记录严重一档**：旧 `ORDER_SEQ.updateAndGet(v -> (v + 1) % 1000)` 有 3 个毛病 —— ① 序号跨毫秒不归零（"毫秒内序号"名不副实）② **`%1000` 静默回绕** ⇒ 同毫秒第 N 与第 N+1000 次**生成同一个号**，**单实例即可触发** ③ 纯进程内状态（文档记的这条）。已改为 `yyyyMMddHHmmssSSS` ＋ 1 位实例号 ＋ 2 位毫秒内序号，满 100 单**推毫秒不回绕**；详见 §十七 |',
  '行 80  L5');

replaceOnce(REPORT,
  '| L6 | 消息为轮询非推送 | 🟡 未修 | `views/message/Index.vue:231` | ❌ **仍存在** | `setInterval`，注释自认"真实项目换 WebSocket" |',
  '| L6 | 消息为轮询非推送 | ✅ 已修（B4） | `views/message/Index.vue`（轮询器抽到 `src/utils/visiblePoll.ts`） | ✅ **已修复 2026-09-22** | ★ 定性被纠正：**与推不推送无关**。真缺陷是 ① 三个请求一轮、`setInterval` 不管上轮跑完没 ⇒ 请求叠加、**后回的旧快照盖掉先回的新快照**（列表偶尔"跳回上一条"）② 隐藏标签页空转、切回还是旧快照。已改**链式 `setTimeout` + `visibilitychange`**；WebSocket 明确不做、在线心跳刻意不接入；详见 §十七 |',
  '行 81  L6');

replaceOnce(REPORT,
  '| L8 | `requireOwner` 对 null 静默放行 | 🟡 未修 | `GoodsService.requireOwner` **:595**（判空在 :597） | ❌ **仍存在** | `if (operatorId == null) return;` 仅靠方法头注释约定，无运行时保障 |',
  '| L8 | `requireOwner` 对 null 静默放行 | ✅ 已修（B4） | `GoodsService.requireOwner`（**已改**；判空在 :597） | ✅ **已修复 2026-09-22** | ★ 方法头注释的辩护「null 只保留给系统内部联动（如审核通过时改状态）」经复核**不成立**：审核改状态走 `GoodsAuditService` 的 `goodsMapper.update(...)`，**不经过 `GoodsService`**；括号配平扫全仓 4 个调用点**全传 non-null 的 `currentUserId(request)`** ⇒ 该旁路**零生产调用者**。已改**失败关闭**（403）＋**删掉 `updateGoodsStatus(Long,String)` / `deleteGoods(Long)` 两个只能传 null 的重载**；详见 §十七 |',
  '行 83  L8');

replaceOnce(REPORT,
  '- **B4** 一致性：L5 订单号单实例内存自增（多实例撞号）、L8 `requireOwner` 对 `operatorId==null`\n  **静默放行**、L6 消息 `setInterval` 轮询非推送。',
  '- ~~**B4** 一致性：L5 订单号单实例内存自增（多实例撞号）、L8 `requireOwner` 对 `operatorId==null`\n  **静默放行**、L6 消息 `setInterval` 轮询非推送。~~ → **✅ 已于 2026-09-22 完成，见 §十七**',
  '§16.9 遗留标记');

appendSection(REPORT, '## 十七、B4 批', path.join(HERE, '_new-b4-report17.md'), '追加 §十七');

console.log('== 3. campus-secondhand-backend/docs/后端设计说明.md ==');

replaceOnce(DESIGN,
  '- **B4** 一致性：L5 订单号单实例内存自增（多实例撞号）、L8 `requireOwner` 对 `operatorId==null` **静默放行**、L6 消息 `setInterval` 轮询非推送。',
  '- ~~**B4** 一致性：L5 订单号单实例内存自增（多实例撞号）、L8 `requireOwner` 对 `operatorId==null` **静默放行**、L6 消息 `setInterval` 轮询非推送。~~ → **✅ 已于 2026-09-22 完成，见附二十**',
  '§19.10 遗留标记');

appendSection(DESIGN, '## 附二十、', path.join(HERE, '_new-b4-appendix20.md'), '追加 附二十');

console.log('');
if (fatal) { console.error(`共 ${fatal} 处失败 —— 退出码 2（脚本或锚点有问题，不是"改完了"）`); process.exit(2); }
console.log('全部改动已应用。');

const sizes = [LIST, REPORT, DESIGN].map((f) => `  ${path.basename(f)}: ${fs.statSync(f).size}B`).join('\n');
console.log(sizes);
