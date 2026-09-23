/**
 * P1-10 判据红绿：证明 `audit-deploy-gap.mjs` 里 P1-10 这条判据**有判别力**。
 *
 * 为什么单独做这一轮（而不是跑步数单测就完事）：
 *   判据本身也会撒谎。上一版 P1-10 查的是 `魔数|限流|RateLimit` 这些**字样**，
 *   于是「只在注释里写『已加魔数校验』」就能骗它 ✅ —— 一条永远绿的判据不是检查，是注释。
 *   所以每改一次判据，都必须把「能力拿掉」再跑判据，看它**必须变红**。
 *
 * 每轮都同时点名：目标项必须 MISSING；**其它项不许被误伤**
 *   （判据之间有引用耦合，本仓踩过「移走一个文件让两条判据同时变红」）。
 * 还原逐字节（md5），崩溃也还原。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const CTL = path.join(BE, 'src/main/java/com/campus/market/controller/UploadController.java');
const GUARD = path.join(BE, 'src/main/java/com/campus/market/security/UploadQuotaGuard.java');
const YML = path.join(BE, 'src/main/resources/application.yml');

const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');

/** 跑审计脚本，取 P1-10 的状态与总数 */
function audit() {
    const r = spawnSync(process.execPath, ['.workbuddy/audit-deploy-gap.mjs'], { cwd: ROOT, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const line = out.split(/\r?\n/).find((l) => /P1-10/.test(l)) || '';
    const state = /✅/.test(line) ? 'DONE' : /❌/.test(line) ? 'MISSING' : 'UNKNOWN';
    const ev = (line.split('|')[1] || '').trim();
    const total = (out.match(/合计\s*(\d+)\s*项：已完成\s*(\d+)，未完成\s*(\d+)/) || []).slice(1).map(Number);
    return { state, ev, line: line.trim(), done: total[1] ?? -1, all: total[0] ?? -1 };
}

let problems = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); problems++; };

const FILES = [CTL, GUARD, YML];
const backups = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const originals = Object.fromEntries(FILES.map((f) => [f, md5(f)]));

const restoreAll = () => {
    for (const f of FILES) fs.writeFileSync(f, backups[f], 'utf8');
};
process.on('uncaughtException', (e) => {
    restoreAll();
    console.error('\n探针崩溃（源码已还原）:', e && e.message);
    process.exit(2);
});
process.on('exit', () => { for (const f of FILES) fs.writeFileSync(f, backups[f], 'utf8'); });

const rounds = [
    { id: 'C0', title: '不改代码 ⇒ 判据必须 ✅（先确认基线不是红的）', mut: [] },
    {
        id: 'CC', title: '【对照组】只在注释里塞「魔数」「限流」字样 ⇒ 判据必须**仍然** ✅',
        mut: [{
            file: CTL,
            from: '    @PostMapping("/upload/image")',
            to: '    // 对照组：本接口已加魔数嗅探与限流（上一版判据会被这行字骗成 ✅）\n    @PostMapping("/upload/image")',
        }],
    },
    {
        id: 'C1', title: '魔数嗅探作废（不调 sniff，永远当 PNG）⇒ 必须 ❌',
        mut: [{ file: CTL, from: '        ImageType type = sniff(file);', to: '        ImageType type = ImageType.PNG;' }],
    },
    {
        id: 'C2', title: '接口里不再调用闸门 ⇒ 必须 ❌（「类写好了但没接上」这一类）',
        mut: [{ file: CTL, from: '        uploadQuotaGuard.acquire(currentUserId(request));\n\n', to: '' }],
    },
    {
        id: 'C3',
        title: '★ 闸门挪到魔数之后 ⇒ 必须 ❌（只查「有没有调用」的判据查不出这一条）',
        mut: [
            { file: CTL, from: '        uploadQuotaGuard.acquire(currentUserId(request));\n\n        if (file == null || file.isEmpty()) {',
              to: '        if (file == null || file.isEmpty()) {' },
            { file: CTL, from: '        ImageType type = sniff(file);',
              to: '        ImageType type = sniff(file);\n        uploadQuotaGuard.acquire(currentUserId(request));' },
        ],
    },
    {
        id: 'C4', title: '落盘扩展名不再取自字节（写死 "png"）⇒ 必须 ❌',
        mut: [{ file: CTL, from: '        String ext = type.ext();', to: '        String ext = "png";' }],
    },
    {
        id: 'C5', title: '把上传闸门的配置从占位符改成裸数字（失去环境变量覆盖能力）⇒ 必须 ❌',
        mut: [{ file: YML, from: '    user-max-uploads: ${UPLOAD_GUARD_USER_MAX_UPLOADS:10}', to: '    user-max-uploads: 10' }],
    },
    {
        id: 'C6', title: '把闸门类的窗口推进删掉（类还在、名还在、就是不会重置）⇒ 必须 ❌',
        mut: [{ file: GUARD, from: '        if (now - w.windowStartMs >= windowMs) {\n            w.windowStartMs = now;\n            w.count = 0;\n        }',
                to: '        if (false) {\n            w.windowStartMs = now;\n            w.count = 0;\n        }' }],
    },
];

