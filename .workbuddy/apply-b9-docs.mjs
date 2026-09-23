/**
 * B9 批文档销项：审计判据「红绿」全量验收 + 三条自骗判据的修复
 *
 * 惯例（沿用 apply-p111d9-docs.mjs）：
 *   · 每个锚点必须**恰好命中 1 次**，否则退出码 2（绝不做模糊替换）
 *   · 追加型节用幂等 marker，重复跑显示「已存在，跳过」
 *   · 写回后**自证**：节序号连续、marker 恰好 1 次、新节确实在文件里
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const A = (p) => path.join(ROOT, p);

const BE_DOC = 'campus-secondhand-backend/docs/服务器部署适配清单.md';
const LEDGER = '项目缺陷检查与修复清单.md';
const REPORT = '缺陷清单逐条核对报告.md';

const M = {
    list: '<!-- B9-LEDGER-29 -->',
    report: '<!-- B9-REPORT-23 -->',
    deploy: '<!-- B9-DEPLOY-711 -->',
};

let issues = 0;
const bad = (m) => { console.error('❌ ' + m); issues++; };

function edit(file, from, to, count = 1) {
    const p = A(file);
    const text = fs.readFileSync(p, 'utf8');
    const hits = text.split(from).length - 1;
    if (hits !== count) { bad(`${file}: 锚点命中 ${hits} 次（声明 ${count}）—— 未改动：${from.slice(0, 48)}…`); return false; }
    fs.writeFileSync(p, text.split(from).join(to), 'utf8');
    console.log(`✅ ${file}: 已改（${count} 处）`);
    return true;
}

/**
 * 幂等替换：**先看「已经改过」的特征串**，命中就直接跳过。
 *
 * ★ 教训（本脚本第一版就踩了）★
 * 我原来把「追加」写成 `edit(OLD, OLD + ADD)` —— OLD 依然留在文件里，
 * 于是重复跑会**再追加一份 ADD**，静默产生重复节。这正是本仓记录过的
 * 「追加型文档脚本重复跑会静默产生重复节」。正确做法：判定「是否已改」要锚
 * **ADD 里独有的句子**，而不是锚 OLD。
 */
function editOnce(file, from, to, alreadyText, count = 1) {
    const text = fs.readFileSync(A(file), 'utf8');
    if (text.includes(alreadyText)) { console.log(`⏭️  ${file}: 已改过（特征串命中），跳过`); return; }
    edit(file, from, to, count);
}

function appendSection(file, marker, body) {
    const p = A(file);
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes(marker)) { console.log(`⏭️  ${file}: 幂等 marker 已存在，跳过`); return; }
    fs.writeFileSync(p, text.replace(/\s*$/, '\n') + '\n' + body.replace(/^/, marker + '\n'), 'utf8');
    console.log(`✅ ${file}: 已追加新节`);
}

/* ================= A. 服务器部署适配清单 ================= */

const P0_NOTE_OLD = '> ⚠️ **这个脚本自己撒谎过三次，三次都已修**：';
const P0_NOTE_NEW = '> ⚠️ **这个脚本自己撒谎过六次，六次都已修**（④⑤⑥ 见下与 §7.11）：';

const NOTE_TAIL_OLD = '>    红绿：`.workbuddy/probe-l9-criterion.mjs`（移走 `AiQuotaGuard.java` ⇒ ❌ 并点名 `闸门类=false`，还原后复绿、md5 一致）。';

