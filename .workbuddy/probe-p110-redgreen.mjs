/**
 * P1-10（上传限流 + 魔数嗅探）红绿探针。
 *
 * 纪律（本仓踩过的坑，逐条对应）：
 *  1. 一轮突变只验证**一个可观测后果**；每轮同时点名「必须红」与「必须仍绿」
 *     —— 后者是**防掩盖判据**：M6 换限时那次就是被另一个突变掩盖，断言反而变绿了。
 *  2. 脚本必须**自证**：编译失败 / 没生成 surefire 报告 ⇒ 该轮无效，退出码 2，
 *     绝不能把「编译不过」当成「报红了」。
 *  3. 还原必须**逐字节**（md5 比对），否则后面的轮次是在污染的代码上跑的。
 *  4. 必须有**对照组**：R0 不改代码（基线全绿）、RC 只改等价物（注释）也必须全绿
 *     —— 用「不该红的一轮」证明「红」不是噪声。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');
const CTL = path.join(BE, 'src/main/java/com/campus/market/controller/UploadController.java');
const GUARD = path.join(BE, 'src/main/java/com/campus/market/security/UploadQuotaGuard.java');
/*
 * ★ 报告目录：不删、不换目录，改用「只认本轮开始之后写出的报告」★
 *
 * 这一小块踩了两个坑，都值得留在这里：
 *
 * 坑一（删不得）：第一版跑之前 `fs.rmSync(target/surefire-reports)`。那是**累积目录**——
 *   之前跑全量 452 个用例留下了 50+ 个文件，删它触发宿主「一次删除超过 50 个文件」的护栏
 *   （SAFE_DELETE_BULK_CONFIRM_REQUIRED），探针在 RC 轮直接崩溃。
 *   护栏没错，错的是「为了拿干净结果去删目录」这个动作本来就可以不存在。
 *
 * 坑二（换不动，而且**静默失败**）：改用 `-Dsurefire.reportsDirectory=…` 想让每轮写进各自目录，
 *   结果报告照样落在默认目录、目录压根没被创建、maven 一行错都不报 ——
 *   因为 `reportsDirectory` 在 maven-surefire-plugin 里**没有绑定 user property**，
 *   所以 `-D` 被无声吞掉。这与本项目「配置改了没反应先查值有没有到达变量」是同一条教训：
 *   **新增配置先做可到达性验证**，否则你以为的开关只是个装饰。
 *
 * 定稿方案：目录固定用默认的，靠 **mtime 下界**（本轮启动时刻）筛出本轮新写出的报告。
 *   上一轮的残留报告 mtime 必然早于本轮启动时刻 ⇒ 天然被排除，一个文件都不用删。
 *   自证仍未削弱：报告数不足 3 份、或总用例数不等于 EXPECTED_TESTS，都判本轮无效。
 */
const REPORTS = path.join(BE, 'target', 'surefire-reports');
const EXPECTED_TESTS = 33;   // ImageTypeTest 9 + UploadQuotaGuardTest 13 + UploadControllerTest 11
const TESTS = 'ImageTypeTest,UploadQuotaGuardTest,UploadControllerTest';

const ALL_GREEN = [
    'ImageTypeTest#*',                     // 整类（纯函数，不受下面任何一处影响）
    'UploadQuotaGuardTest#*',              // 整类
];

const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');
const green = (cls) => `${cls}#*`;

/**
 * 读「本轮新写出」的报告：mtime 必须 >= 本轮启动时刻。
 * @return { failed:Set<'Class#method'>, reportCount:number, totalTests:number }
 */