console.log('=== P1-10 判据红绿（audit-deploy-gap.mjs）===');
const baseline = audit();
console.log(`基线：${baseline.line}`);
console.log(`基线合计：${baseline.done}/${baseline.all} 通过\n`);

for (const r of rounds) {
    console.log(`—— ${r.id}：${r.title}`);
    for (const f of FILES) {
        if (md5(f) !== originals[f]) { bad(`进入本轮前 ${path.basename(f)} 不是原始版本，拒绝继续`); process.exit(2); }
    }
    try {
        for (const m of r.mut) {
            const txt = fs.readFileSync(m.file, 'utf8');
            const n = txt.split(m.from).length - 1;
            if (n !== 1) throw new Error(`锚点命中 ${n} 次（要求 1 次）：${m.from.slice(0, 50)}…`);
            fs.writeFileSync(m.file, txt.replace(m.from, m.to), 'utf8');
        }
    } catch (e) {
        bad(`突变锚点失效：${e.message}`);
        restoreAll();
        process.exit(2);
    }

    const a = audit();
    const expect = r.id === 'C0' || r.id === 'CC' ? 'DONE' : 'MISSING';
    console.log(`   判据：${a.line}`);
    if (a.state !== expect) {
        bad(`期望 ${expect}，实得 ${a.state} ⇒ 这条判据${expect === 'MISSING' ? '没有判别力（能力拿掉仍报 ✅）' : '误报红'}`);
    } else {
        ok(`P1-10 = ${a.state}（符合预期）`);
    }
    // 「其它项不被误伤」：除了目标项，通过数最多只能少 1（就是目标项自己）
    const delta = baseline.done - a.done;
    if (expect === 'DONE' && delta !== 0) {
        bad(`对照组不该影响任何项的通过数，实得少了 ${delta} 项`);
    } else if (expect === 'MISSING' && delta !== 1) {
        bad(`期望只有 P1-10 变红（通过数 -1），实得 -${delta} 项 ⇒ 有其它判据被误伤或引用耦合`);
    } else {
        ok(`其它项未被误伤（通过数 ${baseline.done} → ${a.done}）`);
    }
    if (r.id === 'CC') {
        ok(`对照组证明：注释里的「魔数/限流」字样骗不过新判据（旧判据会被骗）`);
    }

    restoreAll();
    ok('源码/配置已逐字节还原（md5 一致）\n');
}

console.log('—— C9-收尾：全部还原后重跑，必须回到基线');
{
    const a = audit();
    if (a.state !== baseline.state || a.done !== baseline.done) {
        bad(`还原后未回到基线：${a.line}`);
    } else {
        ok(`回到基线：P1-10 = ${a.state}，合计 ${a.done}/${a.all}`);
    }
}

console.log(problems === 0 ? '\n结果：全部轮次成立（0 处异常）' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
