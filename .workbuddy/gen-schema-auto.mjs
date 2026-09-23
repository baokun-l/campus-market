/**
 * 从 schema.sql 生成 schema-auto.sql（非破坏性建表脚本）+ 漂移校验
 * ----------------------------------------------------------------------------
 * 为什么需要两个脚本（而不是把 schema.sql 直接配到 spring.sql.init）：
 *
 *   schema.sql 是**重建型**脚本 —— 17 张表每张都是
 *   `DROP TABLE IF EXISTS x;` + `CREATE TABLE x (...)`。
 *   它适合「干净重装一个库」，但**绝对不能**放进 spring.sql.init.schema-locations：
 *   那是每次启动都执行的地方，配上去等于每次启动把全库清空。
 *
 *   schema-auto.sql 是**幂等追加型**：零 DROP、全部 `CREATE TABLE IF NOT EXISTS`。
 *   空库启动 → 建表；已有库启动 → 一条 no-op。这才可以放心自动执行。
 *
 * 两份 DDL 必须语义一致，否则新环境建出的表会悄悄少列。
 * 所以本脚本负责「从 schema.sql 派生」而不是「另写一份」，
 * 并支持 --check 校验当前 schema-auto.sql 是否已与 schema.sql 同步。
 *
 * 用法：
 *   node .workbuddy/gen-schema-auto.mjs           # 生成 / 刷新
 *   node .workbuddy/gen-schema-auto.mjs --check   # 只校验，不一致则退出码 1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DB_DIR = join(
  'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)',
  'campus-secondhand-backend', 'src', 'main', 'resources', 'db'
);
const SRC = join(DB_DIR, 'schema.sql');
const OUT = join(DB_DIR, 'schema-auto.sql');

const BEGIN = '-- ===== BEGIN GENERATED DDL';
const END = '-- ===== END GENERATED DDL =====';

/** schema.sql → 非破坏性 DDL 正文 */
function deriveDdl() {
  const raw = readFileSync(SRC, 'utf8');
  const out = [];
  const dropped = [];
  for (const line of raw.split('\n')) {
    // ① 丢掉重建语义的三类语句
    if (/^\s*DROP\s+TABLE\s+IF\s+EXISTS\s+/i.test(line)) { dropped.push(line.trim()); continue; }
    if (/^\s*CREATE\s+DATABASE\s+/i.test(line)) continue;   // 库由 createDatabaseIfNotExist 建
    if (/^\s*USE\s+/i.test(line)) continue;                 // 连接已在目标库里
    // ② 建表改为 IF NOT EXISTS
    const m = line.match(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s+)(\S+)\s*\(/i);
    if (m) { out.push('CREATE TABLE IF NOT EXISTS ' + m[1] + ' ('); continue; }
    out.push(line);
  }
  // ③ 砍掉「初始数据」段：种子单独放 seed-base.sql（那里能写幂等判断，这里只放结构）
  const text = out.join('\n');
  const cut = text.indexOf('-- ==================== 初始数据 ====================');
  const ddl = (cut >= 0 ? text.slice(0, cut) : text).replace(/\s+$/, '') + '\n';
  return { ddl, dropped };
}

function fingerprint(text) {
  return createHash('md5').update(text).digest('hex').slice(0, 12);
}

/**
 * 种子覆盖校验：schema.sql 的「初始数据」段里每一条种子，
 * 都必须在幂等版 seed-base.sql 里出现。
 *
 * 为什么需要它：seed-base.sql 的种子是**手工改写**成幂等形态的（要包一层
 * 「表空才灌」的判断，没法从 VALUES 形式自动派生）。于是就有了一个典型风险 ——
 * 有人往 schema.sql 加了一个种子用户，忘了同步 seed-base.sql：
 *   手工装库的老环境有这个用户，靠 sql.init 自动建库的新环境却没有。
 * 这种「两个环境数据不一样」的 bug 事后极难定位，所以在生成时当场拦住。
 *
 * ★ 两个必须防住的自身缺陷（都实际发生过）★
 *   ① **漏取后半段**：schema.sql 里同一张表可以有**多条** INSERT
 *      （t_user 就是「管理员」一条 + 「演示用户」一条）。若只从 marker 往后
 *      取到第一个 `;`，第二段就完全不在校验范围内 —— 校验报告 PASS，
 *      但 zhangsan / lisi / wangwu 三个账号从来没被检查过。
 *      所以这里按「所有 INSERT 片段」取，并断言片段数 == marker 出现次数。
 *   ② **空转假 PASS**：正则写错导致一条都提取不到时，
 *      「缺口为空」→ 报 PASS。所以每种 seed 都必须提取到 ≥1 条，
 *      提取到 0 就直接判 BROKEN，而不是庆祝通过。
 */
