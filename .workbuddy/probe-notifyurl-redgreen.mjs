/**
 * 红绿探针：notify_url 缺渠道名这一处修复，用例是否真有判别力。
 *
 * 三重自证（缺一不可）：
 *  1. 锚点必须恰好命中 1 次（0 或 >1 ⇒ 退出码 2，绝不伪装成"没找到就算了"）；
 *  2. RED 阶段必须有真实失败（Tests run 里 Failures/Errors > 0），"0 个用例"算失败；
 *  3. 还原必须字节一致（md5 比对），否则退出码 2。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILE = 'campus-secondhand-backend/src/main/java/com/campus/market/config/PayProperties.java';
const ANCHOR = 'return base + path + "/" + channel;';
const BROKEN = 'return base + path;';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const orig = fs.readFileSync(FILE, 'utf8');
const origHash = md5(orig);

const hits = orig.split(ANCHOR).length - 1;
if (hits !== 1) {
    console.error(`[FATAL] 锚点命中 ${hits} 次（期望 1）⇒ 拒绝给出结论`);
    process.exit(2);
}

function run(label) {
    const r = spawnSync(
        '"D:/apache-maven-3.9.4/bin/mvn.cmd"',
        ['-o', '-s', '.workbuddy/mvn-aliyun-settings.xml',
            '-f', 'campus-secondhand-backend/pom.xml', 'test',
            '-Dtest=AlipaySandboxNotifyTest', '-DfailIfNoSpecifiedTests=false'],
        { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(?![\s\S]*Tests run)/)
        || out.match(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)?.pop()
            ?.match(/(\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/);
    const all = [...out.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)];
    const last = all[all.length - 1];
    if (!last) {
        console.error(`[FATAL] ${label}: 没解析到 Tests run 汇总行（可能是构建基础设施问题）`);
        process.exit(2);
    }
    const [, total, fail, err] = last;
    console.log(`[${label}] Tests run: ${total}, Failures: ${fail}, Errors: ${err}`);
    return { total: +total, bad: +fail + +err, out };
}

// ---- GREEN（当前已修复态）----
const green = run('GREEN');
if (green.total === 0 || green.bad > 0) {
    console.error('[FATAL] 基线就没绿，不往下做');
    process.exit(2);
}

// ---- RED（退回缺陷态）----
fs.writeFileSync(FILE, orig.replace(ANCHOR, BROKEN), 'utf8');
const red = run('RED');

// ---- 还原 + 字节校验 ----
fs.writeFileSync(FILE, orig, 'utf8');
const restored = md5(fs.readFileSync(FILE, 'utf8'));
const restoredOk = restored === origHash;

const restoredRun = run('GREEN(恢复后)');

console.log('\n=== 判定 ===');
console.log(`GREEN  ${green.total} 用例 / 失败 ${green.bad}`);
console.log(`RED    ${red.total} 用例 / 失败 ${red.bad}  ← 必须 > 0`);
console.log(`还原   字节一致 = ${restoredOk}`);
console.log(`复绿   ${restoredRun.total} 用例 / 失败 ${restoredRun.bad}`);

// 报红时要点名是哪条用例红的，证明红的是我们新加的那条
const namedRed = /notifyUrlEndsWithChannelCode|必须以渠道名结尾/.test(red.out);
console.log(`红的是新加那条 = ${namedRed}`);

const ok = red.bad > 0 && restoredOk && restoredRun.bad === 0;
console.log(ok ? '\n✅ 红→绿成立，用例有判别力' : '\n❌ 判定失败');
process.exit(ok ? 0 : 1);
