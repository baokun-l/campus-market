/**
 * P1-11（鉴权快照缓存）红绿探针。
 *
 * 纪律（逐条对应本仓踩过的坑，与 probe-p110-redgreen.mjs 同一套）：
 *  1. 一轮突变只验证**一个可观测后果**；每轮同时点名「必须红」与「必须仍绿」
 *     —— 后者是**防掩盖判据**：没有它，两个后果被同一个突变一起干掉也看不出来。
 *  2. 脚本必须**自证**：报告份数 / 用例数对不上 ⇒ 该轮无效、退出码 2，
 *     绝不能把「编译不过 / 压根没跑」当成「报红了」。
 *  3. 还原必须**逐字节**（md5 比对），否则后面的轮次是在污染的代码上跑的。
 *  4. 必须有**对照组**：R0 不改代码、RC 只改注释、R6 反向加失效
 *     —— 用「不该红的一轮」证明「红」不是噪声。
 *
 * 本轮的覆盖清单是**穷举**的：ALL 里 23 个用例，每一轮都必须正好划分成
 * 「必须红」+「必须仍绿」两组，一个不漏。少写一个 id 就会让那一轮静默放过它 ——
 * 这正是「判据不完整却不报错」的形态，所以在收尾处加了划分完整性自证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const CACHE = path.join(BE, 'src/main/java/com/campus/market/security/AuthSnapshotCache.java');
const INT = path.join(BE, 'src/main/java/com/campus/market/interceptor/AuthInterceptor.java');
const USVC = path.join(BE, 'src/main/java/com/campus/market/service/UserService.java');
const CSVC = path.join(BE, 'src/main/java/com/campus/market/service/ContentService.java');
const GTEST = path.join(BE, 'src/test/java/com/campus/market/service/AuthCacheInvalidationTest.java');

/*
 * 报告目录：不删、不换目录，只认「本轮开始之后写出的报告」（mtime 下界）。
 * 理由见 probe-p110-redgreen.mjs 的详尽注释（删目录会撞宿主「一次删除 >50 文件」护栏；
 * -Dsurefire.reportsDirectory 没绑 user property、被静默吞掉）。
 */
const REPORTS = path.join(BE, 'target', 'surefire-reports');
const TESTS = 'AuthSnapshotCacheTest,AuthCacheInvalidationTest,AuthInterceptorSnapshotTest';
const EXPECTED_TESTS = 26; // 10 + 7 + 9（B8 加 4 个 cookie 用例 +4；D11 拆除删 approve 用例 -1，账本三十一）
const EXPECTED_REPORTS = 3;

const A = 'AuthSnapshotCacheTest#';
const B = 'AuthCacheInvalidationTest#';
const C = 'AuthInterceptorSnapshotTest#';

const ALL = [
    A + 'sameUserIsLoadedOnceWithinTtl',
    A + 'expiredEntryFallsBackToDatabase',
    A + 'notExpiredEntryIsNotReloaded',
    A + 'invalidateForcesReloadOnTheVeryNextRead',
    A + 'invalidateAllCoversEveryGivenUser',
    A + 'missingUserIsCachedAsEmpty',
    A + 'nullUserIdDoesNotTouchDatabase',
    A + 'nullTokenVersionCountsAsZero',
    A + 'ttlStaysInSecondRange',
    A + 'snapshotCarriesOnlyAuthColumns',
    B + 'banIsVisibleOnTheVeryNextAuthRead',
    B + 'batchBanIsVisibleOnTheVeryNextAuthRead',
    // B + 'approveIsVisibleOnTheVeryNextAuthRead', —— 已随 D11 拆除删除（账本三十一）
    B + 'resetPasswordRevokesOnTheVeryNextAuthRead',
    B + 'changePasswordRevokesOnTheVeryNextAuthRead',
    B + 'heartbeatDoesNotFlushTheAuthCache',
    B + 'everyAuthColumnWriteInvalidates',
    B + 'guardHasDiscriminatingPower',
    C + 'twoRequestsShareOneSnapshot',
    C + 'bannedSnapshotIsRejected',
    C + 'staleTokenVersionIsRejected',
    C + 'roleZoneStillEnforced',
    C + 'unknownAccountIsRejected',
    // —— B8 批新增的 D9 cookie 用例（必须仍绿，纳入穷举划分）——
    C + 'cookieOnlyRequestAuthenticates',
    C + 'noCredentialIsRejected',
    C + 'cookieTakesPriorityOverHeader',
    C + 'cookieTicketIsSubjectToTheSameRevocationChecks',
];

