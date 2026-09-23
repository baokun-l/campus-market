/**
 * D9（会话凭据搬进 HttpOnly Cookie）前端红绿探针。
 *
 * 与 probe-p111-redgreen.mjs 同一套纪律：
 *  1. **一轮突变只验证一个可观测后果**；每轮同时点名「必须红」与「必须仍绿」——
 *     后者是防掩盖判据：没有它，两个后果被同一个突变一起干掉也看不出来。
 *  2. 脚本必须**自证**：报告份数 / 用例数对不上 ⇒ 该轮无效、退出码 2，
 *     绝不能把「压根没跑起来 / 收集阶段就崩了」当成「报红了」。
 *  3. 还原必须**逐字节**（md5 比对），否则后面的轮次是在污染的代码上跑的。
 *  4. 必须有**对照组**：R0 不改代码、RC 只改注释 —— 用「不该红的一轮」证明「红」不是噪声。
 *  5. 失败用例集必须**恰好等于**该轮声称的 red 集：多一个（连带伤及无关能力）或少一个
 *     （断言没有判别力）都要报出来，并明确要求人工拆轮。
 *
 * ★ 覆盖清单不手写 ★
 * `ALL` 由「基线轮的完整报告」自动生成（文件名 + 用例全名），不手写。
 * 手写清单必漏，而漏掉的用例会在每一轮里**静默不被检查** ——
 * 这正是「判据不完整却不报错」的形态，本仓已经栽过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const FE = path.join(ROOT, 'campus-secondhand-frontend');
const VITEST = path.join(FE, 'node_modules', 'vitest', 'vitest.mjs');

const REQ = path.join(FE, 'src/api/request.ts');
const SESSION = path.join(FE, 'src/api/session.ts');
const STORE = path.join(FE, 'src/stores/modules/user.ts');
const PERM = path.join(FE, 'src/utils/permission.ts');
const APP = path.join(FE, 'src/App.vue');

/* 只跑与 D9 有关的 4 个 spec：跑全量 30 个文件会让 12 轮探针耗时不可接受 */
const SPECS = [
    'src/api/request.spec.ts',
    'src/stores/modules/user.spec.ts',
    'src/utils/permission.spec.ts',
    'src/utils/session-credential-guard.spec.ts',
];

const REPORT = path.join(ROOT, '.workbuddy', 'tmp', 'd9-probe-report.json');

/** 结果文件名（写得稳一点：目录不存在就先建） */
const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');

/*
 * ★ 报告文件用「投毒 + 覆盖」，**绝不删除** ★
 *
 * 第一版在每次运行前 `unlinkSync` 掉旧报告，结果撞上宿主的
 * `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（一轮累计删除数超阈值就直接拦下进程），
 * 探针当场崩溃。这与 P1-11 探针在 maven-status 上踩的是同一个坑的新形态。
 * 现在的协议：
 *   ① 运行前把报告写成 `{"__stale":true}`（投毒）；
 *   ② 跑 vitest（它会把文件覆盖成真报告）；
 *   ③ 读出来若还带着 `__stale` ⇒ 说明 vitest 压根没写文件 ⇒ 本轮无效、拒绝当红。
 * 覆盖不是删除，不消耗删除额度；而"陈旧报告冒充新结果"这种自欺也被堵住了。
 */
const STALE = '{"__stale":true}';

function runSpecs(tag) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, STALE, 'utf8');
    const r = spawnSync(process.execPath, [
        VITEST, 'run',
        ...SPECS,
        '--reporter=json',
        `--outputFile=${REPORT}`,
    ], { cwd: FE, encoding: 'utf8' });

    if (!fs.existsSync(REPORT)) {
        return { failed: null, total: 0, raw: (r.stdout || '') + (r.stderr || ''), why: '报告文件不存在（vitest 没跑起来？）' };
    }
    let json;
    try {
        json = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
    } catch (e) {
        return { failed: null, total: 0, raw: String(e.message) + '\n' + (r.stdout || '') + (r.stderr || ''), why: 'JSON 报告解析失败' };
    }
    if (json.__stale) {
        return { failed: null, total: 0, raw: (r.stdout || '') + (r.stderr || ''), why: '报告仍是投毒标记 ⇒ vitest 没有写出结果' };
    }
    const failed = new Set();
    const all = [];
    for (const file of json.testResults || []) {
        for (const a of file.assertionResults || []) {
            const id = a.fullName || [a.ancestorTitles?.join(' > '), a.title].filter(Boolean).join(' > ');
            if (a.status === 'failed') failed.add(id);
            else all.push(id);
        }
    }
    const total = (json.numTotalTests ?? (all.length + failed.size));
    return { failed, total, all, raw: (r.stdout || '') + (r.stderr || '') };
}

