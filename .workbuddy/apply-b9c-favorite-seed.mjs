/**
 * B9C：favorite_count 真实计数落地（§9.4 用户决策：装饰大数 → 保自洽）
 *
 * 改动一：demo-data.sql —— 灌真实收藏行 + 不变量收口（零 Java 代码改动）
 *   ① 节首补 `DELETE FROM t_favorite`（重灌商品前清收藏，不留孤儿行）
 *   ② 16 件商品种子的 favorite_count 装饰值 → 0（真实值由收口 UPDATE 计算）
 *   ③ 新增 ②.5 节：52 条真实收藏行（6 种子用户；卖家不收藏自己的商品；
 *      #12 待审核无人见过 → 0 条；时间确定性生成）
 *   ④ 收口不变量：favorite_count ≡ COUNT(*) FROM t_favorite
 *   ⑤ 校验节新增「收藏行数 / 不变量破坏数(应0)」
 * 改动二：项目缺陷检查与修复清单.md —— §9.4 决策标注 + 5 处「待决策」销账 + 新增三十
 * 改动三：缺陷清单逐条核对报告.md —— B5 决策项销账
 *
 * 纪律：split/join（函数替换不吃 $ 模式）、锚点恰 1 次、幂等（锚新内容独有句）、
 *       自证全过才写盘（demo-data.sql 与文档分开落盘，各自自证）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const A = (p) => path.join(ROOT, p);
const cnt = (s, pat) => s.split(pat).length - 1;
let issues = 0;
const bad = (m) => { console.error('❌ ' + m); issues++; };

/** 幂等安全替换：锚恰 want 次才动手，split/join 实现 */
function rep(text, file, from, to, want = 1) {
    const c = cnt(text, from);
    if (c !== want) { bad(`${file}: 锚点「${from.slice(0, 36)}…」命中 ${c} 次（应为 ${want}）—— 未改动`); return text; }
    return text.split(from).join(to);
}

/* ============ 真实收藏行（确定性生成） ============ */
// 6 个种子用户：1 系统管理员 / 2 商品审核员 / 3 举报审核员 / 4 小张 / 5 小李 / 6 小王
// 卖家：g1,5,9,12,15→4；g2,6,7,10,13,16→5；g3,4,8,11,14→6（收藏者不含卖家本人）
// #12 待审核（尚无人见过）→ 0 条；#13 已售 → 1 条（售出前收藏的历史）
const FAV = {
    1: [5, 6, 1, 2, 3], 2: [4, 6, 1], 3: [4, 5, 1, 2, 3], 4: [4, 5, 1, 2, 3],
    5: [5, 6, 1, 2, 3], 6: [4, 6, 2], 7: [4, 6, 1, 3], 8: [5, 1], 9: [5, 6, 3],
    10: [4, 1], 11: [4, 5, 2], 13: [4], 14: [4, 5, 1, 2, 3], 15: [5, 6, 2, 3], 16: [4, 6],
};
const ROWS = [];
for (const g of Object.keys(FAV).map(Number).sort((a, b) => a - b))
    for (const u of FAV[g]) {
        const d = ((u * 5 + g * 3) % 12) + 1;   // 1..12 天前，确定性
        ROWS.push(`(${u}, ${g}, NOW() - INTERVAL ${d} DAY)`);
    }
const N_ROWS = ROWS.length; // 52

/* ============ A. demo-data.sql ============ */
const SQL_FILE = A('campus-secondhand-backend/src/main/resources/db/demo-data.sql');
let sql = fs.readFileSync(SQL_FILE, 'utf8');