function collectFreshReports(startMs) {
    const failed = new Set();
    let reportCount = 0;
    let totalTests = 0;
    if (!fs.existsSync(REPORTS)) return { failed, reportCount, totalTests };
    for (const f of fs.readdirSync(REPORTS)) {
        if (!f.startsWith('TEST-') || !f.endsWith('.xml')) continue;
        const full = path.join(REPORTS, f);
        // ★ 陈旧报告在这里被剔除：上一轮的 mtime 早于本轮启动时刻
        if (fs.statSync(full).mtimeMs < startMs) continue;
        reportCount++;
        const xml = fs.readFileSync(full, 'utf8');
        totalTests += Number((xml.match(/<testsuite[^>]*\btests="(\d+)"/) || [])[1] || 0);
        const re = /<testcase\s+([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const attrs = m[1];
            const body = m[3] || '';
            if (!/<(failure|error)[\s>]/.test(body)) continue;
            const name = (attrs.match(/name="([^"]+)"/) || [])[1];
            const cls = (attrs.match(/classname="([^"]+)"/) || [])[1] || '';
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
        env: { ...process.env, MVN_LOG: `mvn-p110-${tag}.log` },
        encoding: 'utf8',
    });
    const fresh = collectFreshReports(startMs);
    return { code: r.status, stdout: (r.stdout || '') + (r.stderr || ''), ...fresh };
}

/** 是否命中「必须红 / 必须仍绿」清单（支持 Class#* 通配整类）。入参可以是数组或 Set */
function hit(list, id) {
    const arr = Array.isArray(list) ? list : [...list];
    return arr.some((p) => (p.endsWith('#*') ? id.startsWith(p.slice(0, -1)) : p === id));
}

let problems = 0;
const bad = (m) => { console.log('  ✗ ' + m); problems++; };
const ok = (m) => console.log('  ✓ ' + m);

const original = { [CTL]: md5(CTL), [GUARD]: md5(GUARD) };

/** 一条突变：把 from 换成 to（from 必须**恰好命中 1 次**，否则拒绝执行这一轮） */
const allRounds = [
    {
        id: 'R0-基线',
        title: '不改任何代码 ⇒ 全绿（对照组之一）',
        mut: null,
        red: [], green: [green('ImageTypeTest'), green('UploadQuotaGuardTest'), 'UploadControllerTest#*'],
    },
    {
        id: 'RC-等价改注释',
        title: '只改注释（等价物）⇒ 必须仍然全绿（对照组之二：证明「红」不是噪声）',
        mut: { file: CTL, from: '        ImageType type = sniff(file);',
               to: '        // 探针对照组：这句话不改行为\n        ImageType type = sniff(file);' },
        red: [], green: [green('ImageTypeTest'), green('UploadQuotaGuardTest'), 'UploadControllerTest#*'],
    },
    {
        id: 'M1-去掉魔数嗅探',
        title: '魔数判定作废（永远当 PNG）⇒ 非图片必须被拦下、且磁盘不留文件',
        mut: { file: CTL, from: '        ImageType type = sniff(file);',
               to: '        ImageType type = ImageType.PNG;' },
        red: ['UploadControllerTest#rejectsNonImageAndWritesNothing',
              'UploadControllerTest#rejectsRiffThatIsNotWebp',
              'UploadControllerTest#tooShortFileIsRejectedNotCrashed'],
        green: [green('ImageTypeTest'), green('UploadQuotaGuardTest'),
                'UploadControllerTest#guardIsPerUser', 'UploadControllerTest#rejectsEmptyAndOversize'],
    },
    {
        id: 'M2-扩展名改回取文件名',
        title: '落盘扩展名不再取字节（固定用客户端给的后缀）⇒ 「字节说了算」这条必须红',
        mut: { file: CTL, from: '        String ext = type.ext();',
               to: '        String ext = "png";' },
        red: ['UploadControllerTest#storesExtensionFromBytesNotFromFilename',
              'UploadControllerTest#acceptsWebpAndPng'],
        green: [green('ImageTypeTest'), green('UploadQuotaGuardTest'),
                'UploadControllerTest#rejectsNonImageAndWritesNothing', 'UploadControllerTest#guardIsPerUser'],
    },
    {
        id: 'M3-闸门挪到魔数之后',
        title: '把闸门调用移到**整段魔数校验之后** ⇒ 排序判据必须红，但「闸门确实接上了」仍必须是绿的',
        /*
         * ★ 第一版这里写错了，值得记一笔 ★
         * 原始写法是把 acquire 插在 `sniff(file)` 与 `if (type == null)` **之间**，
         * 结果全绿。但那**不是**探针失效，而是这处突变**对可观测后果等价**：
         * 闸门仍然排在「抛错之前」，垃圾请求照样会被计数 ⇒ 「反复发垃圾也会被闸门拦住」
         * 这个能力仍然成立，用例保持绿色是**正确的**。
         * 只有把闸门挪到「魔数校验抛出之后」，垃圾请求才会完全绕过计数 —— 那才是能力被拿掉。
         */
        mut: { file: CTL, from: '        uploadQuotaGuard.acquire(currentUserId(request));\n\n        if (file == null || file.isEmpty()) {',
               to: '        if (file == null || file.isEmpty()) {' },
        mut2: { file: CTL,
                from: '        ImageType type = sniff(file);\n        if (type == null) {\n            throw BusinessException.paramError("这不是有效的图片文件，请使用 jpg / png / gif / webp / bmp 格式的图片");\n        }',
                to: '        ImageType type = sniff(file);\n        if (type == null) {\n            throw BusinessException.paramError("这不是有效的图片文件，请使用 jpg / png / gif / webp / bmp 格式的图片");\n        }\n        uploadQuotaGuard.acquire(currentUserId(request));' },
        red: ['UploadControllerTest#guardRunsBeforeMagicCheck'],
        green: [green('ImageTypeTest'), green('UploadQuotaGuardTest'),
                'UploadControllerTest#guardIsWiredIntoController',
                'UploadControllerTest#rejectsNonImageAndWritesNothing',
                'UploadControllerTest#storesExtensionFromBytesNotFromFilename'],
    },
    {
        id: 'M4-闸门整行删掉',
        title: '接口里不再调用闸门 ⇒ 「接线」这条必须红（这是单测最容易漏的一类：类绿、接线断）',
        mut: { file: CTL, from: '        uploadQuotaGuard.acquire(currentUserId(request));\n\n', to: '' },
        red: ['UploadControllerTest#guardIsWiredIntoController',
              'UploadControllerTest#guardRunsBeforeMagicCheck',
              'UploadControllerTest#guardIsPerUser'],
        green: [green('ImageTypeTest'), green('UploadQuotaGuardTest'),
                'UploadControllerTest#storesExtensionFromBytesNotFromFilename',
                'UploadControllerTest#rejectsNonImageAndWritesNothing'],
    },
    {
        id: 'M5-先建用户条目再判全站',
        title: '把全站维度的判断挪到建用户条目之后 ⇒ 「不留下内存痕迹」必须红，而「不偷吃额度」必须仍绿',
        mut: { file: GUARD, from: `            rollWindow(global, now);\n\n            /*\n             * ★ 全站维度先判，而且要在建用户条目之前判 ★`,
               to: `            Window early = byUser.computeIfAbsent(String.valueOf(userId), k -> newWindow(now));\n            rollWindow(early, now);\n            rollWindow(global, now);\n\n            /*\n             * ★ 全站维度先判，而且要在建用户条目之前判 ★` },
        red: ['UploadQuotaGuardTest#globalIsCheckedBeforeUserEntryIsCreated'],
        green: [green('ImageTypeTest'), green('UploadControllerTest'),
                'UploadQuotaGuardTest#userRejectionDoesNotConsumeGlobalQuota'],
    },
    {
        id: 'M6-判定即消耗（判一个加一个）',
        title: '用户维度超限时已经把全站计数 +1 ⇒ 「不偷吃额度」必须红，而「不留下痕迹」必须仍绿',
        mut: { file: GUARD, from: `            if (globalMaxUploads > 0 && global.count >= globalMaxUploads) {`,
               to: `            global.count++;\n            if (globalMaxUploads > 0 && global.count > globalMaxUploads) {` },
        red: ['UploadQuotaGuardTest#userRejectionDoesNotConsumeGlobalQuota',
              'UploadQuotaGuardTest#globalDimensionCapsTotal'],
        green: [green('ImageTypeTest'), green('UploadControllerTest'),
                'UploadQuotaGuardTest#globalIsCheckedBeforeUserEntryIsCreated'],
    },
    {
        id: 'M7-窗口永不过期',
        title: 'rollWindow 不再重置窗口 ⇒ 「限流会自己解除」必须红（上线即永久锁死这一类）',
        mut: { file: GUARD, from: `        if (now - w.windowStartMs >= windowMs) {\n            w.windowStartMs = now;\n            w.count = 0;\n        }`,
               to: `        if (false) {\n            w.windowStartMs = now;\n            w.count = 0;\n        }` },
        red: ['UploadQuotaGuardTest#quotaRestoresAfterWindowSlides'],
        green: [green('ImageTypeTest'), green('UploadControllerTest'),
                'UploadQuotaGuardTest#rejectsAfterQuotaExhausted', 'UploadQuotaGuardTest#usersAreIsolated'],
    },
    {
        id: 'M8-window-seconds 不再夹紧',
        title: '窗口长度不做下限夹紧 ⇒ 「配 0 会收敛到 1 秒」必须红（配 0 若原样生效，闸门变摆设）',
        mut: { file: GUARD, from: 'this.windowMs = Math.max(1L, windowSeconds) * 1000L;',
               to: 'this.windowMs = windowSeconds * 1000L;' },
        red: ['UploadQuotaGuardTest#zeroWindowIsClampedToOneSecond'],
        green: [green('ImageTypeTest'), green('UploadControllerTest'),
                'UploadQuotaGuardTest#rejectsAfterQuotaExhausted'],
    },
    {
        id: 'M9-回收扔在锁外且不再判窗口',
        title: '把情性回收改成「见门限就清空」 ⇒ 窗口内的条目被误删（等于放开限流）必须红',
        mut: { file: GUARD, from: '        byUser.entrySet().removeIf(e -> now - e.getValue().windowStartMs >= windowMs);',
               to: '        byUser.clear();' },
        red: ['UploadQuotaGuardTest#purgeKeepsEntriesStillInsideWindow'],
        green: [green('ImageTypeTest'), green('UploadControllerTest'),
                'UploadQuotaGuardTest#rejectsAfterQuotaExhausted'],
    },
];

// 支持只跑指定轮次：node probe-p110-redgreen.mjs M3（空白参数 = 跑全部）
const only = process.argv.slice(2);
const rounds = only.length ? allRounds.filter((r) => only.some((o) => r.id.startsWith(o))) : allRounds;
// ★ 自证：给了过滤条件却一轮都没命中，绝不能当「全部成立」收场 ——
//   第一版用的是精确 includes(r.id)，而 id 是「M3-闸门挪到魔数之后」，
//   于是 `node ... M3` 静默跑成 0 轮，最后照样打印「全部轮次成立」。
//   这就是「脚本自己撒谎」，必须就地掐死。
if (only.length && rounds.length === 0) {
    console.error(`✗ 过滤条件 ${JSON.stringify(only)} 没命中任何轮次 ⇒ 拒绝输出结论`);
    console.error(`  可选轮次：${allRounds.map((r) => r.id).join(' | ')}`);
    process.exit(2);
}

console.log('=== P1-10 红绿探针（上传限流 + 魔数嗅探）===');
console.log(`源码指纹：UploadController=${original[CTL]}  UploadQuotaGuard=${original[GUARD]}\n`);

const applyMut = (m) => {
    const txt = fs.readFileSync(m.file, 'utf8');
    const n = txt.split(m.from).length - 1;
    if (n !== 1) {
        throw new Error(`锚点命中 ${n} 次（要求恰好 1 次）：${m.from.slice(0, 60)}…`);
    }
    fs.writeFileSync(m.file, txt.replace(m.from, m.to), 'utf8');
};

const restore = (file) => {
    // 从头一份原始内容还原：先写回备份再比对 md5
    const txt = backups[file];
    fs.writeFileSync(file, txt, 'utf8');
    const now = md5(file);
    if (now !== original[file]) {
        throw new Error(`还原后 md5 不一致！${file}\n  期望 ${original[file]}\n  实得 ${now}`);
    }
};

const backups = { [CTL]: fs.readFileSync(CTL, 'utf8'), [GUARD]: fs.readFileSync(GUARD, 'utf8') };

/**
 * ★ 崩溃也要还原 ★（第一版探针就栽在这里）
 * 探针中途抛异常时，被突变过的源码会被**留在工作区**里 —— 后面看到的一切
 * （审计判据、真机产物、单测）都是在一份被改坏的代码上得出的，而且毫无提示。
 * 所以：任何未捕获异常 / 正常退出，都先把两个文件写回备份。
 */
const restoreAll = () => {
    for (const f of [CTL, GUARD]) {
        fs.writeFileSync(f, backups[f], 'utf8');
        // ★ 自证：写回后必须与原指纹逐字节一致，否则后面的轮次是在污染的代码上跑的
        if (md5(f) !== original[f]) {
            console.error(`\n✗ 还原后 md5 不一致！${path.basename(f)}`);
            process.exit(2);
        }
    }
};
process.on('uncaughtException', (e) => {
    restoreAll();
    console.error('\n探针崩溃（源码已还原）:', e && e.message);
    process.exit(2);
});
// exit 钩子里只做「写回」，不再做 md5 校验 —— 在 exit 里再调 process.exit 会绕圈
process.on('exit', () => {
    for (const f of [CTL, GUARD]) {
        fs.writeFileSync(f, backups[f], 'utf8');
    }
});

/*
 * ★★ 探针自证：mtime 下界必须真的有判别力 ★★
 *
 * 为什么非要有这一段：本轮的「3 份报告 / 33 个用例」与**上一次运行留下的陈旧报告**
 * 长得一模一样。也就是说，即使 mtime 过滤完全失效（恒真），输出也看不出任何区别 ——
 * 这正是「判据自己骗自己」的典型形态。
 * 所以故意喂一个**必然错误的输入**（下界推到 10 分钟后），它必须**一个都不认**：
 * 若这里仍返回 3 份，说明过滤条件根本没生效，本轮所有「本轮无红」的结论都要作废。
 */
{
    const future = collectFreshReports(Date.now() + 10 * 60 * 1000);
    if (future.reportCount !== 0 || future.totalTests !== 0) {
        bad(`【自证失败】把下界推到 10 分钟后仍认了 ${future.reportCount} 份 / ${future.totalTests} 个用例`
            + ` ⇒ mtime 过滤没有判别力，「本轮无红」的结论全部作废`);
        process.exit(2);
    }
    ok('探针自证 · 错误下界（未来时刻）下报告数为 0 ⇒ mtime 过滤确实在起作用');
}

for (const r of rounds) {
    console.log(`—— ${r.id}：${r.title}`);
    // 上一轮必须已还原干净
    for (const f of [CTL, GUARD]) {
        if (md5(f) !== original[f]) {
            bad(`进入本轮前 ${path.basename(f)} 不是原始版本，拒绝继续（上一轮没还原干净）`);
            process.exit(2);
        }
    }
    try {
        if (r.mut) applyMut(r.mut);
        if (r.mut2) applyMut(r.mut2);
    } catch (e) {
        bad(`突变锚点失效：${e.message}`);
        restoreAll();
        process.exit(2);
    }

    const res = runTests(r.id.split('-')[0]);
    /*
     * ★ 自证：本轮必须真跑出「3 份报告 + 33 个用例」★
     * 少一份 / 少几个用例，都是「压根没跑到」而不是「报红了」—— 两者绝不能混为一谈，
     * 否则编译不过会被当成判别力验证通过。（验收线在探针里，不在人的印象里。）
     */
    if (res.reportCount < 3 || res.totalTests !== EXPECTED_TESTS) {
        /*
         * ★ 为什么不去看 run-mvn 的退出码 ★
         * run-mvn.mjs 把 maven 的退出码吞进一行 `EXIT=<n>` 打印，自己**始终以 0 退出**
         * —— 也就是说 `spawnSync(...).status` 永远是 0，拿它当 maven 的结论是错的。
         * 只能从它的 stdout 里把那行捞回来；捞不到就说明 run-mvn 自身没跑起来，
         * 这跟「maven 跑了但失败」是两件完全不同的事，必须分开说。
         */
        const mvnExit = (res.stdout.match(/EXIT=(\d+)/) || [])[1];
        bad(`本轮报告 ${res.reportCount} 份 / 用例 ${res.totalTests} 个（期望 3 份 / ${EXPECTED_TESTS} 个）；`
            + (mvnExit === undefined
                ? 'run-mvn 自身没跑起来（输出里没有 EXIT= 行）'
                : `maven 退出码 ${mvnExit}`)
            + ' ⇒ 本轮无效，拒绝当红');
        /*
         * ★ 不猜原因，把 maven 自己的输出摆出来 ★
         * 第一版这里只挑 /ERROR|COMPILATION/ 三五行，于是「maven 压根没跑起来」
         * 和「代码编译不过」在输出上长得一模一样，两个完全不同的处置方向被糊成一句
         * 「多半是编译不过」。真实原因必须由证据给，不由推测给。
         */
        console.log('      maven 输出尾部：');
        console.log(res.stdout.split('\n').filter(Boolean).slice(-12).map((l) => '      ' + l).join('\n'));
        restoreAll();
        process.exit(2);
    }
    const failed = res.failed;
    console.log(`   本轮 ${res.totalTests} 个用例，失败 ${failed.size} 个：${[...failed].join(', ') || '（无）'}`);

    for (const id of r.red) {
        if (!hit(failed, id) && !(id.endsWith('#*') && [...failed].some((f) => f.startsWith(id.slice(0, -1))))) {
            bad(`「必须红」的 ${id} 没有报红 ⇒ 这条断言没有判别力（或突变没生效）`);
        } else {
            ok(`必须红 · ${id} 已报红`);
        }
    }
    const leaked = [...failed].filter((f) => r.green.some((p) => hit([p], f)));
    if (leaked.length) {
        bad(`「必须仍绿」的用例被误伤：${leaked.join(', ')} ⇒ 说明这轮突变混淆了两个可观测后果，要拆轮`);
    } else if (r.green.length) {
        ok(`必须仍绿 · ${r.green.join(' / ')} 全部仍绿（防掩盖判据成立）`);
    }
    if (r.red.length === 0 && failed.size > 0) {
        bad(`本对照组不该有任何红，实得 ${failed.size} 个 ⇒ 探针本身在报噪声`);
    }

    restoreAll();
    ok('源码已逐字节还原（md5 一致）\n');
}

// 收尾：还原后必须回到全绿
console.log('—— R9-收尾：全部还原后重跑，必须全绿');
{
    const res = runTests('final');
    if (res.reportCount < 3 || res.totalTests !== EXPECTED_TESTS) {
        bad(`收尾轮报告 ${res.reportCount} 份 / 用例 ${res.totalTests} 个（期望 3 / ${EXPECTED_TESTS}），无法判定`);
    } else if (res.failed.size > 0) {
        bad(`还原后仍有失败：${[...res.failed].join(', ')}`);
    } else {
        ok(`还原后 ${res.totalTests}/${EXPECTED_TESTS} 全绿 ⇒ 前面每一轮的红都确实来自那处突变`);
    }
}

console.log(problems === 0 ? '\n结果：全部轮次成立（0 处异常）' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
