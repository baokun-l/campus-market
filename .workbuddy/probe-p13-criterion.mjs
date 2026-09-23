/**
 * 红绿：验证 P1-3 的新判据**真的有判别力**
 *
 * 背景：旧判据只看 pom 里有没有 buildInfo，把「已落地但换了实现手段」误报成 MISSING
 * （脚本撒谎第八形态）。新判据改成检查 deploy/build-release.mjs 里的三项能力。
 * 但"新判据现在报 DONE"本身不能证明它可信 —— 一个永远返回 DONE 的判据也报 DONE。
 *
 * 所以三轮：
 *   G1  原样跑             ⇒ 期望 P1-3 = DONE
 *   RED 把 build-release.mjs 临时改名 ⇒ 期望 P1-3 = MISSING（能力不在 ⇒ 必须报缺）
 *   G2  改回原样再跑       ⇒ 期望再次 DONE，且**文件字节与最初一致**（还原要自证）
 *
 * 退出码 0 = 红绿成立 / 1 = 判据无判别力 / 2 = 探针自身失效
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const TARGET = path.join(BE, 'deploy', 'build-release.mjs');
const STASH = path.join(ROOT, '.workbuddy', 'tmp', 'build-release.mjs.stash');

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

function runAudit() {
    const r = spawnSync(process.execPath, ['.workbuddy/audit-deploy-gap.mjs'], {
        cwd: ROOT, encoding: 'utf8', shell: false
    });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === null) return { line: '(脚本没跑起来)', total: null };
    const line = out.split(/\r?\n/).find((l) => /\bP1-3\b/.test(l)) || '(未找到 P1-3 行)';
    const tot = out.match(/合计\s*\d+\s*项：已完成\s*(\d+)，未完成\s*(\d+)/);
    return {
        line: line.trim().replace(/\s+/g, ' '),
        done: /✅/.test(line),
        total: tot ? `${tot[1]}/${Number(tot[1]) + Number(tot[2])}` : null
    };
}

if (!fs.existsSync(TARGET)) { console.error('[FATAL] 找不到 build-release.mjs，无法进行'); process.exit(2); }
const before = md5(TARGET);
console.log(`[准备] build-release.mjs md5=${before}`);

console.log('\n--- G1 原样 ---');
const g1 = runAudit();
console.log('  ' + g1.line);
console.log('  合计 ' + g1.total);

console.log('\n--- RED 临时移走 build-release.mjs ---');
fs.renameSync(TARGET, STASH);
const red = runAudit();
console.log('  ' + red.line);
fs.renameSync(STASH, TARGET);
console.log('  （已改回）');

console.log('\n--- G2 还原后 ---');
const g2 = runAudit();
console.log('  ' + g2.line);
console.log('  合计 ' + g2.total);
const after = md5(TARGET);
console.log(`[还原自证] md5=${after} ${after === before ? '✓ 与最初一致' : '✗ 文件被改动过！'}`);

console.log('\n=== 判定 ===');
if (!g1.done || !g2.done) {
    console.log('✗ 原样/还原后都没报 DONE —— 要么判据写错了，要么环境不对，探针无法下结论。');
    process.exit(2);
}
if (red.done) {
    console.log('✗ RED 轮仍然报 DONE —— 判据没有判别力（能力被移走它还是绿的）。');
    process.exit(1);
}
if (after !== before) {
    console.log('✗ 还原后文件字节不一致，红绿的前提被破坏。');
    process.exit(2);
}
console.log('✓ 红绿成立：能力在 ⇒ DONE，能力被移走 ⇒ MISSING，还原字节一致。');
console.log(`  合计 ${g1.total} → ${red.total} → ${g2.total}。`);
console.log('  注：RED 轮掉了 ' + (Number(g1.total.split('/')[0]) - Number(red.total.split('/')[0])) +
    ' 项而不是 1 项 —— 因为 P0-7 的证据里同样引用了 build-release.mjs（判据之间存在引用耦合）。');
console.log('  这不影响结论，但记账时要知道："移走一个文件"可能同时点亮/熄灭多个判据。');
process.exit(0);
