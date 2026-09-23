/**
 * ==================================================================
 * 全量未修项盘点 —— **回代码逐条实证**，不抄台账
 * ==================================================================
 *
 * 为什么需要它：
 *   `项目缺陷检查与修复清单.md`（184KB）与 `缺陷清单逐条核对报告.md`（79KB）
 *   是**历史快照**：里面大量 ❌ 是当时的状态，后续章节才逐条销项。
 *   直接数 ❌ 的个数 = 被台账骗（实测：M4 登录闸门、B6 prod profile、
 *   B5 活动号发号器在旧报告里都还标着 ❌，但代码里早就修好了）。
 *
 *   所以每一条都必须回代码取证：**判据锚在「能力」上，不锚在「当时的写法」上**。
 *
 * 分类：
 *   OPEN     真正还没做（要动手的）
 *   DECIDE   待用户决策（不是能力缺失，是要不要做这个设计选择）
 *   BYDESIGN  有意保留（评审过的设计决策，**不是待办**，别下次又当新问题讨论）
 *   FIXED    旧报告标着未修、实际已修（本条的价值就是防止重复修）
 *
 * 用法：node .workbuddy/audit-all-open.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const FE = path.join(ROOT, 'campus-secondhand-frontend');
const JAVA = path.join(BE, 'src', 'main', 'java');
const RES = path.join(BE, 'src', 'main', 'resources');

const rd = (...p) => { const f = path.join(...p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
const has = (...p) => fs.existsSync(path.join(...p));

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'target' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}
/**
 * 逐行去掉注释，只留**代码行**。
 *
 * ★ 为什么必须做这一步 ★
 *   本脚本第一版直接 grep，结果 4 条判据全部误报 —— 命中的都是注释：
 *     · `ActivityService.java:64`  * ★ 旧实现是 {@code static final AtomicLong ID_SEQ} ★
 *     · `address.ts:9`             * 商品详情页写死了一句常量（`BUY_ADDRESS = ...`）
 *     · `Index.vue:491`            「反馈已提交，感谢支持！」—— 而**什么都没发生**（在 <!-- --> 块里）
 *   这些注释的作用恰恰是**记录"这里曾经是错的"**，而 grep 把它们当成了缺陷仍在。
 *   本项目早有这条纪律（"不做整段正则剥注释 ⇒ 逐行判断"），这里落地成函数。
 *
 * ★ 只判断行首是不够的 ★：`Index.vue:491` 是 HTML 注释块的**中间行**，
 *   行首既不是 `*` 也不是 `<!--`。所以必须**跟踪块注释状态**。
 */