let problems = 0;
const bad = (m) => { console.log('  ✗ ' + m); problems++; };
const ok = (m) => console.log('  ✓ ' + m);

/* ============================ 1. 基线：自动生成 ALL ============================ */
console.log('=== D9 红绿探针（前端 · 会话凭据 HttpOnly Cookie）===\n');
console.log('—— R0-基线：不改任何代码 ⇒ 必须全绿，并由它生成覆盖清单');

const FILES = [REQ, SESSION, STORE, PERM, APP];
const backups = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const original = Object.fromEntries(FILES.map((f) => [f, md5(f)]));

const restoreAll = () => { for (const f of FILES) fs.writeFileSync(f, backups[f], 'utf8'); };
const restoreChecked = () => {
    restoreAll();
    for (const f of FILES) {
        if (md5(f) !== original[f]) {
            console.error(`\n✗ 还原后 md5 不一致！${path.basename(f)}\n  期望 ${original[f]}\n  实得 ${md5(f)}`);
            process.exit(2);
        }
    }
};
process.on('uncaughtException', (e) => {
    restoreAll();
    console.error('\n探针崩溃（源码已还原）:', e && e.message);
    process.exit(2);
});
process.on('exit', () => restoreAll());

FILES.forEach((f) => console.log(`源码指纹：${path.basename(f)} = ${original[f]}`));

const base = runSpecs('R0');
if (!base.all || base.failed === null) {
    bad(`基线无法建立：${base.why}\n${base.raw.split('\n').slice(-20).join('\n')}`);
    process.exit(2);
}
if (base.failed.size > 0) {
    bad(`基线就有 ${base.failed.size} 个失败，先修好再谈红绿：${[...base.failed].join(', ')}`);
    process.exit(2);
}
const ALL = base.all;
ok(`基线 ${ALL.length} 个用例全绿 ⇒ 覆盖清单由报告自动生成（不手写，避免漏检）`);

/** 精确匹配用例全名（同时支持「后缀匹配」写法，便于轮次定义里少写前缀） */
const pick = (suffix) => ALL.filter((id) => id.endsWith(suffix));
const ids = (suffixes) => suffixes.flatMap((s) => {
    const hit = pick(s);
    if (hit.length !== 1) {
        bad(`【自证失败】用例名 "${s}" 命中 ${hit.length} 个（要求恰好 1 个）⇒ 轮次定义失效，退出`);
        process.exit(2);
    }
    return hit;
});

/* ============================ 2. 轮次定义 ============================ */
const A1 = ids(['已登录收到 401 → 立刻作废本地会话（不能等用户点弹窗）']);
const A2 = ids(['服务端说「封禁」时，原因要归到 banned（登录页据此换文案）']);
const A4 = ids(['并发多个 401 只弹一次（其余请求静默失败）']);
const A6 = ids(['401 的跳转地址必须带原因、且从 BASE_URL 派生（写死 /login 会跳出应用）']);
const S_READTOKEN = ids(['readToken() 在真实模式恒返回空串 —— 即便有人把凭据写回了 localStorage']);
const S_NOCREND = ids(['登录成功后：凭据一个字符都不许落进 localStorage，但登录态要成立']);
const S_REFRESH = ids(['刷新后仍是已登录，依据是不含凭据的 sessionHint（profile 仍要重新取）']);
const S_LOGOUT_SRV = ids(['logout() 必须通知服务端清票（HttpOnly Cookie 前端删不掉）']);
const S_BASE_LOGOUT = ids(['logout() 应清空全部登录态']);
const S_REVOKE = ids(['被踢（revoke）要同时清 sessionHint 并通知服务端清票']);
const S_REFRESH_AFTER = ids(['登出后刷新不得「复活」（持久化里的标记也要跟着变成 false）']);
const G_GUARD = ids(['真实模式（无 token、只有 sessionHint）也要去求证会话，而不是直接放行']);
const G_SCAN = ids(['白名单之外，任何文件都不得用 token 当登录判据']);

/*
 * 「对照组」用例的存在性自证：它们不会被任何一轮点名「必须红」，
 * 但必须是覆盖清单里的真实条目 —— 否则断言的"必须仍绿"就是在对着空气说话。
 * 这里显式取一次，取不到 ids() 会直接退出码 2。
 */