/** 「必须仍绿」= ALL 减去「必须红」——穷举划分，不手写第二份清单（手写必漏） */
const rest = (red) => ALL.filter((id) => !red.includes(id));

const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');

function collectFreshReports(startMs) {
    const failed = new Set();
    let reportCount = 0;
    let totalTests = 0;
    if (!fs.existsSync(REPORTS)) return { failed, reportCount, totalTests };
    for (const f of fs.readdirSync(REPORTS)) {
        if (!f.startsWith('TEST-') || !f.endsWith('.xml')) continue;
        const full = path.join(REPORTS, f);
        if (fs.statSync(full).mtimeMs < startMs) continue; // 陈旧报告在这里被剔除
        reportCount++;
        const xml = fs.readFileSync(full, 'utf8');
        totalTests += Number((xml.match(/<testsuite[^>]*\btests="(\d+)"/) || [])[1] || 0);
        const re = /<testcase\s+([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            if (!/<(failure|error)[\s>]/.test(m[3] || '')) continue;
            const name = (m[1].match(/name="([^"]+)"/) || [])[1];
            const cls = (m[1].match(/classname="([^"]+)"/) || [])[1] || '';
            failed.add(`${cls.split('.').pop()}#${name}`);
        }
    }
    return { failed, reportCount, totalTests };
}

function runTests(tag) {
    const startMs = Date.now();
    const r = spawnSync(process.execPath, [
        '.workbuddy/run-mvn.mjs',
        `-Dtest=${TESTS}`,
        '-DfailIfNoSpecifiedTests=false',
    ], {
        cwd: ROOT,
        env: { ...process.env, MVN_LOG: `mvn-p111-${tag}.log` },
        encoding: 'utf8',
    });
    return { stdout: (r.stdout || '') + (r.stderr || ''), ...collectFreshReports(startMs) };
}

let problems = 0;
const bad = (m) => { console.log('  ✗ ' + m); problems++; };
const ok = (m) => console.log('  ✓ ' + m);

/* ============================ 轮次定义 ============================ */

const R1_RED = [
    A + 'sameUserIsLoadedOnceWithinTtl',
    A + 'notExpiredEntryIsNotReloaded',
    A + 'missingUserIsCachedAsEmpty',
    B + 'heartbeatDoesNotFlushTheAuthCache',
    C + 'twoRequestsShareOneSnapshot',
];

const R2_RED = [A + 'expiredEntryFallsBackToDatabase'];

const R3_RED = [B + 'banIsVisibleOnTheVeryNextAuthRead', B + 'everyAuthColumnWriteInvalidates'];

const R4_RED = [B + 'everyAuthColumnWriteInvalidates'];

const R5_RED = [B + 'guardHasDiscriminatingPower'];

const R6_RED = [B + 'heartbeatDoesNotFlushTheAuthCache'];

const allRounds = [
    {
        id: 'R0-基线',
        title: '不改任何代码 ⇒ 全绿（对照组之一）',
        mut: null,
        red: [],
        green: ALL,
    },
    {
        id: 'RC-等价改注释',
        title: '只改注释（等价物）⇒ 必须仍然全绿（对照组之二：证明「红」不是噪声）',
        mut: {
            file: INT,
            from: '         * ★ 以数据库为准，不信 Token 里的快照 ★',
            to: '         * ★ 以数据库为准，不信 Token 里的快照（本轮只改这行注释）★',
        },
        red: [],
        green: ALL,
    },
    {
        id: 'R1-缓存旁路',
        title: '让 get() 直接回源、不再命中 ⇒ 「少查库」这个能力整体消失',
        mut: {
            file: CACHE,
            from: '        return cache.get(userId, this::load);',
            to: '        return load(userId); // 突变：旁路缓存',
        },
        red: R1_RED,
        green: rest(R1_RED),
    },
    {
        id: 'R2-去掉TTL',
        title: '删掉 expireAfterWrite（永不过期）⇒ 只有「TTL 到点回源」这一条观测后果该红',
        mut: {
            file: CACHE,
            from: '                .expireAfterWrite(Duration.ofSeconds(ttlSeconds))\n',
            to: '',
        },
        red: R2_RED,
        green: rest(R2_RED),
    },
    {
        id: 'R3-漏单个封禁的失效',
        title: '删掉 UserService.toggleUserStatus 里的失效 ⇒ 封禁退化成「慢 TTL 生效」',
        mut: {
            file: USVC,
            from: '        authSnapshotCache.invalidate(id);\n        addAuditLog(banned ? "user.ban" : "user.unban",',
            to: '        addAuditLog(banned ? "user.ban" : "user.unban",',
        },
        red: R3_RED,
        green: rest(R3_RED),
    },
    {
        id: 'R4-只删ContentService的失效',
        title: '只删第二个封禁入口的失效 ⇒ **行为用例抓不到**，只有源码看守能抓',
        mut: {
            file: CSVC,
            from: '                        authSnapshotCache.invalidate(userId);\n',
            to: '',
        },
        red: R4_RED,
        green: rest(R4_RED),
    },
    {
        id: 'R5-看守自身失效',
        title: '把看守的匹配串改空 ⇒ 看守自己会变成恒真，必须由它自己的对照组抓出来',
        mut: {
            file: GTEST,
            from: '    private static final String INVALIDATE_CALL = "authSnapshotCache.invalidate";',
            to: '    private static final String INVALIDATE_CALL = "";',
        },
        red: R5_RED,
        green: rest(R5_RED),
    },
    {
        id: 'R6-心跳也清缓存',
        title: '反向对照：把失效做成「任何 t_user 写都清」（给 heartbeat 也加上失效）⇒ 必须被对照组抓住',
        mut: {
            file: USVC,
            from: '                .set(User::getLastActiveAt, LocalDateTime.now()));',
            to: '                .set(User::getLastActiveAt, LocalDateTime.now()));\n'
                + '        authSnapshotCache.invalidate(userId); // 突变：心跳也清缓存',
        },
        red: R6_RED,
        green: rest(R6_RED),
    },
];

/* ============================ 执行 ============================ */

const FILES = [CACHE, INT, USVC, CSVC, GTEST];
const original = Object.fromEntries(FILES.map((f) => [f, md5(f)]));
const backups = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));