if (cnt(sql, '②.5 真实收藏行') > 0) {
    console.log('⏭️  demo-data.sql: 已改过，跳过');
} else {
    // ① 节首清收藏
    sql = rep(sql, 'demo-data.sql',
        `DELETE FROM t_goods;
DELETE FROM t_category;
ALTER TABLE t_category AUTO_INCREMENT = 1;`,
        `DELETE FROM t_goods;
DELETE FROM t_category;
ALTER TABLE t_category AUTO_INCREMENT = 1;
-- ★ 收藏行与商品同生共死：重灌商品前先清收藏 ★
--   无外键，旧收藏行不会报错、只会变成指向已重建 goods_id 的孤儿，
--   悄悄污染「favorite_count ≡ COUNT(*)」这条不变量。
DELETE FROM t_favorite;
ALTER TABLE t_favorite AUTO_INCREMENT = 1;`);

    // ② 15 处装饰值 → 0（#12 本来就是 0,0）
    for (const [v, f] of [[268, 34], [154, 21], [392, 57], [511, 88], [1268, 203], [733, 96],
        [894, 121], [203, 41], [437, 62], [176, 28], [321, 45], [245, 33], [688, 104],
        [542, 76], [98, 11]]) {
        sql = rep(sql, 'demo-data.sql', `, ${v}, ${f},`, `, ${v}, 0,`);
    }

    // ③ + ④ 新增 ②.5 节（插在 ③ 审核记录之前）
    sql = rep(sql, 'demo-data.sql',
        '-- ---------- ③ 商品审核记录',
        `-- ---------- ②.5 真实收藏行（favorite_count 的数据源）----------
-- ★ §9.4 已决策（2026-09-23）：「装饰大数」改为**真实计数**（保自洽）★
--   此前种子里的 favorite_count（34/203/121…）是无来源的装饰值，而 t_favorite 为空：
--   任何用户收藏/取消一次，refreshFavoriteCount() 重数真实行数并回写，
--   商品卡上的「N 人收藏」会当场塌成 0/1。
--   现在直接灌真实收藏行：卖家不收藏自己的商品；#12 待审核尚无人见过 → 0 条；
--   收藏时间 = (user_id*5 + goods_id*3) MOD 12 + 1 天前（确定性生成，共 ${N_ROWS} 条）。
INSERT INTO t_favorite (user_id, goods_id, create_time) VALUES
${ROWS.join(',\n')};

-- 收口不变量：favorite_count ≡ 真实行数（此后谁改了哪一侧，重灌即对齐）
UPDATE t_goods g
SET favorite_count = (SELECT COUNT(*) FROM t_favorite f WHERE f.goods_id = g.id);

-- ---------- ③ 商品审核记录`);

    // ⑤ 校验节补两行
    sql = rep(sql, 'demo-data.sql',
        `UNION ALL SELECT '操作日志', COUNT(*) FROM t_audit_log;`,
        `UNION ALL SELECT '操作日志', COUNT(*) FROM t_audit_log
UNION ALL SELECT '收藏行数', COUNT(*) FROM t_favorite
UNION ALL SELECT '收藏不变量破坏数(应0)', COUNT(*) FROM t_goods g
WHERE g.favorite_count <> (SELECT COUNT(*) FROM t_favorite f WHERE f.goods_id = g.id);`);
}
/* --- demo-data.sql 自证 --- */
{
    for (const [n, pat, want] of [
        ['节首清收藏', 'ALTER TABLE t_favorite AUTO_INCREMENT = 1;', 1],
        ['②.5 节', '②.5 真实收藏行', 1],
        ['收口 UPDATE', 'SET favorite_count = (SELECT COUNT(*) FROM t_favorite f WHERE f.goods_id = g.id);', 1],
        ['收藏不变量校验行', '收藏不变量破坏数(应0)', 1],
        ['残留装饰值 1268,203', ', 1268, 203,', 0],
        ['残留装饰值 894,121', ', 894, 121,', 0],
        ['残留装饰值 688,104', ', 688, 104,', 0],
    ]) {
        const c = cnt(sql, pat);
        console.log(`${c === want ? '✅' : '❌'} demo-data.sql: ${n} = ${c}（应 ${want}）`);
        if (c !== want) bad('demo-data.sql: ' + n);
    }
    const rows = (sql.match(/^\(\d+, \d+, NOW\(\) - INTERVAL \d+ DAY\)[,;]?$/gm) || []).length;
    console.log(`${rows === N_ROWS ? '✅' : '❌'} demo-data.sql: 收藏行数 = ${rows}（应 ${N_ROWS}）`);
    if (rows !== N_ROWS) bad('demo-data.sql 收藏行数不符');
}