/* ADD 里必须有一句「只有它才有」的串，供幂等判定（这里用「第十二形态」） */
const TAIL_ADD = '\n' +
    '> ④ 第十形态（2026-09-23，B9）—— **P0-2 的 state 是硬编码 `DONE`**，只有「两个文件都不在」才 MISSING：\n' +
    '>    一条**恒真**的判据就是一条注释。更糟的是它的 `ev` 读**原文**，而这个 key 在类注释里恰好写着\n' +
    '>    ⇒ 把真代码删光只留注释，判据照样 ✅。**修法：剥注释 + 锚四条能力**（常量与 key 字面量对齐 /\n' +
    '>    真从 Environment 读 / **同一方法体内**读不到就 `throw` / 已在 `spring.factories` 注册）。\n' +
    '> ⑤ 第十一形态（同上）—— **P0-7 的「产物自检」锚在一句日志文案上**，红绿结果**方向是反的**：\n' +
    '>    删掉真正的 `assert`（闸门没了）判据**照样 ✅**；只把文案改两个字（语义零变化）判据**立刻 ❌**。\n' +
    '>    **修法：改锚闸门本身**（`assert(demoRes.length === 0` + `if (bad > 0) die(`）。\n' +
    '> ⑥ 第十二形态（同上）—— **判据被注释满足**：`/uploads/.test(.gitignore)` 命中的是**解释性注释**\n' +
    '>    （大段「为什么必须忽略 uploads」）⇒ 删掉真正的规则行 `uploads/` 判据**照样 ✅**，\n' +
    '>    而上传的图照旧会进仓库。**修法：剥注释、只认规则行。**\n' +
    '>\n' +
    '> 三次的**共同修法只有一条：判据锚「能力」，且必须在**剥掉注释**的代码上判定。**\n' +
    '> 全量验收：`.workbuddy/probe-audit-criteria-redgreen.mjs` **30 轮 / 28 条判据逐条红绿 + 2 组对照**（见 §7.11）。';
const NOTE_TAIL_NEW = NOTE_TAIL_OLD + TAIL_ADD;

/* 0) 修复第一次运行留下的重复追加（ADD 出现两份 ⇒ 收敛回一份） */
{
    const t = fs.readFileSync(A(BE_DOC), 'utf8');
    const dup = t.split(TAIL_ADD + TAIL_ADD).length - 1;
    if (dup === 1) {
        edit(BE_DOC, TAIL_ADD + TAIL_ADD, TAIL_ADD);
        console.log('🔧 ' + BE_DOC + ': 已去掉重复追加的 ④⑤⑥ 一份');
    } else {
        console.log('⏭️  ' + BE_DOC + ': 无重复追加，跳过');
    }
}

editOnce(BE_DOC, P0_NOTE_OLD, P0_NOTE_NEW, '撒谎过六次');
editOnce(BE_DOC, NOTE_TAIL_OLD, NOTE_TAIL_NEW, '第十二形态');