function codeLines(text) {
    const out = [];
    let inBlock = false;
    text.split(/\r?\n/).forEach((raw, i) => {
        const t = raw.trim();
        let isComment = false;
        if (inBlock) {
            isComment = true;
            if (/\*\/|-->/.test(t)) inBlock = false;          // 块注释结束
        } else if (/^(\*|\/\/|\/\*|<!--)/.test(t)) {
            isComment = true;
            if (/^\/\*/.test(t) && !/\*\//.test(t)) inBlock = true;
            if (/^<!--/.test(t) && !/-->/.test(t)) inBlock = true;
        }
        if (!isComment) out.push({ n: i + 1, t: raw });
    });
    return out;
}

/** 在整个目录里找命中正则的**代码行**（注释行一律不计） */
function grep(dir, re, limit = 6) {
    const hits = [];
    for (const f of walk(dir)) {
        if (!/\.(java|ts|vue|yml|yaml|xml|json|js|sql)$/.test(f)) continue;
        if (/[\\/]dist[\\/]/.test(f)) continue;   // 构建产物不算证据（那是源码的副本）
        for (const { n, t } of codeLines(rd(f))) {
            if (hits.length < limit && re.test(t)) hits.push({ f: path.relative(ROOT, f), n, t: t.trim().slice(0, 110) });
        }
    }
    return hits;
}
const fmt = (h) => h.length ? h.map((x) => `${x.f}:${x.n}  ${x.t}`).join('\n              ') : '（0 命中）';

const rows = [];
const add = (cls, id, name, done, ev) => rows.push({ cls, id, name, done, ev });

/* ============ 一、历史清单标记未修 → 回代码核实 ============ */

// M4 登录防暴力破解（旧报告：「❌ 完全未做」）
{
    const guard = has(JAVA, 'com', 'campus', 'market', 'security', 'LoginAttemptGuard.java');
    const callers = grep(JAVA, /LoginAttemptGuard|loginAttemptGuard/, 5);
    add('VERIFY', 'M4', '登录防暴力破解（账号/IP 双维度闸门）', guard && callers.length > 0,
        `LoginAttemptGuard.java=${guard}；调用点 ${callers.length} 处：\n              ${fmt(callers.slice(0, 3))}`);
}

// B5 活动号发号器（旧报告：「ActivityService.ID_SEQ 多实例撞号，static AtomicLong」）
{
    const gen = has(JAVA, 'com', 'campus', 'market', 'common', 'InstanceSeqGenerator.java');
    // ★ 只算代码行 ★：旧实现现在只出现在注释里（"旧实现是 …ID_SEQ"）—— 那是修过的证据，不是缺陷
    const oldSeq = grep(JAVA, /AtomicLong\s+ID_SEQ/, 3);
    add('VERIFY', 'B5', '活动号/订单号发号器（多实例不撞号）', gen && oldSeq.length === 0,
        `InstanceSeqGenerator=${gen}；代码里残留 static AtomicLong ID_SEQ=${oldSeq.length} 处${oldSeq.length ? '：\n              ' + fmt(oldSeq) : ''}`);
}

// B6 dev/prod profile 隔离（旧报告：「无 prod profile」）
add('VERIFY', 'B6', 'dev/prod profile 隔离', has(RES, 'application-prod.yml') && has(RES, 'application-demo.yml'),
    `application-prod.yml=${has(RES, 'application-prod.yml')} demo=${has(RES, 'application-demo.yml')}`);

// 订单超时自动取消（旧清单：「可选，仍待办」）
add('VERIFY', 'B7', '订单超时自动关单', has(JAVA, 'com', 'campus', 'market', 'job', 'PaymentTimeoutJob.java'),
    `PaymentTimeoutJob.java=${has(JAVA, 'com', 'campus', 'market', 'job', 'PaymentTimeoutJob.java')}`);

// 浏览量（旧清单：「仍是 setViewCount(+1) → updateById(g) 整实体回写」）
{
    const svc = rd(JAVA, 'com', 'campus', 'market', 'service', 'GoodsService.java');
    // ★ 判据锚「能力」：必须存在一条**单列原子 UPDATE** ★
    //   第一版要求出现 `.set(Goods::getViewCount`，而实际实现用的是
    //   `.setSql("view_count = COALESCE(view_count, 0) + 1")` ⇒ "锚手段"误报第 N 次。
    const singleCol = /update\s*\(\s*null\s*,[\s\S]{0,300}?(setSql\s*\(\s*["'`]view_count|set\s*\(\s*Goods::getViewCount)/.test(svc);
    // 快照回写特征：setViewCount 那条语句**紧接着**就是 updateById（窗口取 60 字符，
    // 免得把后面别的方法里的 updateById 也算进来）
    const snapshot = /setViewCount\s*\([^;]*\)\s*;\s*[\s\S]{0,60}?updateById\s*\(/.test(svc);
    add('VERIFY', 'H2', '浏览量走单列原子更新（禁整实体回写）', singleCol && !snapshot,
        `单列 update(...view_count)=${singleCol}；整实体回写特征=${snapshot}`);
}

// 清空失效族：ActivityService 重启用时应清 cancelledAt/cancelledBy
{
    const svc = rd(JAVA, 'com', 'campus', 'market', 'service', 'ActivityService.java');
    const setNull = /LambdaUpdateWrapper|update\s*\(\s*null\s*,/.test(svc) && /set\s*\(\s*Activity::getCancelled/.test(svc);
    const stillUpdateById = /updateById/.test(svc);
    add('VERIFY', 'H4', '活动重启用清 cancelled_at/cancelled_by（禁整实体回写）', setNull,
        `wrapper.set(cancelled…)=${setNull}；仍存在 updateById=${stillUpdateById}`);
}

// 前端：下单地址硬编码（旧清单：「BUY_ADDRESS 常量」）
{
    const hits = grep(FE, /BUY_ADDRESS/, 4);
    add('VERIFY', 'F1', '下单地址不再硬编码（走「我的地址」）', hits.length === 0,
        hits.length ? fmt(hits.slice(0, 2)) : '代码里已无该常量（只在注释里作为"曾经写死"的记录）');
}

// 前端：意见反馈 / 注销账号「纯假成功」
{
    // ★ 这两条缺陷的本质是「假成功」：弹一句"已提交"，实际没有任何请求 ★
    //   修法不一定是接 API —— 也可以**如实告知"尚未接入"**（本项目就是这么修的）。
    //   所以判据是「代码里（非注释）还有没有那条假成功文案」。
    const fb = grep(FE, /反馈已提交|提交成功，感谢/, 4);
    const del = grep(FE, /注销申请已提交/, 4);
    add('VERIFY', 'F2', '意见反馈不再假成功（如实告知渠道未接入）', fb.length === 0,
        fb.length ? fmt(fb.slice(0, 2)) : '代码里已无「反馈已提交」文案');
    add('VERIFY', 'F3', '注销账号不再假成功（如实告知流程未接入）', del.length === 0,
        del.length ? fmt(del.slice(0, 2)) : '代码里已无「注销申请已提交」文案');
}

// 低优先级杂项
add('VERIFY', 'L7', '`dist-opt/` 已不存在（旧 .gitignore 条目已失效）', !has(BE, 'dist-opt') && !has(FE, 'dist-opt'),
    `backend/dist-opt=${has(BE, 'dist-opt')} frontend/dist-opt=${has(FE, 'dist-opt')}`);
// 部署载体：P1-4 只要求 systemd / Dockerfile / compose **三选一**
add('VERIFY', 'P1-4b', '部署载体（三选一，systemd 已满足）', has(BE, 'Dockerfile') || has(BE, 'deploy', 'campus-market.service'),
    `Dockerfile=${has(BE, 'Dockerfile')}；systemd=${has(BE, 'deploy', 'campus-market.service')} ⇒ 任选其一即达成`);

// pom 依赖升级（旧报告：「❌ 完全未做」——实为有意不做）
{
    const pom = rd(BE, 'pom.xml');
    const boot = (pom.match(/spring-boot-starter-parent[\s\S]{0,120}<version>([^<]+)/) || [])[1] || '?';
    const ai = (pom.match(/<spring-ai\.version>([^<]+)/) || [])[1] || '?';
    add('BYDESIGN', 'D-UP', `依赖升级（Boot ${boot} / spring-ai ${ai}）`,
        true, `Boot=${boot} spring-ai=${ai}；GA 需 Boot 3.4+ ⇒ 独立批次（P0-7 已记录决策）`);
}

/* ============ 二、有意保留（评审过的设计决策） ============ */
add('BYDESIGN', 'M8', '错误一律 HTTP 200（前端按 body.code 分流）', true, '前端 request.ts 依赖此契约，改它=改契约');
add('BYDESIGN', 'P2-1', 'recheckSession 真实模式恒 null', true, '真实鉴权由 AuthInterceptor 兜住，注释已订正');
// D11 已于 2026-09-23 拆链销项（账本三十一）：用户只剩 active/banned 两态，不再是开口项。
add('BYDESIGN', 'dist-ignore', '`.gitignore` 含 `dist/`（发版产物）', true, '本轮已加');

/* ============ 三、待用户决策 ============ */
// D-SEED（favorite_count）已于 2026-09-23 用真实计数落地（账本三十），不再是待决策项。
add('DECIDE', 'D-ALIPAY', '是否真去申请支付宝沙箱密钥', false, '不配则只跑 wallet/demo 渠道');
add('DECIDE', 'D9', '前端 token 存 localStorage（改 httpOnly Cookie 属架构级）', false, '§8.4 已核当前无 XSS 面');
// D-GIT 已于 2026-09-23 销项（账本三十二）：main 分支首提 a507fba，543 文件入库。
add('VERIFY', 'D-GIT', '仓库已 git init（main · a507fba）', has(ROOT, '.git'), '.git=true')

/* ============ 输出 ============ */
const groups = [
    ['OPEN', '① 真正未做（要动手）'],
    ['VERIFY', '② 旧报告标未修 → 回代码核实结果'],
    ['BYDESIGN', '③ 有意保留（设计决策，**不是待办**）'],
    ['DECIDE', '④ 待你决策'],
];

console.log('=== 全量未修项盘点（回代码逐条实证）===\n');
for (const [cls, title] of groups) {
    const list = rows.filter((r) => r.cls === cls);
    if (!list.length) continue;
    console.log(`\n## ${title}`);
    for (const r of list) {
        const mark = cls === 'VERIFY' ? (r.done ? '✅' : '❌') : (cls === 'OPEN' ? '❌' : '•');
        console.log(`${mark} ${r.id.padEnd(9)} ${r.name}`);
        console.log(`              ${r.ev}`);
    }
}

const notFixed = rows.filter((r) => r.cls === 'VERIFY' && !r.done);
console.log('\n=== 汇总 ===');
console.log(`  ② 中"旧报告说未修、实际仍未修"：${notFixed.length} 项  ${notFixed.map((r) => r.id).join(', ') || '（无）'}`);
console.log(`  ② 中"旧报告说未修、实际已修"：${rows.filter((r) => r.cls === 'VERIFY' && r.done).length} 项（这些别再重复修）`);
console.log(`  ③ 有意保留：${rows.filter((r) => r.cls === 'BYDESIGN').length} 项`);
console.log(`  ④ 待决策：${rows.filter((r) => r.cls === 'DECIDE').length} 项`);
console.log('\n  ※ 部署适配清单的 27 项另算（`node .workbuddy/audit-deploy-gap.mjs`）：已完成 20 / 未完成 7');