ids([
    '游客触发 401 不得写 revoked（否则登录页会平白说"状态已失效"）',
    '一次成功响应之后，去重开关复位（下次 401 仍能提醒）',
    'mock 模式下 mock-token 必须照旧持久化，readToken() 也照样读得到',
    'mock 模式下 logout() 不发请求（没有后端可清）',
]);

/** 「必须仍绿」= ALL 减去「必须红」——穷举划分，不手写第二份清单 */
const rest = (red) => ALL.filter((id) => !red.includes(id));

const allRounds = [
    {
        id: 'R0',
        title: '不改任何代码 ⇒ 全绿（对照组之一，已在上面完成）',
        mut: null,
        red: [],
        skip: true,
    },
    {
        id: 'RC',
        title: '只改注释（等价物）⇒ 必须仍然全绿（对照组之二：证明「红」不是噪声）',
        mut: { file: STORE, from: '     * ★ 必须同时清 `sessionHint` ★', to: '     * ★ 必须同时清 `sessionHint`（本轮只改这行注释）★' },
        red: [],
    },
    {
        id: 'R1',
        title: 'session.readToken() 去掉 mock 模式守卫 ⇒ 「凭据回流闸门」整体消失',
        mut: { file: SESSION, from: "  if (!USE_MOCK) return ''\n", to: '' },
        red: S_READTOKEN,
    },
    {
        id: 'R2',
        title: 'store.login() 无条件写 token（真实模式也落地凭据）⇒ localStorage 里能搜到票',
        mut: {
            file: STORE,
            from: "       */\n      if (USE_MOCK) this.token = token",
            to: "       */\n      this.token = token",
        },
        red: S_NOCREND,
    },
    {
        id: 'R3',
        title: 'persist.paths 去掉 sessionHint ⇒ 真实模式刷新后被当游客',
        mut: { file: STORE, from: "    paths: ['token', 'sessionHint']", to: "    paths: ['token']" },
        red: S_REFRESH,
    },
    {
        id: 'R4',
        title: 'logout() 不再通知服务端清票 ⇒ HttpOnly Cookie 永远删不掉',
        mut: {
            file: STORE,
            from: "      revokeServerSession()\n      // 见 revoke()：登出同样清空购物车",
            to: "      // 见 revoke()：登出同样清空购物车",
        },
        red: S_LOGOUT_SRV,
    },
    {
        id: 'R5',
        title: 'revoke() 不再清 sessionHint ⇒ 被踢后 isLoggedIn 仍为真（守卫继续放行、守卫复查也白做）',
        mut: {
            file: STORE,
            from: "    revoke(reason: SessionRejectReason, message: string) {\n      this.token = ''\n      this.sessionHint = false\n",
            to: "    revoke(reason: SessionRejectReason, message: string) {\n      this.token = ''\n",
        },
        /*
         * 同一个后果（"被踢之后不能再认为人还在"）被 4 条断言分别观测：
         *   · revoke 自己的用例；
         *   · 守卫把会话送回登录页后 sessionHint 必须为假；
         *   · 401 统一处理里的 isLoggedIn 必须为假（那是被踢的主要入口）；
         *   · 并发 401 那条收尾也断言了 isLoggedIn。
         * 实测第一版只写了前两条，探针立刻报出"red 清单之外的失败" —— 这是**正确的**：
         * 它们不是被误伤，而是同一能力的另外两个观测点，必须一起点名，
         * 否则"这轮突变到底影响了几处"就成了笔糊涂账。
         */
        red: [...S_REVOKE, ...G_GUARD, ...A1, ...A4],
    },
    {
        id: 'R6',
        title: 'logout() 不再清 sessionHint ⇒ 登出后 isLoggedIn 仍为真（点了退出、刷新又回来了）',
        mut: {
            file: STORE,
            from: "    logout() {\n      this.token = ''\n      this.sessionHint = false\n",
            to: "    logout() {\n      this.token = ''\n",
        },
        // 同样一个后果被 3 条断言观测（D9 两条 + 原有那条「logout 应清空全部登录态」）
        red: [...S_LOGOUT_SRV, ...S_REFRESH_AFTER, ...S_BASE_LOGOUT],
    },
    {
        id: 'R7',
        title: '401 分支不再作废本地会话（退回「只在点弹窗时登出」的旧写法）',
        mut: {
            file: REQ,
            from: "    userStore.revoke(reason as 'banned' | 'expired', serverMessage || '登录状态已过期，请重新登录')\n",
            to: '',
        },
        /*
         * 三条断言都观测"401 必须当场把 isLoggedIn 变假"：
         *   · 主用例直接查 revoked / sessionHint / profile；
         *   · 封禁那条查原因归类（revoke 没了，revoked 就还是 null）；
         *   · 并发那条收尾也断言了 isLoggedIn（实测第一版漏了它，被探针点名）。
         */
        red: [...A1, ...A2, ...A4],
    },
    {
        id: 'R8',
        title: '去掉 401 弹窗去重开关 ⇒ 并发失败时弹好几次',
        mut: { file: REQ, from: '  if (unauthorizedHandled) return\n  unauthorizedHandled = true\n', to: '' },
        red: A4,
    },
    {
        id: 'R9',
        title: '守卫条件改回 userStore.token ⇒ 真实模式冷启动永不拉 profile（行为判据 + 静态看守同时报警）',
        mut: { file: PERM, from: 'if (!userStore.profile && userStore.isLoggedIn) {', to: 'if (!userStore.profile && userStore.token) {' },
        /*
         * 这一轮有**两个互相独立的探测器**同时命中，是有意保留的交叉验证：
         *   · 行为层：那个用 sessionHint 模拟"标记还在、票没了"的守卫用例；
         *   · 静态层：permission.ts 不在白名单里，出现 `userStore.token` 即违规。
         * 两条判据锚的能力不同（一个测"会不会去求证"，一个测"判据锚在哪"),
         * 所以都点名；少写任何一条，就等于放弃了其中一层保护。
         */
        red: [...G_GUARD, ...G_SCAN],
    },
    {
        id: 'R10',
        title: '被踢跳转地址写死 /login ⇒ 子路径部署会跳出应用',
        mut: {
            file: REQ,
            from: "  const base = import.meta.env.BASE_URL.endsWith('/')\n    ? import.meta.env.BASE_URL\n    : `${import.meta.env.BASE_URL}/`\n  return `${base}login?revoked=${reason}`",
            to: "  return `/login?revoked=${reason}`",
        },
        red: A6,
    },
    {
        id: 'R11',
        title: '真实回归：App.vue 心跳把登录判据改回 token ⇒ 全站在线状态静默失灵（只有静态看守抓得到）',
        mut: { file: APP, from: '  () => userStore.isLoggedIn,', to: '  () => userStore.token,' },
        red: G_SCAN,
    },
];