const restoreAll = () => {
    for (const f of FILES) {
        fs.writeFileSync(f, backups[f], 'utf8');
    }
};
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

const only = process.argv.slice(2);
const rounds = only.length ? allRounds.filter((r) => only.some((o) => r.id.startsWith(o))) : allRounds;
if (only.length && rounds.length === 0) {
    console.error(`✗ 过滤条件 ${JSON.stringify(only)} 没命中任何轮次 ⇒ 拒绝输出结论`);
    console.error(`  可选：${allRounds.map((r) => r.id).join(' | ')}`);
    process.exit(2);
}

console.log('=== P1-11 红绿探针（鉴权快照缓存）===');
FILES.forEach((f) => console.log(`源码指纹：${path.basename(f)} = ${original[f]}`));
console.log('');

/* ★ 划分完整性自证：每一轮的 red+green 必须正好等于 ALL，且无交集 ★ */
{
    let broken = 0;
    for (const r of allRounds) {
        const union = new Set([...r.red, ...r.green]);
        if (union.size !== ALL.length || r.red.some((x) => r.green.includes(x))) {
            bad(`【自证失败】${r.id} 的红/绿清单没有穷举 ${ALL.length} 个用例（并集 ${union.size} 个）`);
            broken++;
        }
    }
    if (broken) process.exit(2);
    ok(`探针自证 · 每一轮的红/绿清单都穷举了全部 ${ALL.length} 个用例 ⇒ 没有用例会静默漏检`);
}

/* ★ 过滤条件自证：mtime 下界必须真的有判别力★ */
{
    const future = collectFreshReports(Date.now() + 10 * 60 * 1000);
    if (future.reportCount !== 0 || future.totalTests !== 0) {
        bad(`【自证失败】把下界推到 10 分钟后仍认了 ${future.reportCount} 份 / ${future.totalTests} 个用例`
            + ` ⇒ mtime 过滤没有判别力，「本轮无红」的结论全部作废`);
        process.exit(2);
    }
    ok('探针自证 · 错误下界（未来时刻）下报告数为 0 ⇒ mtime 过滤确实在起作用\n');
}