const ANCHOR_8 = '## 8. 附：本次审查的证据索引';
const SEC_711 = `## 7.11 审计判据的「红绿」全量验收（B9，2026-09-23 新增）

盘点脚本报 ✅ 有三种可能：① 能力真的在；② 判据**测错了地方**；③ 判据**恒真**（等于一条注释）。
「全绿」这个信号**区分不了这三者**。本轮把 27 条判据**逐条**做了一遍红绿：
把代码**变回旧实现**（能力被移除），那条判据**必须报红**；同时点名「其余判据必须仍绿」，防止一改就全红式的掩盖。

### 方法（可复跑）

\`\`\`
node .workbuddy/probe-audit-criteria-redgreen.mjs      # 30 轮；退出码 0=符合预期 / 1=判据有缺陷 / 2=脚本或环境坏了
\`\`\`

- **28 条判据各 1 轮变异** + **2 组对照**（纯注释变异、无判据依赖的配置改值 —— 都必须**不**翻转）；
- **判定函数自测**：合成用例证明它会把「该红没红」判成 DEFECT、把「不该红却红」判成 DEFECT（否则整套探针是装饰品）；
- **自证**：每轮锚点必须**恰好命中声明次数**，否则退出码 2、该轮结论作废；
- **还原**：写回原内容 → 还原移动 → 逐文件 **sha256** 比对；收尾再跑一次审计，要求 **27/27 仍全绿**；
- 解析只吃**本次运行自己**的 stdout，先剥 ANSI，状态按「与基线同一图标位」比较（不依赖 emoji 编码）。

### 抓到并修掉的三条「自骗判据」

| 编号 | 判据 | 形态 | 红绿证据 | 修法 |
|---|---|---|---|---|
| D-B9-1 | P0-2 阻断 demo profile | **第十：state 硬编码恒真**；且 ev 读原文 ⇒ 注释可满足 | 删掉 \`RESET_CONFIRMED_KEY\` 常量 ⇒ 修复前**不报红** | 剥注释 + 四条能力（常量对齐 / 真的读开关 / **同一方法体内**拒绝 / 已注册）。新增 \`methodBody()\` 按大括号配平取方法体，替代「附近 N 行」 |
| D-B9-2 | P0-7 产物自检 | **第十一：锚文案**，判别力方向反了 | 删真 \`assert\` ⇒ 不报红；**只改日志文案 ⇒ 立刻报红** | 改锚闸门：\`assert(demoRes.length === 0\` + \`if (bad > 0) die(\` |
| D-B9-3 | P2-6 .gitignore | **第十二：判据被注释满足** | 删掉规则行 \`uploads/\` ⇒ 修复前**不报红**；把全部 uploads 字样（含注释）清掉才红 | 剥注释 + 只认规则行（\`^\\s*uploads/?\\s*$\`） |

修完后复跑：**30/30 全部符合预期**，其中 R09（只改文案）从「修复前的红」变成「修复后的绿」——
**同一变异，修复前红、修复后绿**，这条本身就是修复有效性的证据。

### 两处「引用耦合」（如实记，不是缺陷）

- **P0-1 ↔ P1-8**：两条判据读**同一个 key**（\`sql.init.mode\`）⇒ 改它必然两条一起红；
- **P0-1 ↔ P0-3**：\`P0-1\`「prod profile 收口」同时要求 \`mode=never\` **与** \`secret\` 为必需占位符。

⇒ 「掉了 N 项」≠「错了 N 个能力」。这条纪律在本轮从记忆里的经验变成了**实测数据**。

### 边界（如实交代）

- 判据红绿**只证明静态判据有判别力**，不替代单测与真机：它不启动 Spring、不连 MySQL、不走拦截器；
- P1-5 / P1-6 / P1-10 / L9 / D9 / P1-11 这几条此前已各自做过红绿，本轮一并纳入**统一探针**复验；
- 探针的变异都是**真实旧实现**（不是「删一行让它编译不过」），但本轮**不构建**：静态判据只看源码形态。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 判据红绿 | \`node .workbuddy/probe-audit-criteria-redgreen.mjs\` | **30 轮全部符合预期**（28 判据轮 + 2 对照）；修复前 3 条判据该红没红 |
| 还原完整性 | 与 \`.workbuddy/tmp/redgreen-backup\` 逐文件 sha256 | **18/18 字节一致**，无 \`.redgreen-bak\` 残留 |
| 收尾复核 | 探针内置复跑 → \`audit-deploy-gap.mjs\` | **27/27 仍全绿**（未完成 0，无法判定 0） |
| 前端副本 | \`node .workbuddy/sync-check.mjs\` | \`src\` 133 项 + \`.\` 199 项，**差异 0** |

`;
if (!fs.readFileSync(A(BE_DOC), 'utf8').includes(M.deploy)) {
    edit(BE_DOC, ANCHOR_8, M.deploy + '\n' + SEC_711 + ANCHOR_8);
    console.log('✅ ' + BE_DOC + ': 已插入 §7.11');
} else console.log('⏭️  ' + BE_DOC + ': §7.11 已存在，跳过');

/* ================= B. 缺陷清单逐条核对报告 ================= */

const RV_OLD = '> 最近一次更新：**§二十二 = B8 批「P1-11 缓存层 + D9 凭据改 Cookie + P2-3 前端 base」已修**，部署适配清单 **27/27 全部通过**（另：§十一~§二十 逐节订正过历史判定）。';
const RV_NEW = '> 最近一次更新：**§二十三 = B9 批「审计判据红绿全量验收 + 三条自骗判据修复」**（2026-09-23）。27 条判据逐条红绿：**修复前 3 条该红没红**、修复后 **30/30 符合预期**，部署适配清单 **27/27 全部通过**（另：§十一~§二十 逐节订正过历史判定）。';
editOnce(REPORT, RV_OLD, RV_NEW, '§二十三 = B9 批');
editOnce(REPORT, '> 要判断「现在还剩什么没修」，请看 **§十一 ~ §二十二**（最新一节 = 当前状态），',
    '> 要判断「现在还剩什么没修」，请看 **§十一 ~ §二十三**（最新一节 = 当前状态），',
    '§十一 ~ §二十三');