function seedCoverage() {
  const schema = readFileSync(SRC, 'utf8');
  let seed;
  try { seed = readFileSync(join(DB_DIR, 'seed-base.sql'), 'utf8'); }
  catch { return { broken: ['seed-base.sql 文件不存在'], missing: [], counts: {} }; }

  /** 取该表**全部** INSERT 片段，并回报片段数与 marker 出现次数是否一致 */
  const fragments = (table) => {
    const marker = `INSERT INTO ${table}`;
    const occurrences = schema.split(marker).length - 1;
    const found = [
      ...schema.matchAll(new RegExp(marker.replace(/ /g, '\\s+') + '[\\s\\S]*?;', 'g')),
    ].map((m) => m[0]);
    return { text: found.join('\n'), occurrences, found: found.length };
  };

  const missing = [];
  const broken = [];
  const counts = {};

  // t_user：形如 ('admin', '$2a$10$... —— 取用户名
  const u = fragments('t_user');
  if (u.found !== u.occurrences) broken.push(`t_user 的 INSERT 片段数与 marker 出现次数不符（取到 ${u.found} / 应为 ${u.occurrences}）`);
  const users = [...u.text.matchAll(/^\('([A-Za-z0-9_]+)',\s*'\$2a\$/gm)].map((m) => m[1]);
  counts['用户'] = users.length;
  if (users.length === 0) broken.push('t_user 一条用户名都没提取到（校验空转）');
  for (const name of users) if (!seed.includes(`'${name}'`)) missing.push({ kind: '用户', value: name });

  // t_category：形如 ('教材', '📚')
  const c = fragments('t_category');
  const cats = [...c.text.matchAll(/\('([^']+)',\s*'[^']*'\)/g)].map((m) => m[1]);
  counts['分类'] = cats.length;
  if (cats.length === 0) broken.push('t_category 一条分类都没提取到（校验空转）');
  for (const name of cats) if (!seed.includes(`'${name}'`)) missing.push({ kind: '分类', value: name });

  // t_notice：行首的标题
  const n = fragments('t_notice');
  const notices = [...n.text.matchAll(/^\('([^']+)',/gm)].map((m) => m[1]);
  counts['公告'] = notices.length;
  if (notices.length === 0) broken.push('t_notice 一条公告都没提取到（校验空转）');
  for (const title of notices) if (!seed.includes(`'${title}'`)) missing.push({ kind: '公告', value: title });

  // t_settings 是单行配置，schema.sql 里也是单条 INSERT，只校验片段存在
  const s = fragments('t_settings');
  counts['设置'] = s.found;
  if (s.found === 0) broken.push('t_settings 没找到 INSERT 片段（校验空转）');

  return { broken, missing, counts };
}

function buildFile(ddl) {
  const srcMd5 = createHash('md5').update(readFileSync(SRC)).digest('hex');
  return `-- ====================================================================
-- 校园二手集市 - 自动建表脚本（非破坏性）
-- ====================================================================
-- ★ 这个文件由 .workbuddy/gen-schema-auto.mjs 从 schema.sql 生成，请勿手改 ★
--   改了会在 --check 时被判为漂移；要改表结构请改 schema.sql，再重新生成：
--       node .workbuddy/gen-schema-auto.mjs
--
-- 与 schema.sql 的分工：
--   schema.sql       重建型（DROP + CREATE），用于「干净重装一个库」，手工执行
--   schema-auto.sql  追加型（CREATE TABLE IF NOT EXISTS，零 DROP），
--                    由 application.yml 的 spring.sql.init 在**每次启动**执行
--
-- 为什么可以每次启动都跑：全部语句都是 IF NOT EXISTS，已有库上每条都是 no-op，
--   不删表、不动数据、不改已有列。空库上则等价于一次性建好 17 张表。
--
-- 为什么不在这里放种子数据：种子的幂等需要「表空才灌」的判断，见 db/seed-base.sql
--   （由 spring.sql.init.data-locations 在结构之后执行）。
--
-- 源文件指纹（schema.sql md5 = ${srcMd5}）
-- ====================================================================

${BEGIN}（由 gen-schema-auto.mjs 从 schema.sql 生成，勿手改）=====
${ddl}${END}
`;
}

// ---------- 主流程 ----------
const { ddl, dropped } = deriveDdl();
const content = buildFile(ddl);
const missingSeed = seedCoverage();
const seedCounts = Object.entries(missingSeed.counts).map(([k, v]) => `${k}${v}`).join(' / ');

if (process.argv.includes('--check')) {
  let cur;
  try { cur = readFileSync(OUT, 'utf8'); }
  catch { console.log('MISSING  schema-auto.sql 不存在，请运行：node .workbuddy/gen-schema-auto.mjs'); process.exitCode = 1; process.exit(); }
  const a = cur.indexOf(BEGIN), b = cur.indexOf(END);
  const curDdl = a >= 0 && b > a ? cur.slice(cur.indexOf('\n', a) + 1, b) : '';
  const ddlOk = curDdl === ddl;
  if (ddlOk) {
    console.log(`PASS   DDL：schema-auto.sql 与 schema.sql 同步（${ddl.split('\n').length} 行，md5=${fingerprint(ddl)}）`);
  } else {
    console.log('DRIFT  DDL：schema-auto.sql 与 schema.sql 不一致 —— 重新生成：node .workbuddy/gen-schema-auto.mjs');
    console.log(`  当前 md5=${fingerprint(curDdl)}  期望 md5=${fingerprint(ddl)}`);
    process.exitCode = 1;
  }

  if (missingSeed.broken.length) {
    console.log('BROKEN 种子：校验自身失效，结果不可信 ——');
    for (const b2 of missingSeed.broken) console.log(`  · ${b2}`);
    process.exitCode = 1;
  } else if (missingSeed.missing.length === 0) {
    console.log(`PASS   种子：schema.sql 的初始数据在 seed-base.sql 中全部覆盖（提取到 ${seedCounts}）`);
  } else {
    console.log(`DRIFT  种子：seed-base.sql 缺 ${missingSeed.missing.length} 条 schema.sql 里已有的种子 ——`);
    for (const m of missingSeed.missing) console.log(`  · ${m.kind} ${m.value}`);
    console.log('  请把上述种子按「表空才灌」的形态补进 db/seed-base.sql（新环境靠它初始化）。');
    process.exitCode = 1;
  }
} else {
  writeFileSync(OUT, content, 'utf8');
  const tables = (ddl.match(/CREATE TABLE IF NOT EXISTS/g) || []).length;
  console.log(`已生成 schema-auto.sql`);
  console.log(`  建表语句 ${tables} 条（全部 IF NOT EXISTS）`);
  console.log(`  已剔除 DROP TABLE ${dropped.length} 条、CREATE DATABASE / USE 各 1 条`);
  console.log(`  DDL md5=${fingerprint(ddl)}  文件 ${content.length} 字符`);
  if (missingSeed.broken.length) console.log(`  ⚠️ 种子校验自身失效：${missingSeed.broken.join('；')}`);
  else if (missingSeed.missing.length) console.log(`  ⚠️ 种子缺口 ${missingSeed.missing.length} 条：${missingSeed.missing.map((m) => m.kind + ':' + m.value).join(', ')}`);
  else console.log(`  种子覆盖：全部命中（提取到 ${seedCounts}）`);
}
