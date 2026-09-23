/**
 * 红绿探针：发版脚本里的「产物自检」到底有没有判别力。
 *
 * 背景：build-release.mjs 会检查产物里有没有 demo 资源，有就拒绝产出发布件。
 * 但如果这段断言写坏了（比如条件写反、或永远为真），它照样会打印成功，
 * 而我们**什么都不会察觉** —— 最后就是一个带着 demo 脚本的包被发到生产，
 * 而"带上 demo profile 会清空商品与订单"是本项目最危险的一条。
 *
 * 所以这里把 `-Pprod` 摘掉（= 打包时不再排除 demo 资源），
 * 断言脚本**必须**以退出码 2 失败、且失败原因指名是 demo 资源。
 *
 * 三重自证：锚点恰好命中 1 次 / RED 必须真的失败且退出码为 2 / 还原后 md5 逐字节一致。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILE = 'campus-secondhand-backend/deploy/build-release.mjs';
const ANCHOR = "const args = ['-Pprod'];";
const BROKEN = "const args = [];";

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const orig = fs.readFileSync(FILE, 'utf8');
const origHash = md5(orig);

const hits = orig.split(ANCHOR).length - 1;
if (hits !== 1) {
    console.error(`[FATAL] 锚点命中 ${hits} 次（期望 1）⇒ 拒绝给出结论`);
    process.exit(2);
}

function run(label) {
    const r = spawnSync('node', ['deploy/build-release.mjs', '--offline'], {
        cwd: 'campus-secondhand-backend',
        encoding: 'utf8',
        env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-17' },
        maxBuffer: 64 * 1024 * 1024
    });
    const out = (r.stdout || '') + (r.status === 0 ? (r.stderr || '') : '');
    const selfCheckLine = out.split(/\r?\n/).find((l) => /demo 资源（必须 0）/.test(l))?.trim() ?? '(没走到自检)';
    const rejected = /产物自检未通过/.test(out) || /仍有 demo 资源/.test(out);
    console.log(`[${label}] exit=${r.status}  ${selfCheckLine}`);
    return { code: r.status, out, rejected };
}

// ---- GREEN：带 -Pprod，必须成功 ----
const green = run('GREEN');
if (green.code !== 0) {
    console.error('[FATAL] 基线（带 -Pprod）都没成功，先查环境，不往下做');
    console.error(green.out.slice(-3000));
    process.exit(2);
}

// ---- RED：摘掉 -Pprod，自检必须拦住 ----
fs.writeFileSync(FILE, orig.replace(ANCHOR, BROKEN), 'utf8');
const red = run('RED');
fs.writeFileSync(FILE, orig, 'utf8');
const restoredOk = md5(fs.readFileSync(FILE, 'utf8')) === origHash;

const restored = run('GREEN(恢复后)');

console.log('\n=== 判定 ===');
console.log(`GREEN  退出码 ${green.code}（期望 0）`);
console.log(`RED    退出码 ${red.code}（期望 2）  自检拦住了 = ${red.rejected}`);
console.log(`还原   字节一致 = ${restoredOk}`);
console.log(`复绿   退出码 ${restored.code}（期望 0）`);

const ok = green.code === 0
    && red.code === 2 && red.rejected
    && restoredOk
    && restored.code === 0;
console.log(ok ? '\n✅ 产物自检有判别力（摘掉 -Pprod 会被拦下，且指名 demo 资源）'
    : '\n❌ 判定失败：自检没有拦住问题产物，或恢复不完整');
process.exit(ok ? 0 : 1);
