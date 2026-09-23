/**
 * D9 判据红绿：证明 `.workbuddy/audit-deploy-gap.mjs` 里那条 D9 判据**真的有判别力**。
 *
 * 为什么要有这一支：
 * 本仓库的审计脚本已经**撒谎过四次**（三次假红、一次假绿），共同病根都是
 * 「判据锚在手段/字样/我以为的写法上」。所以"判据写完"不算完 ——
 * 必须证明它**会红**：把每一项声称的能力一个一个拿掉，看它是否当场报 MISSING、
 * 并且**能点名是哪一格缺了**。只有恒真的判据才会永远显示 ✅。
 *
 * 与前端红绿探针（probe-d9-redgreen.mjs）的分工：
 *   · 那一支证明**行为**（代码真的按预期工作）；
 *   · 这一支证明**判据**（审计脚本真的能看出代码没按预期工作）。
 * 两层都不可省：光有行为测试，判据可能恒真（那就等于没有盘点）；
 * 光有判据红绿，行为则完全没被验证过。
 *
 * 每条突变只拿掉**一个**能力，并要求：
 *   ① D9 由 ✅ 变 ❌；
 *   ② 报出的证据串里**恰好那一格**变 false（说明字段粒度是准的，不是连坐）；
 *   ③ 其余 ≥20 项仍 ✅（防掩盖：若一改就全崩，说明判据之间在互相污染）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const AUDIT = path.join(ROOT, '.workbuddy', 'audit-deploy-gap.mjs');
const FE = path.join(ROOT, 'campus-secondhand-frontend');
const BE = path.join(ROOT, 'campus-secondhand-backend');

const COOKIE = path.join(BE, 'src/main/java/com/campus/market/security/AuthCookie.java');
const CTL = path.join(BE, 'src/main/java/com/campus/market/controller/UserController.java');
const ITC = path.join(BE, 'src/main/java/com/campus/market/interceptor/AuthInterceptor.java');
const SESSION = path.join(FE, 'src/api/session.ts');
const STORE = path.join(FE, 'src/stores/modules/user.ts');

const FILES = [COOKIE, CTL, ITC, SESSION, STORE];
const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');
const backups = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const original = Object.fromEntries(FILES.map((f) => [f, md5(f)]));

const restoreAll = () => { for (const f of FILES) fs.writeFileSync(f, backups[f], 'utf8'); };
process.on('uncaughtException', (e) => { restoreAll(); console.error('\n探针崩溃（源码已还原）:', e && e.message); process.exit(2); });
process.on('exit', () => restoreAll());

let problems = 0;
const bad = (m) => { console.log('  ✗ ' + m); problems++; };
const ok = (m) => console.log('  ✓ ' + m);

/** 跑一次审计，返回 { d9: bool, line: string, doneCount: number, missing: string[] } */
function runAudit() {
    const r = spawnSync(process.execPath, [AUDIT], { cwd: ROOT, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const line = out.split('\n').find((l) => /^\S*\s*D9\s/.test(l) || /\bD9\b.*HttpOnly/.test(l)) || '';
    return {
        d9: /✅\s*D9/.test(line),
        line: line.trim(),
        doneCount: (out.match(/^✅/gm) || []).length,
        total: (out.match(/合计\s*(\d+)\s*项/) || [])[1],
    };
}

/** 跨行锚点必须对 CRLF/LF 两种行尾都生效（本仓换行符不统一，实测踩过） */
function applyMut(m) {
    const txt = fs.readFileSync(m.file, 'utf8');
    const variants = [m.from];
    if (m.from.includes('\n')) {
        variants.push(m.from.replace(/\r?\n/g, '\r\n'));
        variants.push(m.from.replace(/\r\n/g, '\n'));
    }
    let anchor = null;
    for (const v of [...new Set(variants)]) {
        if (txt.split(v).length - 1 === 1) { anchor = v; break; }
    }
    if (!anchor) throw new Error(`锚点未命中唯一位置：${m.from.slice(0, 60)}…`);
    let to = m.to;
    if (to.includes('\n')) to = to.replace(/\r\n/g, '\n').replace(/\n/g, anchor.includes('\r\n') ? '\r\n' : '\n');
    fs.writeFileSync(m.file, txt.replace(anchor, to), 'utf8');
}

const rounds = [
    { id: 'C0', title: '不改代码 ⇒ D9 必须是 ✅（基准）', mut: null, cell: 'HttpOnly=true' },
    {
        id: 'C1', title: '把**下发**那一支的 HttpOnly 改掉 ⇒ 报「HttpOnly=false」（XSS 一读即走，本项毫无意义）',
        /*
         * ★ 锚点必须落在"下发"那一支 ★
         * `AuthCookie` 里 `httpOnly(true)` 出现两次（下发 + 清票），第一版拿
         * `httpOnly(true)` 当锚点，报的是"未命中唯一位置"—— 而更值得记的是：
         * 那时审计判据本身也只 grep 到任一处就通过，所以"改坏下发"根本不会被发现。
         * 两边（判据与探针）都在这一轮里被一起修好了。
         */
        mut: { file: COOKIE, from: 'ResponseCookie.from(NAME, token)\n                .httpOnly(true)', to: 'ResponseCookie.from(NAME, token)\n                .httpOnly(false)' }, cell: 'HttpOnly=false',
    },
    {
        id: 'C2', title: '登出端点不再清 Cookie ⇒ 报「登出端点=false」',
        mut: { file: CTL, from: '        AuthCookie.clear(response, request.isSecure());\n', to: '' }, cell: '登出端点=false',
    },
    {
        id: 'C3', title: '拦截器不再先读 Cookie ⇒ 报「Cookie优先=false」',
        mut: { file: ITC, from: '        String token = AuthCookie.read(request);\n', to: '' }, cell: 'Cookie优先=false',
    },
    {
        id: 'C4', title: 'readToken 的 mock 守卫删掉 ⇒ 报「读票闸门=false」',
        mut: { file: SESSION, from: "  if (!USE_MOCK) return ''\n", to: '' }, cell: '读票闸门=false',
    },
    {
        id: 'C5', title: '登出不再通知服务端清票 ⇒ 报「登出清票=false」',
        mut: { file: STORE, from: "      revokeServerSession()\n      // 见 revoke()：登出同样清空购物车", to: "      // 见 revoke()：登出同样清空购物车" }, cell: '登出清票=false',
    },
    {
        id: 'C6', title: '真实模式不再持久化 sessionHint ⇒ 报「只持久化hint=false」',
        mut: { file: STORE, from: "    paths: ['token', 'sessionHint']", to: "    paths: ['token']" }, cell: '只持久化hint=false',
    },
    {
        id: 'C7', title: '反面对照：只改注释（等价物）⇒ 必须仍 ✅',
        mut: { file: STORE, from: '     * ★ 必须同时清 `sessionHint` ★', to: '     * ★ 必须同时清 `sessionHint`（本轮只改这行注释）★' }, cell: 'HttpOnly=true',
    },
];

console.log('=== D9 判据红绿（审计脚本到底看不看得出来）===');
FILES.forEach((f) => console.log(`源码指纹：${path.basename(f)} = ${original[f]}`));
console.log('');

for (const r of rounds) {
    console.log(`—— ${r.id}：${r.title}`);
    for (const f of FILES) {
        if (md5(f) !== original[f]) { bad(`进入本轮前 ${path.basename(f)} 不是原始版本，拒绝继续`); process.exit(2); }
    }
    try { if (r.mut) applyMut(r.mut); } catch (e) { bad(`突变锚点失效：${e.message}`); restoreAll(); process.exit(2); }

    const res = runAudit();
    if (!res.line) { bad('审计输出里找不到 D9 行 ⇒ 本轮无效'); restoreAll(); process.exit(2); }
    const expectDone = r.id === 'C0' || r.id === 'C7';
    if (expectDone ? res.d9 : !res.d9) {
        ok(`D9 = ${res.d9 ? '✅' : '❌'}（符合预期）`);
    } else {
        bad(`D9 = ${res.d9 ? '✅' : '❌'}，与预期相反 ⇒ ${expectDone ? '判据报假红' : '判据恒真、根本没判别力'}`);
    }
    if (!res.line.includes(r.cell)) {
        bad(`证据串里没出现「${r.cell}」⇒ 判据的字段粒度不对（或锚错了格子）。实得：${res.line}`);
    } else if (r.id !== 'C0') {
        ok(`证据串精确点名「${r.cell}」`);
    }
    if (res.doneCount < 20) {
        bad(`本轮只有 ${res.doneCount} 项 ✅（要求 ≥20）⇒ 判据之间在互相污染，红不是单点造成的`);
    } else {
        ok(`其余 ${res.doneCount}/27 项仍 ✅（防掩盖判据成立）`);
    }

    restoreAll();
    for (const f of FILES) {
        if (md5(f) !== original[f]) { console.error(`\n✗ 还原后 md5 不一致！${path.basename(f)}`); process.exit(2); }
    }
    ok('源码已逐字节还原（md5 一致）\n');
}

console.log('—— C8-收尾：全部还原后重跑，D9 必须回到 ✅');
{
    const res = runAudit();
    if (res.d9) ok(`还原后 D9 = ✅，且共 ${res.doneCount}/27 项 ✅ ⇒ 前面的红都确实来自那处突变`);
    else bad(`还原后 D9 仍是 ❌ ⇒ 有突变没还原干净，或判据本身依赖了别的东西`);
}

console.log(problems === 0 ? '\n结果：判据红绿全部成立（0 处异常）' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