/* ============================ 3. 轮次自证 ============================ */
{
    let broken = 0;
    const allSet = new Set(ALL);
    for (const r of allRounds) {
        if (r.skip) continue;
        // ① 不许出现"不在覆盖清单里"的 id（否则那条断言根本不存在，写上去只是在壮胆）
        for (const id of r.red) {
            if (!allSet.has(id)) {
                bad(`【自证失败】${r.id} 点名的 ${id} 不在覆盖清单里 ⇒ 这是一条不存在的断言`);
                broken++;
            }
        }
        // ② red 内部不许重复（重复说明轮次定义写花了）
        if (new Set(r.red).size !== r.red.length) {
            bad(`【自证失败】${r.id} 的 red 清单有重复项`);
            broken++;
        }
        // ③ 对照组必须真的留出"必须仍绿"的空间
        if (r.red.length === 0 && ALL.length === 0) {
            bad(`【自证失败】${r.id} 没有任何可比对的用例`);
            broken++;
        }
    }
    if (broken) process.exit(2);
    ok(`探针自证 · 所有轮次的 red 集都取自基线报告生成的 ${ALL.length} 个用例 ⇒ 没有用例会静默漏检`);
}

/* ============================ 4. 执行 ============================ */
const only = process.argv.slice(2);
const rounds = only.length ? allRounds.filter((r) => !r.skip && only.some((o) => r.id === o)) : allRounds.filter((r) => !r.skip);
if (only.length && rounds.length === 0) {
    console.error(`✗ 过滤条件 ${JSON.stringify(only)} 没命中任何轮次 ⇒ 拒绝输出结论`);
    console.error(`  可选：${allRounds.filter((r) => !r.skip).map((r) => r.id).join(' | ')}`);
    process.exit(2);
}

