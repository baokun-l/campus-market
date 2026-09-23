#!/usr/bin/env node
/**
 * 台账校正（回答「还剩多少未修」之前，先把台账弄准）。
 *
 * 复核发现的记账问题：
 *  - 清单 §二 的 H2 / L9 两行**缺状态列**
 *  - 核对报告 §三 的 M1/M3/M4/M5/L4 五行是**旧快照**，判定与代码不符（已逐条回代码求证）
 *  - 缺一条真实存在的缺陷：`ActivityService.ID_SEQ`（与 L5 同族，L5 修了它漏了）
 *
 * 纪律：锚点必须恰好命中 1 次才动手；命中 0 或 >1 ⇒ 退出码 2。已应用过的步骤自动跳过（幂等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LIST = path.join(ROOT, '项目缺陷检查与修复清单.md');
const REPORT = path.join(ROOT, '缺陷清单逐条核对报告.md');

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s, 'utf8');

let bad = 0;
const ok = (m) => console.log('  [OK] ' + m);
const err = (m) => { console.error('  [!!] ' + m); bad++; };

/** 精确替换：锚点恰好 1 次；若已应用过（文件里已有 marker）则跳过 */
function rep(file, anchor, repl, label, marker) {
  const s = read(file);
  if (marker && s.includes(marker)) { ok(`${label}（已应用，跳过）`); return; }
  const n = s.split(anchor).length - 1;
  if (n !== 1) { err(`${label}: 锚点命中 ${n} 次（要求 1）`); return; }
  write(file, s.replace(anchor, repl));
  ok(label);
}

/** 在某行之后插入一行 */
function afterLine(file, anchor, newLine, label, marker) {
  const s = read(file);
  if (marker && s.includes(marker)) { ok(`${label}（已应用，跳过）`); return; }
  const idx = s.indexOf(anchor);
  if (idx < 0) { err(`${label}: 找不到插入锚点`); return; }
  if (s.indexOf(anchor, idx + 1) >= 0) { err(`${label}: 插入锚点不唯一`); return; }
  const eol = s.indexOf('\n', idx);
  write(file, s.slice(0, eol) + '\n' + newLine + s.slice(eol));
  ok(label);
}

const LIST_L9_OLD = '| L9 | AI 接口无频控，用户输入直接拼 prompt | `AiController`、`AiAssistantService` |';
const LIST_L9_NEW = '| L9 | AI 接口无频控，用户输入直接拼 prompt | `AiController`、`AiAssistantService` | **🟠 未修（B5 候选）** ★ 实测 `AiAssistantService:91` 就是 `systemPrompt + "\\n\\n用户问题：" + userMessage` 直拼；`AiController` 两个入口的 body 是裸 `Map`，**无长度上限、无频控** ⇒ ① prompt 注入 ② 单次可灌超长文本放大 token 消耗（上云后是真金白银）③ 可被脚本刷爆配额。与 L5 同属「依赖无边界约束」 |';

console.log('== 一、清单 §二：补 H2 / L9 的状态列 ==');

rep(LIST,
  '| H2 | 浏览量/收藏数整实体回写，并发时会把原子扣减过的库存覆盖回旧值，**防超卖被旁路** | `GoodsService.java:183-184`、`UserService.java:408-415` |',
  '| H2 | 浏览量/收藏数整实体回写，并发时会把原子扣减过的库存覆盖回旧值，**防超卖被旁路** | `GoodsService.java:183-184`、`UserService.java:408-415` | **✅ 已修复 2026-09-21**（整实体回写收口 7 处；全仓 `goodsMapper.updateById` / `userMapper.updateById` 命中 **0**；浏览量改为 `setSql("view_count = COALESCE(view_count,0)+1")`。详见第十二节） |',
  '行 H2 补状态', '整实体回写收口 7 处');

rep(LIST, LIST_L9_OLD, LIST_L9_NEW, '行 L9 补状态', '🟠 未修（B5 候选）');

console.log('== 二、清单 §二：新增 L10（与 L5 同族）==');

afterLine(LIST, LIST_L9_NEW,
  '| L10 | 限时活动 ID 用 `static AtomicLong ID_SEQ` 进程内自增，**多实例撞号**（主键冲突 → 500）；且 base36 两段无分隔符拼接有歧义 | `ActivityService.java:61` / `:684` | **🟠 未修（2026-09-22 复核新发现）** ★ **与 L5 完全同族** —— L5 的订单号发号器已重写，这条**漏了**；`t_activity.id` 是 `VARCHAR(64) NOT NULL PRIMARY KEY` ⇒ 两实例同毫秒建活动即主键冲突。全仓「进程内可变静态状态」扫过后**只剩这一处** |',
  '新增行 L10', '| L10 | 限时活动 ID');

console.log('== 三、核对报告 §三：订正 5 行旧快照 ==');

rep(REPORT, '| M1 | 高频表缺索引 | 🟠 未修 | `db/schema-auto.sql` | ⚪ **已失效** |',
  '| M1 | 高频表缺索引 | ✅ 已补 | `db/schema-auto.sql` | ✅ **已生效** |',
  'M1 状态列', '| M1 | 高频表缺索引 | ✅ 已补 |');