const SEC_23 = `## 二十三、B9 批：审计判据「自骗」三例的核对（2026-09-23）

> 核对口径同全篇：**只看代码与可复跑的证据，不采信判据自己的 ✅**。
> 本轮核对对象不是产品代码，而是**盘点脚本本身**——它也会撒谎，本轮实测到第 10/11/12 三种新形态。

### 23.1 为什么要做这一轮

\`audit-deploy-gap.mjs\` 的 27 条判据里，此前只有 P1-3 / L9 / P1-5 / P1-6 / P1-10 / D9 / P1-11 做过红绿，
**其余 20 条从未被证明「不是死判据」**。本仓已经吃过一次亏（该脚本曾把 5 项已落地误报成「没做」）。
⇒ 全量做一遍：28 条判据各 1 轮变异 + 2 组对照，见 \`.workbuddy/probe-audit-criteria-redgreen.mjs\`。

### 23.2 逐条核对结果

| 判据 | 变异（旧实现） | 修复前 | 修复后 | 备注 |
|---|---|---|---|---|
| P0-1 | \`mode: never\` → \`always\` | ✅ 报红 | ✅ | 与 P1-8 **引用耦合**（同一 key） |
| P0-2 | 删 \`RESET_CONFIRMED_KEY\` 常量 | ❌ **该红没红** | ✅ 报红 | D-B9-1，见 23.3 |
| P0-2b | 删 pom 的 \`db/demo-*.sql\` 排除 | ✅ | ✅ | |
| P0-3 | JWT 密钥写死 | ✅ | ✅ | 额外带红 P0-1（收口判据覆盖 secret） |
| P0-4 | 去 \`forward-headers-strategy\` | ✅ | ✅ | |
| P0-5 | 去 \`connection-init-sql\` | ✅ | ✅ | |
| P0-6 | 移走 \`mvnw\` | ✅ | ✅ | |
| P0-7 | 删产物自检 \`assert\` | ❌ **该红没红** | ✅ 报红 | D-B9-2，见 23.3 |
| P0-7 | 只改日志文案 | ⚠️ **不该红却红** | ✅ 不翻转 | 同一变异修复前红/修复后绿 = 修复有效性证据 |
| P0-8 | 移除两处 \`maxHistory\` | ✅ | ✅ | |
| P0-9 | \`mapper: info\` → \`debug\` | ✅ | ✅ | |
| P0-10 | 绑回 \`0.0.0.0\` | ✅ | ✅ | |
| P1-1 | URL 加 \`createDatabaseIfNotExist\` | ✅ | ✅ | |
| P1-3 | 产物名去 \`\${version}\` | ✅ | ✅ | |
| P1-4 | 移走 systemd unit | ✅ | ✅ | |
| P1-5 | \`/health\` → \`/healthz\` | ✅ | ✅ | |
| P1-6 | 删 finally 里的 \`MDC.clear()\` | ✅ | ✅ | |
| P1-7 | 移走 \`LoginAttemptGuard\` | ✅ | ✅ | |
| P1-10 | 注释掉上传闸门调用 | ✅ | ✅ | |
| P1-11 | 删一处 \`invalidate\`（6→5） | ✅ | ✅ | |
| P1-12 | 线程数 50 → 200 | ✅ | ✅ | |
| P2-2 | 删 \`engines\`（本仓无 \`.nvmrc\`） | ✅ | ✅ | |
| P2-3 | \`base\` 写死 \`/\` | ✅ | ✅ | |
| P2-4 | 图片上限 2MB → 3MB | ✅ | ✅ | |
| P2-6 | 删 \`.gitignore\` 的 \`uploads/\` 规则行 | ❌ **该红没红** | ✅ 报红 | D-B9-3，见 23.3 |
| P2-6 | 清掉全部 \`uploads\` 字样（含注释） | ✅ | ✅ | 证明它**不是恒真，只是太宽** |
| L9 | 删一处 \`quotaGuard.acquire\` | ✅ | ✅ | |
| D9 | 下发支 \`httpOnly(true)\` → \`false\` | ✅ | ✅ | |
| 对照① | 纯注释变异 | ✅ 不翻转 | ✅ | |
| 对照② | 改无判据依赖的配置值 | ✅ 不翻转 | ✅ | |

### 23.3 三条缺陷的细节与处置

- **D-B9-1（P0-2）第十形态：state 硬编码恒真。** 原实现 \`return { state: 'DONE', ev: … }\` ——
  只要两个文件存在就恒绿；而 \`ev\` 读**原文**，类注释里恰好写着 \`--app.demo.reset-confirmed=true\`
  ⇒ 删光真代码只留注释也能骗过。**已修**：\`javaCode()\` 剥注释 + 四条能力判定，
  并新增 \`methodBody()\`（按大括号配平取方法体）实现真正的「同一函数体内」。
- **D-B9-2（P0-7）第十一形态：锚文案，判别力方向反了。** 原判据查日志里那句
  \`demo 资源（必须 0）\`。**已修**：改查 \`assert(demoRes.length === 0\` 与 \`if (bad > 0) die(\`。
- **D-B9-3（P2-6）第十二形态：判据被注释满足。** 原判据 \`/uploads/.test(.gitignore)\` 命中的是
  **解释性注释**（大段「为什么必须忽略 uploads」）。**已修**：剥注释 + 只认规则行。

### 23.4 结论

- 27 条判据里 **24 条原本就有判别力**、**3 条是自骗判据**（占 11%）——这就是「全绿」看不出来的东西；
- 修完后全量 **30/30 符合预期**，收尾复跑 **27/27 仍全绿**，还原 **18/18 字节一致**，
  前端两副本 \`sync-check\` **差异 0**；
- 遗留（如实交代）：判据红绿**只覆盖静态形态**，不替代单测与真机；探针不构建、不启动 Spring。
`;
appendSection(REPORT, M.report, SEC_23);