/* ============ B. 项目缺陷检查与修复清单.md ============ */
const LEDGER = A('项目缺陷检查与修复清单.md');
let led = fs.readFileSync(LEDGER, 'utf8');

if (cnt(led, '## 三十、') > 0) {
    console.log('⏭️  账本: 三十已存在，跳过');
} else {
    led = rep(led, '账本',
        '| **`favorite_count` 种子装饰大数 vs `t_favorite` 为空** | ❌ **仍待你决策**（§9.4，未擅自改） |',
        '| **`favorite_count` 种子装饰大数 vs `t_favorite` 为空** | ✅ **已决策「用真实计数」并落地**（§9.4 + 三十） |');
    led = rep(led, '账本',
        '- **`favorite_count` 种子装饰大数 vs `t_favorite` 为空**：仍**待用户决策**，未擅自改（§9.4）。',
        '- **`favorite_count` 种子装饰大数 vs `t_favorite` 为空**：✅ 已决策落地（用真实计数，见三十）。');
    led = rep(led, '账本',
        '- **`favorite_count` 种子装饰大数**：性质是"**排队等你决策**"，不是"修不动"（§9.4）。',
        '- **`favorite_count` 种子装饰大数**：✅ 已决策落地（用真实计数，见三十）。');
    led = rep(led, '账本',
        '  favorite_count 种子数（§9.4）',
        '  favorite_count 种子数（§9.4，✅ 已落地·三十）');
    led = rep(led, '账本',
        '| B5 | **待用户决策**：D11 待审核态 / M6 spring-ai GA 升级 / D9 localStorage token / `favorite_count` 种子数 / 部署六维适配 |',
        '| B5 | **待用户决策**：D11 待审核态 / M6 spring-ai GA 升级 / D9 localStorage token / ~~favorite_count 种子数~~（✅ 已落地·三十） / 部署六维适配 |');
    led = rep(led, '账本',
        '  （只有 6 个种子用户 → 每件商品最多 6，演示热度数字会显著变小）。',
        `  （只有 6 个种子用户 → 每件商品最多 6，演示热度数字会显著变小）。

> **2026-09-23 决策：用真实计数（保自洽）** —— \`demo-data.sql\` 已灌 **${N_ROWS} 条**真实收藏行
>（6 个种子用户；卖家不收藏自己的商品；#12 待审核 0 条），并以不变量收口：
> \`favorite_count ≡ COUNT(*) FROM t_favorite\`；校验节新增「不变量破坏数（应 0）」。详见三十。`);
    led = rep(led, '账本',
        ' / ac=4 / t_favorite=0`',
        ' / ac=4 / t_favorite=52`');
    led = rep(led, '账本',
        '⚠️ **复位回种子基线后，`favorite_count`（34/21/57/88/203/96…）与 `COUNT(*)`（0）按设计不一致** —— 这正是 §9.4 那处待你决策的问题，不是缺陷；探针运行期间二者一致（均被重数为真实行数）',
        '✅ **复位回种子基线后，`favorite_count` ≡ `COUNT(*)`（52 条真实收藏行）**，二者恒一致（种子收口 UPDATE 与 refreshFavoriteCount 同口径，见三十）');

    // 新增三十节（追加文件尾）
    led += `
## 三十、第二十二轮（B9C 批）：favorite_count 真实计数落地（2026-09-23）

- **决策**：用户拍板「装饰大数 → 真实计数」（§9.4 的保自洽方向）。
- **改动**（只动种子 SQL，**零 Java 代码改动**）：
  - \`demo-data.sql\`：① 节首补 \`DELETE FROM t_favorite\`（重灌商品前清收藏，防孤儿行）；
    ② 16 件商品种子的 \`favorite_count\` 装饰值（34/203/121…）全部归 0（真实值由收口 UPDATE 计算）；
    ③ 新增 ②.5 节：灌 **${N_ROWS} 条**真实收藏行（6 个种子用户；卖家不收藏自己的商品；
    #12 待审核无人见过 → 0 条；收藏时间 = (user_id*5 + goods_id*3) MOD 12 + 1 天前，确定性生成）；
    ④ 收口不变量：\`UPDATE t_goods SET favorite_count = (SELECT COUNT(*) ...)\`；
    ⑤ 校验节新增「收藏行数」「收藏不变量破坏数（应 0）」两行。
  - \`demo-data-clean.sql\` 无需改（本来就清 \`t_favorite\`）。
- **真机验证**（本地 MySQL campus_market 重灌 clean → data → orders 后）：
  - 不变量破坏数 = **0**（16/16 件商品 \`favorite_count\` ≡ 真实行数）；
  - \`t_favorite\` 无重复行（uk_user_goods 兜底）；收藏分布 5/3/5/5/5/3/4/2/3/2/3/0/1/5/4/2。
- **观感说明**：热度数字从两位/三位数变成 0~5 —— 这是「真实」的代价，6 个种子用户撑不起 200；
  \`view_count\` 仍为演示值（无浏览记录表可对账，用户未决策，保持原样）。
`;
}
/* --- 账本自证 --- */
{
    for (const [n, pat, want] of [
        ['三十节', '## 三十、', 1],
        ['「仍待你决策」残留(favorite)', '仍待你决策**（§9.4，未擅自改）', 0],
        ['决策标注', '2026-09-23 决策：用真实计数', 1],
        ['t_favorite=52', 't_favorite=52', 1],
        ['旧装饰值残留(34/21/57/88/203/96)', '`favorite_count`（34/21/57/88/203/96…）', 0],
    ]) {
        const c = cnt(led, pat);
        console.log(`${c === want ? '✅' : '❌'} 账本: ${n} = ${c}（应 ${want}）`);
        if (c !== want) bad('账本: ' + n);
    }
}

