/**
 * ==================================================================
 * 判据红绿：`audit-deploy-gap.mjs` 的 L9 判据到底是不是活的？
 * ==================================================================
 *
 * 起因：L9 的判据上一版是**硬编码** `state: 'MISSING'`，永远不会变红 ——
 * 那不构成检查，只是一条注释。本轮把它改成「锚能力」的计算判据，
 * 就必须回答一个跟代码本身无关的问题：**这条判据会不会翻面？**
 * 一条永远输出同一个结论的判据，和没有判据是一样的。
 *
 * 与 `probe-p13-criterion.mjs` 同一套做法：
 *   G1 原样          → L9 应 = DONE
 *   红 把 AiQuotaGuard.java 临时移走 → L9 应 = MISSING，且**逐条点名**缺什么
 *   G2 还原（校验 md5 一致）→ L9 应 = DONE
 *
 * ★ 为什么选「移走闸门类」而不是改长上限的倍数 ★
 * 长度阈值改了不该让判据翻面 —— 判据问的是「有没有这道闸门」，
 * 「阈值是多少」由 yml 默认值 + 单测（会读 yml 核对）看守。分工不同，别混。
 * 移走闸门类则直接抽掉「能力 1」，是最干净的对照组。
 *
 * ★ 记账提醒 ★
 * 移走一个文件可能同时点亮/熄灭多条判据（判据之间有引用耦合）——
 * 本探针会把**总数变化**和**具体翻了哪几条**分开打印，
 * 「掉了 N 项」不等于「错了 N 个能力」。
 *
 * 退出码：0 = 红绿都成立 / 1 = 不符 / 2 = 探针自身失效
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const NODE = process.execPath;
const AUDIT = path.join(ROOT, '.workbuddy', 'audit-deploy-gap.mjs');
const GUARD = path.join(ROOT, 'campus-secondhand-backend', 'src', 'main', 'java', 'com', 'campus', 'market', 'security', 'AiQuotaGuard.java');
const GUARD_BAK = GUARD + '.l9bak';

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const log = (m) => console.log(m);

/** 跑一次盘点，解析出每项的 id/state/ev 与合计 */
function audit() {
    const r = spawnSync(NODE, [AUDIT], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const text = (r.stdout ?? '') + (r.stderr ?? '');
    const items = {};
    for (const line of text.split(/\r?\n/)) {
        // 形如：  ✅ L9     AI 无频控 / ...  | 闸门类=true 过闸/调模型=2/2 ...
        const m = line.match(/[✅❌❓]\s+(\S+)\s+(.*)/u);
        if (!m) continue;
        const id = m[1];
        const rest = m[2];
        const bar = rest.lastIndexOf('|');
        items[id] = {
            state: line.includes('✅') ? 'DONE' : line.includes('❌') ? 'MISSING' : 'UNKNOWN',
            name: (bar > 0 ? rest.slice(0, bar) : rest).trim(),
            ev: bar > 0 ? rest.slice(bar + 1).trim() : ''
        };
    }
    const total = text.match(/合计\s*(\d+)\s*项：已完成\s*(\d+)，未完成\s*(\d+)/);
    return {
        items,
        done: total ? Number(total[2]) : null,
        missing: total ? Number(total[3]) : null,
        raw: text
    };
}

const ids = (snap) => Object.keys(snap.items);
const stateOf = (snap, id) => snap.items[id]?.state ?? '(未列出)';

log('=== 判据红绿：audit-deploy-gap.mjs 的 L9 ===');
if (!fs.existsSync(GUARD)) {
    log(`[FATAL] 找不到 ${GUARD}`);
    process.exit(2);
}
const guardMd5 = md5(GUARD);
log(`  闸门类 ${GUARD}`);
log(`  原文件 md5 ${guardMd5}`);

let bad = 0;
let moved = false;

try {
    /* ---- G1 原样 ---- */
    log('\n---------- G1：原样 ----------');
    const g1 = audit();
    log(`  L9 = ${stateOf(g1, 'L9')}`);
    log(`       ev: ${g1.items.L9?.ev ?? '-'}`);
    log(`  合计 已完成 ${g1.done} / 未完成 ${g1.missing}`);
    if (stateOf(g1, 'L9') !== 'DONE') {
        log('  [FATAL] 原样下 L9 就不是 DONE ⇒ 判据或实现对不上，先查这里，红绿无从谈起。');
        bad = 1;
    }
    const baselineDone = g1.done;

    /* ---- 红：移走闸门类 ---- */
    log('\n---------- 红：临时移走 AiQuotaGuard.java ----------');
    fs.renameSync(GUARD, GUARD_BAK);
    moved = true;
    const g2 = audit();
    log(`  L9 = ${stateOf(g2, 'L9')}`);
    log(`       ev: ${g2.items.L9?.ev ?? '-'}`);
    log(`  合计 已完成 ${g2.done} / 未完成 ${g2.missing}`);
    if (stateOf(g2, 'L9') !== 'MISSING') {
        log('  [FATAL] 移走闸门类之后 L9 仍是 DONE ⇒ 这条判据没有判别力，等于没写。');
        bad = 1;
    } else {
        log('  ✓ 判据翻面了');
    }
    // ★ 引用耦合记账：把「总数变化」和「具体翻了哪几条」分开报
    // （注意 ids() 收的是**整个快照**，别把 snap.items 又传进去 —— 第一版就这么错的，报了个 TypeError）
    const flipped = ids(g2).filter((id) => stateOf(g1, id) !== stateOf(g2, id));
    log(`  具体翻面的判据（${flipped.length} 条）：${flipped.map((id) => id + ':'
        + stateOf(g1, id) + '→' + stateOf(g2, id)).join('  ') || '（无）'}`);
    log(`  ★ 记账提示：合计掉了 ${baselineDone - g2.done} 项 ≠ 错了 ${baselineDone - g2.done} 个能力`
        + '（判据之间有引用耦合，一个文件可能同时点亮多条判据）');

    /* ---- G2 还原 ---- */
    log('\n---------- G2：还原 ----------');
    fs.renameSync(GUARD_BAK, GUARD);
    moved = false;
    log(`  还原后 md5 ${md5(GUARD)}`);
    if (md5(GUARD) !== guardMd5) {
        log(`  [FATAL] 还原后 md5 与原文件不一致！原 ${guardMd5}`);
        bad = 1;
    } else {
        log('  ✓ 与原文件逐字节一致');
    }
    const g3 = audit();
    log(`  L9 = ${stateOf(g3, 'L9')}   合计 已完成 ${g3.done} / 未完成 ${g3.missing}`);
    if (stateOf(g3, 'L9') !== 'DONE' || g3.done !== baselineDone) {
        log('  [FATAL] 还原后没有回到原状态。');
        bad = 1;
    } else {
        log('  ✓ 回到 G1 的状态');
    }
} finally {
    if (moved && fs.existsSync(GUARD_BAK)) {
        fs.renameSync(GUARD_BAK, GUARD);
        log(`\n  （异常退出，已强制还原；md5 ${md5(GUARD)}）`);
    }
}

log('\n========== 结论 ==========');
log(bad === 0
    ? '  ⇒ L9 判据是活的：能力在则 DONE、抽掉能力则 MISSING 并逐条点名缺什么、还原后复绿。'
    : '  ⇒ 有不符项，见上文。');
process.exit(bad === 0 ? 0 : 1);