const applyMut = (m) => {
    const txt = fs.readFileSync(m.file, 'utf8');
    const n = txt.split(m.from).length - 1;
    if (n !== 1) {
        throw new Error(`锚点命中 ${n} 次（要求恰好 1 次）：${m.from.slice(0, 70)}…`);
    }
    fs.writeFileSync(m.file, txt.replace(m.from, m.to), 'utf8');
};

/*
 * ★ 这个基元必须同时吃数组与 Set ★
 * 第一版写成 list.includes(id)，而失败集是 Set ⇒ 第一轮刚验证完就抛
 * "list.includes is not a function"。危害不是崩溃本身（崩溃会还原源码），
 * 而是**它会伪装成「本轮结论已产出」**：R1 那 5 个红明明完全命中预期，
 * 却因为收尾时的一次类型错误，整轮判定作废。
 */
const hit = (coll, id) => (coll instanceof Set ? coll.has(id) : coll.includes(id));

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

    const res = runTests(r.id.split('-')[0]);
    if (res.reportCount < EXPECTED_REPORTS || res.totalTests !== EXPECTED_TESTS) {
        const mvnExit = (res.stdout.match(/EXIT=(\d+)/) || [])[1];
        bad(`本轮报告 ${res.reportCount} 份 / 用例 ${res.totalTests} 个`
            + `（期望 ${EXPECTED_REPORTS} 份 / ${EXPECTED_TESTS} 个）；`
            + (mvnExit === undefined
                ? 'run-mvn 自身没跑起来（输出里没有 EXIT= 行）'
                : `maven 退出码 ${mvnExit}`)
            + ' ⇒ 本轮无效，拒绝当红');
        console.log('      maven 输出尾部：');
        console.log(res.stdout.split('\n').filter(Boolean).slice(-12).map((l) => '      ' + l).join('\n'));
        restoreChecked();
        process.exit(2);
    }

    const failed = res.failed;
    console.log(`   本轮 ${res.totalTests} 个用例，失败 ${failed.size} 个：${[...failed].join(', ') || '（无）'}`);

    for (const id of r.red) {
        if (hit(failed, id)) ok(`必须红 · ${id} 已报红`);
        else bad(`「必须红」的 ${id} 没有报红 ⇒ 这条断言没有判别力（或突变没生效）`);
    }
    const leaked = [...failed].filter((f) => r.green.includes(f));
    if (leaked.length) {
        bad(`「必须仍绿」的用例被误伤：${leaked.join(', ')} ⇒ 这轮突变混淆了两个可观测后果，要拆轮`);
    } else if (r.green.length) {
        ok(`必须仍绿 · ${r.green.length} 个用例全部仍绿（防掩盖判据成立）`);
    }
    if (r.red.length === 0 && failed.size > 0) {
        bad(`本对照组不该有任何红，实得 ${failed.size} 个 ⇒ 探针本身在报噪声`);
    }
    const unexplained = [...failed].filter((f) => !r.red.includes(f));
    if (unexplained.length) {
        bad(`出现了红/绿清单之外的失败：${unexplained.join(', ')} ⇒ 与本轮声称的后果不符，需人工判断`);
    }

    restoreChecked();
    ok('源码已逐字节还原（md5 一致）\n');
}

console.log('—— R9-收尾：全部还原后重跑，必须全绿');
{
    const res = runTests('final');
    if (res.reportCount < EXPECTED_REPORTS || res.totalTests !== EXPECTED_TESTS) {
        bad(`收尾轮报告 ${res.reportCount} 份 / 用例 ${res.totalTests} 个，无法判定`);
    } else if (res.failed.size > 0) {
        bad(`还原后仍有失败：${[...res.failed].join(', ')}`);
    } else {
        ok(`还原后 ${res.totalTests}/${EXPECTED_TESTS} 全绿 ⇒ 前面每一轮的红都确实来自那处突变`);
    }
}

console.log(problems === 0 ? '\n结果：全部轮次成立（0 处异常）' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