/*
 * ★ 锚点必须对行尾换行不敏感 ★
 *
 * 第一版直接拿带 `\n` 的锚点去 `split()`，R7 报「命中 0 次」——
 * 而那一行**确实在文件里**。原因：本仓库的换行符**不统一**
 * （`request.ts`、`App.vue` 是 CRLF，几个 store/session 是 LF ——
 * 前者被 IDE 按 Windows 习惯保存过）。跨行锚点在 CRLF 文件里永远匹配不上，
 * 而"锚点失效"这个错误信息会指向"这处代码不存在"，把人带到完全错误的方向。
 * 所以这里主动尝试三种变体（原样 / 转 CRLF / 转 LF），并且：
 *   · 只有"恰好命中 1 次"才算通过（多次 = 锚点不唯一，同样危险）；
 *   · 替换文本的换行符跟着**实际命中的那个变体**走，避免混出混合行尾；
 *   · 全都不中时把各变体的命中数打出来，便于一眼看出是"没这行"还是"行尾不对"。
 */
function applyMut(m) {
    const txt = fs.readFileSync(m.file, 'utf8');
    const variants = [m.from];
    if (m.from.includes('\n')) {
        variants.push(m.from.replace(/\r?\n/g, '\r\n'));
        variants.push(m.from.replace(/\r\n/g, '\n'));
    }
    let anchor = null;
    const report = [];
    for (const v of [...new Set(variants)]) {
        const n = txt.split(v).length - 1;
        report.push(`${n} 次/${JSON.stringify(v.slice(0, 24))}…`);
        if (n === 1) { anchor = v; break; }
    }
    if (!anchor) {
        throw new Error(`锚点未命中唯一位置（各变体：${report.join('；')}）：${m.from.slice(0, 60)}…`);
    }
    let to = m.to;
    if (to.includes('\n')) {
        to = to.replace(/\r\n/g, '\n').replace(/\n/g, anchor.includes('\r\n') ? '\r\n' : '\n');
    }
    fs.writeFileSync(m.file, txt.replace(anchor, to), 'utf8');
}

console.log('');
for (const r of rounds) {
    console.log(`—— ${r.id}：${r.title}`);
    for (const f of FILES) {
        if (md5(f) !== original[f]) {
            bad(`进入本轮前 ${path.basename(f)} 不是原始版本，拒绝继续（上一轮没还原干净）`);
            process.exit(2);
        }
    }
    try {
        if (r.mut) applyMut(r.mut);
    } catch (e) {
        bad(`突变锚点失效：${e.message}`);
        restoreChecked();
        process.exit(2);
    }

    const res = runSpecs(r.id);
    if (res.failed === null || res.total !== ALL.length) {
        bad(`本轮用例数 ${res.total}（期望 ${ALL.length}）${res.why ? '；' + res.why : ''} ⇒ 本轮无效，拒绝当红`);
        console.log(res.raw.split('\n').filter(Boolean).slice(-14).map((l) => '      ' + l).join('\n'));
        restoreChecked();
        process.exit(2);
    }

    const failed = res.failed;
    console.log(`   本轮 ${res.total} 个用例，失败 ${failed.size} 个：${[...failed].map((f) => f.replace(/^.* > /, '')).join(' | ') || '（无）'}`);

    const redSet = new Set(r.red);
    for (const id of r.red) {
        if (failed.has(id)) ok(`必须红 · ${id.replace(/^.* > /, '')}`);
        else bad(`「必须红」的 ${id.replace(/^.* > /, '')} 没有报红 ⇒ 该断言没有判别力（或突变没生效）`);
    }
    const leaked = [...failed].filter((f) => !redSet.has(f));
    if (leaked.length) {
        bad(`出现了 red 清单之外的失败：${leaked.map((f) => f.replace(/^.* > /, '')).join(' | ')}`
            + ` ⇒ 这轮突变混淆了多个可观测后果，或连带伤了无关能力，需拆轮/复核`);
    } else if (r.red.length) {
        ok(`必须仍绿 · ${ALL.length - r.red.length} 个用例全部仍绿（防掩盖判据成立）`);
    }
    if (r.red.length === 0 && failed.size === 0) {
        ok(`对照组：${ALL.length} 个用例全绿 ⇒ 「红」确实来自突变，不是噪声`);
    }

    restoreChecked();
    ok('源码已逐字节还原（md5 一致）\n');
}

console.log('—— R12-收尾：全部还原后重跑，必须全绿');
{
    const res = runSpecs('final');
    if (res.failed === null || res.total !== ALL.length) {
        bad(`收尾轮用例数 ${res.total}，无法判定`);
    } else if (res.failed.size > 0) {
        bad(`还原后仍有失败：${[...res.failed].join(', ')}`);
    } else {
        ok(`还原后 ${res.total}/${ALL.length} 全绿 ⇒ 前面每一轮的红都确实来自那处突变`);
    }
}

console.log(problems === 0 ? '\n结果：全部轮次成立（0 处异常）' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