/* ================= C. 项目缺陷检查与修复清单 ================= */

const SEC_29 = `## 二十九、第二十一轮（B9 批）：审计判据「红绿」全量验收 + 三条自骗判据修复（2026-09-23）

本轮修的不是产品缺陷，而是**盘点工具自己的缺陷** —— 台账会撒谎，审计脚本也会。

### 29.1 起因

\`audit-deploy-gap.mjs\` 的 27 条判据里，此前只有 7 条做过红绿。**「全绿」不是证据**：
它区分不了「能力真的在」与「判据恒真/测错地方」。若不验证，剩下 20 条随时可能是装饰品
（本仓已吃过一次：该脚本曾把 5 项已落地误报成「没做」）。

### 29.2 方法

- **28 条判据各 1 轮变异**（把代码变回旧实现）+ **2 组对照**（纯注释变异 / 无判据依赖的配置改值，
  都必须**不**翻转）；
- 每轮同时点名「**必须红**」与「**其余必须仍绿**」，防掩盖；
- **判定函数自测**：合成用例证明它能识别「该红没红」与「不该红却红」（否则整套探针是装饰品）；
- **自证**：锚点必须恰好命中声明次数，否则退出码 2、该轮作废；解析只吃本次运行的 stdout、先剥 ANSI、
  按「与基线同一图标位」判状态（不依赖 emoji 编码）；
- **还原**：写回 → 还原移动 → 逐文件 sha256；任何 infra 退出都发生在还原**之后**（避免变异残留）；
- 退出码三态：\`0\` 符合预期 / \`1\` 判据有缺陷 / \`2\` 脚本或环境坏了。

### 29.3 三条缺陷

| 编号 | 判据 | 形态 | 证据（修复前） | 处置 |
|---|---|---|---|---|
| **D-B9-1** | P0-2 阻断 demo profile | **第十形态：state 硬编码恒真**（\`return { state: 'DONE' }\`），且 ev 读原文 ⇒ 注释可满足 | 删 \`RESET_CONFIRMED_KEY\` 常量 ⇒ **不报红** | 剥注释 + 四条能力：常量与 key 字面量对齐 / 真读 \`env.getProperty\` / **同一方法体内** \`throw\` / 已在 \`spring.factories\` 注册。新增 \`methodBody()\` 按括号配平取方法体 |
| **D-B9-2** | P0-7 产物自检 | **第十一形态：锚文案**（判别力方向反了） | 删真 \`assert\` ⇒ **不报红**；只改日志文案 ⇒ **立刻报红** | 改锚闸门：\`assert(demoRes.length === 0\` + \`if (bad > 0) die(\` |
| **D-B9-3** | P2-6 \`.gitignore\` | **第十二形态：判据被注释满足** | 删规则行 \`uploads/\` ⇒ **不报红**（注释里到处是 uploads） | 剥注释 + 只认规则行 |

三条的共同修法一条：**判据锚「能力」，且必须在剥掉注释的代码上判定。**

### 29.4 证据（四层，缺一不可）

| 层 | 命令 | 结果 |
|---|---|---|
| 单测 | —— | 本轮**不涉及产品代码**（只读静态形态做变异并还原），故无单测层；产品单测维持 **489/489** 基线未动 |
| 红绿 | \`node .workbuddy/probe-audit-criteria-redgreen.mjs\` | 修复前 **3 条该红没红 + 1 处不该红却红**；修复后 **30/30 全部符合预期** |
| 判据 | \`node .workbuddy/audit-deploy-gap.mjs\` | **27/27 全绿**（收尾复核，探针内置） |
| 还原 | 与 \`.workbuddy/tmp/redgreen-backup\` 逐文件 sha256 | **18/18 字节一致**；无 \`.redgreen-bak\` 残留；\`sync-check\` 前端两副本 **差异 0** |

### 29.5 顺带确证的一条旧纪律（现在是实测数据）

- **P0-1 ↔ P1-8** 读同一个 key（\`sql.init.mode\`）⇒ 改它两条一起红；
- **P0-1 ↔ P0-3**：P0-1 同时要求 \`mode=never\` 与 \`secret\` 为必需占位符。

⇒ 「掉了 N 项」≠「错了 N 个能力」。原先是记忆里的一条告诫，本轮拿到了实测。

### 29.6 边界（如实记）

- 判据红绿**只证明静态判据有判别力**，不替代单测与真机：不启动 Spring、不连 MySQL、不走拦截器；
- 变异都是**真实旧实现**（不是「删一行让它编译不过」），但本轮**不构建**，因此「编译期发现的缺陷」不在覆盖内；
- P0-2 的**注册链路**（\`spring.factories\` 是否真被容器读到）此前由真机 28 PASS/0 FAIL 覆盖，本轮不重复。
`;
appendSection(LEDGER, M.list, SEC_29);