rep(REPORT, '| M3 | 商品状态值不校验，可落幽灵状态 | 🟠 未修 |',
  '| M3 | 商品状态值不校验，可落幽灵状态 | ✅ 已修 |',
  'M3 状态列', '| M3 | 商品状态值不校验，可落幽灵状态 | ✅ 已修 |');

rep(REPORT,
  '| M4 | 登录无防暴力破解 | 🟠 未修 | `UserService.login` **:104**（文档写 `64-87`） | ❌ **仍存在** | 登录路径无失败计数/锁定/验证码/限流；全仓 `RateLimit` 命中 0 |',
  '| M4 | 登录无防暴力破解 | ✅ 已修（B2） | `UserService.login`；`security/LoginAttemptGuard` | ✅ **已修复 2026-09-21** | ★ **本条旧判定是错的** —— 当时 grep 只找 `RateLimit`，漏了 `LoginAttemptGuard`。实测 `UserService:120` 注入该组件、`:150 assertNotLocked`（**查库之前**）→ `:156 onFailure`（**用户不存在也计数**）→ 状态闸门**刻意不计数** → `:187 onSuccess`（只清账号、不清 IP）；双维度账号 5/15min 锁 15min、IP 100/15min 锁 5min；真机探针 22/22 |',
  'M4 状态列', '★ **本条旧判定是错的**');

rep(REPORT,
  '| M5 | 注册校验与改密口径不一致 | 🟠 未修 | `UserService.register` **:148**；对比 `changePassword` **:515** | ⚠️ **部分修复** |',
  '| M5 | 注册校验与改密口径不一致 | ✅ 已修（B0） | `UserService.register` **:202-213**；对比 `changePassword` | ✅ **已修复 2026-09-21** |',
  'M5 状态列', '| M5 | 注册校验与改密口径不一致 | ✅ 已修（B0） |');

rep(REPORT,
  '| M6 | Spring AI 里程碑版 / axios、vite CVE | 🔴 未修 | `pom.xml:27/110/123-128`；前端 `package.json` | ⚠️ **大部分是虚惊** |',
  '| M6 | Spring AI 里程碑版 / axios、vite CVE | ⚠️ 仅剩 spring-ai | `pom.xml:27/116-117`；前端 `package.json` | ⚠️ **仅 `spring-ai` 一项仍在** |',
  'M6 状态列', '⚠️ 仅剩 spring-ai');

rep(REPORT,
  '| L4 | 商品删除未连带清评论/评价 | 🟡 未修 | `GoodsService.deleteGoods` **:572**（文档写 `346-350`） | ❌ **仍存在** | :577-579 只清 `t_favorite` + `t_history`，**未清 `t_comment` / `t_review`** |',
  '| L4 | 商品删除未连带清评论/评价 | ✅ 已修（B0） | `GoodsService.deleteGoods` | ✅ **已修复 2026-09-21** | ★ **本条旧判定已过期**。实测**两条通道**都清了：单条 `:575 commentMapper.delete` / `:576 reviewMapper.delete`；批量 `:679` / `:680`。★ 这正是「单条清了、批量没清」那类缺陷，本批两条一起补。详见 §十一 |',
  'L4 状态列', '| L4 | 商品删除未连带清评论/评价 | ✅ 已修（B0） |');

const REP_L9_OLD = '| L9 | AI 接口无频控、输入直拼 prompt | 🟡 未修 | `AiController` / `AiAssistantService` | ❌ **仍存在** | 全仓无频控实现 |';
const REP_L9_NEW = '| L9 | AI 接口无频控、输入直拼 prompt | 🟠 未修 | `AiAssistantService` **:91**；`AiController` **:30 / :41** | ❌ **仍存在** | 实测 `:91` 就是 `String prompt = systemPrompt + "\\n\\n用户问题：" + userMessage;`；两个入口的 body 是裸 `Map<String,String>`，**无长度上限、无频控**（全仓 `RateLimit` 命中 0）。三条风险：prompt 注入 / 超长输入放大 token 成本 / 可被脚本刷爆配额 |';

rep(REPORT, REP_L9_OLD, REP_L9_NEW, 'L9 状态列', '| L9 | AI 接口无频控、输入直拼 prompt | 🟠 未修 |');

console.log('== 四、核对报告 §三：新增 L10 ==');

afterLine(REPORT, REP_L9_NEW,
  '| L10 | 限时活动 ID 进程内自增（**同 L5 族**） | 🟠 未修 | `ActivityService` **:61** / **:684** | ❌ **仍存在** | `private static final AtomicLong ID_SEQ = new AtomicLong();`，ID = `"act_" + base36(currentTimeMillis) + base36(ID_SEQ.incrementAndGet())`。单实例唯一（seq 只增），**多实例各从 0 起 ⇒ 同毫秒建活动即撞号**；且 base36 两段**无分隔符**拼接本身有歧义。`t_activity.id` = `VARCHAR(64) NOT NULL PRIMARY KEY` ⇒ 撞号 = 主键冲突 = 500。★ 全仓「进程内可变静态状态」扫描后**仅剩这一处**（L5 已修） |',
  '新增行 L10', '| L10 | 限时活动 ID 进程内自增');

console.log('');
if (bad) { console.error(`共 ${bad} 处失败 —— 退出码 2（没改完，别当成改完了）`); process.exit(2); }
console.log('台账校正完成。');
for (const f of [LIST, REPORT]) console.log('  ' + path.basename(f) + ': ' + fs.statSync(f).size + 'B');