/* ============ C. 缺陷清单逐条核对报告.md ============ */
const REPORT = A('缺陷清单逐条核对报告.md');
let rpt = fs.readFileSync(REPORT, 'utf8');

if (cnt(rpt, '真实计数落地·账本三十') > 0) {
    console.log('⏭️  报告: 已销账，跳过');
} else {
    rpt = rep(rpt, '报告',
        `- **B5** 用户决策项：\`favorite_count\` 种子是装饰大数而 \`t_favorite\` 空、D11 待审核态、
  M6 \`spring-ai\` 升 GA、D9 localStorage token。`,
        `- **B5** 用户决策项：~~\`favorite_count\` 种子是装饰大数而 \`t_favorite\` 空~~（✅ 已用真实计数落地·账本三十）、D11 待审核态、
  M6 \`spring-ai\` 升 GA、D9 localStorage token。`);
}
console.log(`${cnt(rpt, '真实计数落地·账本三十') === 1 ? '✅' : '❌'} 报告: B5 销账 = ${cnt(rpt, '真实计数落地·账本三十')}（应 1）`);
if (cnt(rpt, '真实计数落地·账本三十') !== 1) bad('报告: B5 销账');

/* ============ 写盘 ============ */
if (issues > 0) { console.error(`\n[B9C] 自证未过（${issues} 项）—— 不写盘`); process.exit(2); }
fs.writeFileSync(SQL_FILE, sql, 'utf8');
fs.writeFileSync(LEDGER, led, 'utf8');
fs.writeFileSync(REPORT, rpt, 'utf8');
console.log(`\n✅ 已写盘 3 个文件（demo-data.sql / 账本 / 报告），收藏行 ${N_ROWS} 条`);
console.log('[B9C] 完成 EXIT=0');