/* ================= 自证 ================= */

console.log('\n=== 自证 ===');
const secNums = (file, re) => [...fs.readFileSync(A(file), 'utf8').matchAll(re)].map((m) => m[1]);

const ledgerNums = secNums(LEDGER, /^## ([一二三四五六七八九十]+、)/gm).map((s) => s.replace('、', ''));
const zh = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六',
    '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九'];
const expectLedger = zh.slice(0, ledgerNums.length);
const ledgerOk = ledgerNums.every((n, i) => n === expectLedger[i]);
console.log(`${ledgerOk ? '✅' : '❌'} ${LEDGER}: 节序号连续（共 ${ledgerNums.length} 节，末节 = ${ledgerNums.at(-1)}）`);
if (!ledgerOk) { bad('清单节序号不连续：' + ledgerNums.join(',')); }

const reportNums = secNums(REPORT, /^## ([一二三四五六七八九十]+、)/gm).map((s) => s.replace('、', ''));
const expectReport = zh.slice(0, reportNums.length);
const reportOk = reportNums.every((n, i) => n === expectReport[i]);
console.log(`${reportOk ? '✅' : '❌'} ${REPORT}: 节序号连续（共 ${reportNums.length} 节，末节 = ${reportNums.at(-1)}）`);
if (!reportOk) { bad('核对报告节序号不连续：' + reportNums.join(',')); }

for (const [file, marker] of [[LEDGER, M.list], [REPORT, M.report], [BE_DOC, M.deploy]]) {
    const c = fs.readFileSync(A(file), 'utf8').split(marker).length - 1;
    console.log(`${c === 1 ? '✅' : '❌'} ${file}: 幂等 marker 出现 ${c} 次`);
    if (c !== 1) bad(`${file}: marker 出现 ${c} 次`);
}

const deployText = fs.readFileSync(A(BE_DOC), 'utf8');
const chk = [
    ['§7.11 节标题', '## 7.11 审计判据的「红绿」全量验收'],
    ['④⑤⑥ 已补', '第十二形态'],
    ['次数已订正', '撒谎过六次'],
    ['§8 仍在 §7.11 之后', deployText.indexOf('## 8. 附：本次审查的证据索引') > deployText.indexOf('## 7.11')],
    // ★ 追加型脚本的经典事故：重复跑产生重复节。这里把「不重复」本身作为判据
    ['④⑤⑥ 只有一份（无重复节）', (deployText.split('> ④ 第十形态').length - 1) === 1],
    ['§7.11 只有一节', (deployText.split('## 7.11 ').length - 1) === 1],
];
for (const [name, v] of chk) {
    const ok = typeof v === 'boolean' ? v : deployText.includes(v);
    console.log(`${ok ? '✅' : '❌'} 部署清单: ${name}`);
    if (!ok) bad('部署清单: ' + name);
}

console.log(`\n${issues === 0 ? '全部通过：0 处异常' : `存在 ${issues} 处异常`}`);
process.exit(issues === 0 ? 0 : 2);
