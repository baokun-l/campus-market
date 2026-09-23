/**
 * ==================================================================
 * 红绿探针 P1-5 / P1-6：健康检查与日志上下文，测试到底有没有判别力？
 * ==================================================================
 *
 * 起因同 L9：本轮新写了 17 条用例，全绿。但「全绿」本身**不构成证明** ——
 * 一个断言写反、或者根本没断言到点子上的测试同样会绿。
 * 本仓纪律：**必须报出「红→绿」才算证明**。
 *
 * 做法：把两处修复**刻意改回修复前的写法**（八处最小改动，与缺陷形态一一对应），
 * 跑同一批用例，必须报红；再逐字节还原，必须全绿，且 md5 一致。
 *
 * ★★★ 本探针最贵的一课：突变之间会「互相掩盖」，必须按可观测后果拆轮 ★★★
 * 第一版把 5 处突变放在一轮里，结果有两条用例**没报红**，看上去像"用例没有判别力"。
 * 单独复现后发现用例其实是有判别力的，问题出在归因粒度上：
 *   · M6（把限时换成 Long.MAX_VALUE）让 M7（不夹紧）传进去的 1ms 完全不起作用；
 *   · M4（超时分支也报 UP）把 M7 的可观测后果吃掉了 —— 夹紧失效导致探测超时，
 *     而超时分支恰好被改成报 UP，于是断言"应报 DOWN"的用例反而绿了。
 * ⇒ 结论：**一轮只能验证一个可观测后果**。现在拆成 5 轮，
 *   每轮都点名「必须红的用例」与「必须仍然绿的用例」（后者正是防掩盖）。
 *
 * ★ 判据是「具体哪几条用例报红」，不是「有没有报红」★
 * 只要有一条红就算「有判别力」是不够的：那可能只是某条无关用例炸了。
 * ★ 编译失败不算报红 ★：它证明不了任何断言有判别力。探针第一次跑就撞上过一次
 * （M6 最初写成无参的 get() ⇒ TimeoutException 永不抛出 ⇒ catch 分支编译不过），
 * 当时探针拒绝把 COMPILATION ERROR 当"红"，并打印了编译错误原文。
 *
 * 用法：node .workbuddy/probe-p15p16-redgreen.mjs
 * 退出码：0 = 红绿都符合预期 / 1 = 与预期不符 / 2 = 探针自身失效
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const JAVA = path.join(BE, 'src', 'main', 'java', 'com', 'campus', 'market');
const FILTER = path.join(JAVA, 'config', 'RequestTraceFilter.java');
const HEALTH_SVC = path.join(JAVA, 'service', 'HealthService.java');
const HEALTH_CTL = path.join(JAVA, 'controller', 'HealthController.java');
const TMP = path.join(ROOT, '.workbuddy', 'tmp');
const LOG = path.join(TMP, 'p15p16-redgreen.log');
const MVN = 'D:\\apache-maven-3.9.4\\bin\\mvn.cmd';
const JDK17 = 'C:\\Program Files\\Java\\jdk-17';
const TESTS = 'RequestTraceFilterTest,HealthServiceTest,HealthControllerTest';

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const log = (m) => console.log(m);

/* ---------------- 突变片段（每处对应一个缺陷形态） ---------------- */

const M1 = {
    file: FILTER,
    id: 'M1',
    desc: '不清理 MDC（修复前：线程复用会把上下文串到下一个请求）',
    find: `        } finally {
            // ★ 必须清干净：线程复用会让下一个请求继承本次的上下文（见类注释）
            MDC.clear();
        }`,
    replace: `        } finally {
            // 突变 M1：不清上下文
        }`,
    expect: 1
};

const M2 = {
    file: FILTER,
    id: 'M2',
    desc: '不校验 X-Request-Id（攻击者可控的头原样进日志 ⇒ 日志注入）',
    find: `        if (incoming != null && LEGAL_TRACE.matcher(incoming).matches()) {`,
    replace: `        if (incoming != null) {   // 突变 M2：不校验`,
    expect: 1
};

const M3 = {
    file: FILTER,
    id: 'M3',
    desc: 'URI 不过滤控制字符（换行同样能伪造日志行）',
    find: `            if (c >= 0x20 && c != 0x7F) {
                sb.append(c);
            }`,
    replace: `            sb.append(c);   // 突变 M3：不过滤`,
    expect: 1
};

const M4 = {
    file: HEALTH_SVC,
    id: 'M4',
    desc: '超时分支也报 UP（探针看不出"卡住的依赖"）',
    find: `            db.put("status", DOWN);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            // 超时不带堆栈：这是"依赖不健康"的预期结果，不是代码缺陷；带堆栈会把 error 日志冲成噪音`,
    replace: `            db.put("status", UP);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            // 超时不带堆栈：这是"依赖不健康"的预期结果，不是代码缺陷；带堆栈会把 error 日志冲成噪音`,
    expect: 1
};

const M5 = {
    file: HEALTH_SVC,
    id: 'M5',
    desc: '探测失败分支也报 UP（库挂了监控仍显示健康）',
    find: `            db.put("status", DOWN);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            // ★ 细节只进日志（含 traceId/uid），响应里一个字都不回传`,
    replace: `            db.put("status", UP);
            db.put("latencyMs", System.currentTimeMillis() - t0);
            // ★ 细节只进日志（含 traceId/uid），响应里一个字都不回传`,
    expect: 1
};

const M6 = {
    file: HEALTH_SVC,
    id: 'M6',
    desc: '探测不设上界（数据库挂掉时健康检查自己卡 30 秒）',
    /*
     * ★ 为什么不是无参的 future.get() ★
     * 那样写 TimeoutException 就"永不抛出"了，下面的 catch 分支直接编译不过
     * （javac：在相应的 try 语句主体中不能抛出异常错误）。
     * 换成 Long.MAX_VALUE 才既保持可编译、又等价于"没有上界"（等 292 亿年）。
     */
    find: `            long latency = future.get(dbTimeoutMs, TimeUnit.MILLISECONDS);`,
    replace: `            long latency = future.get(Long.MAX_VALUE, TimeUnit.MILLISECONDS);   // 突变 M6：上界等于没有`,
    expect: 1
};

const M7 = {
    file: HEALTH_SVC,
    id: 'M7',
    desc: 'db-timeout-ms 不夹紧（配 0/1 就几乎每次必然超时 ⇒ 假警报）',
    find: `        this.dbTimeoutMs = Math.max(200, dbTimeoutMs);`,
    replace: `        this.dbTimeoutMs = dbTimeoutMs;   // 突变 M7：不夹紧`,
    expect: 1
};

const M8 = {
    file: HEALTH_CTL,
    id: 'M8',
    desc: '用非 0 code 表示不健康（把"请求成功"与"服务不可用"混成一个信号）',
    find: `        return Result.success(healthService.report());`,
    replace: `        return Result.error(501, "服务不可用");   // 突变 M8`,
    expect: 1
};

/* ---------------- 五轮：一轮只验证一个可观测后果 ---------------- */

const ROUNDS = [
    {
        id: 'A · 日志上下文（M1/M2/M3）',
        mutations: [M1, M2, M3],
        mustBeRed: [
            'clearsMdcAfterRequest',        // M1：不清 MDC ⇒ 线程复用串号
            'clearsMdcEvenWhenChainThrows', // M1：异常路径漏清
            'rejectsIllegalIncomingTraceId',// M2：不校验头 ⇒ 日志注入
            'sanitizesUri'                  // M3：URI 不过滤换行 ⇒ 同样能伪造日志行
        ],
        mustStayGreen: ['reportsDownWhenDatabaseUnreachable', 'doesNotHangWhenDatabaseStalls']
    },
    {
        id: 'B1 · 探测真假与响应契约（M5/M8）',
        mutations: [M5, M8],
        mustBeRed: [
            'reportsDownWhenDatabaseUnreachable', // M5：库连不上却报 UP ⇒ 正是 P1-5 要修的那个坑
            'keepsCodeZeroEvenWhenDown'           // M8：拿非 0 code 当健康信号
        ],
        mustStayGreen: [
            'clearsMdcAfterRequest',
            'doesNotHangWhenDatabaseStalls',
            'clampsTooSmallTimeoutUpwards',
            'clampFloorIsTwoHundredMillis'
        ]
    },
    {
        id: 'B2 · 卡住的依赖必须算不健康（M4）',
        mutations: [M4],
        mustBeRed: ['doesNotHangWhenDatabaseStalls'],   // 超时分支报 UP ⇒ 断言"应报 DOWN"的用例必红
        mustStayGreen: [
            'clearsMdcAfterRequest',
            // ★ 这两条是「防掩盖」的关键：M4 与 M7 会互相掩盖，必须看到 M4 单独不会碰它们
            'clampsTooSmallTimeoutUpwards',
            'clampFloorIsTwoHundredMillis',
            'reportsDownWhenDatabaseUnreachable'
        ]
    },
    {
        id: 'B3 · 限时下限夹紧（M7）',
        mutations: [M7],
        mustBeRed: [
            'clampsTooSmallTimeoutUpwards', // 1ms 预算 vs 20ms 的工作 ⇒ 必然超时 ⇒ 恒报 DOWN 的假警报
            'clampFloorIsTwoHundredMillis'  // 生效值不再是 200
        ],
        mustStayGreen: [
            'clearsMdcAfterRequest',
            'doesNotHangWhenDatabaseStalls',
            'reportsDownWhenDatabaseUnreachable',
            'keepsCodeZeroEvenWhenDown'
        ]
    },
    {
        id: 'C · 探测上界（M6）',
        mutations: [M6],
        mustBeRed: ['doesNotHangWhenDatabaseStalls'],   // 库卡 5 秒 ⇒ 探测跟着卡 5 秒
        mustStayGreen: [
            'clearsMdcAfterRequest',
            'reportsDownWhenDatabaseUnreachable',
            'clampsTooSmallTimeoutUpwards',
            'clampFloorIsTwoHundredMillis',
            'keepsCodeZeroEvenWhenDown'
        ]
    }
];

/* ---------------- 跑测试 ---------------- */

function runTests() {
    /*
     * ★★ 跑之前必须删 target/maven-status ★★
     *
     * 否则 maven 会在 compile 阶段直接失败：
     *   Error reading old mojo status ... inputFiles.lst: Input length = 1
     * 这是增量编译的"上次编过哪些文件"清单读不回来（本机路径含中文，
     * 清单的编码与读取方不一致 ⇒ 解码中断）。它的表现极具误导性：
     * **一条测试都没跑，日志里却只有一句 mojo 报错**，很容易被误读成"测试挂了"。
     * 删掉它只是让 maven 做一次全量编译，结果不变，代价约 10 秒。
     */
    fs.rmSync(path.join(BE, 'target', 'maven-status'), { recursive: true, force: true });

    const r = spawnSync(MVN, [
        // ★ -s 的路径必须是正斜杠 ★（本仓工具坑：反斜杠会让 maven 找不到 settings）
        '-o', '-s', path.join(ROOT, '.workbuddy', 'mvn-aliyun-settings.xml').replace(/\\/g, '/'),
        `-Dtest=${TESTS}`, '-DfailIfNoSpecifiedTests=false', 'test',
        '-f', path.join(BE, 'pom.xml')
    ], {
        cwd: ROOT,
        env: { ...process.env, JAVA_HOME: JDK17 },
        encoding: 'latin1',      // Windows 控制台是 GBK；ASCII 部分按 latin1 读仍然正确
        shell: true,             // ★ .cmd 必须走 shell
        maxBuffer: 64 * 1024 * 1024
    });
    const text = ((r.stdout ?? '') + (r.stderr ?? ''));
    fs.writeFileSync(LOG, text, 'latin1');

    const lines = text.split(/\r?\n/);
    const sums = lines.filter((l) => l.includes('Tests run:') && l.includes('-- in '));
    const failed = new Set();
    for (const l of lines) {
        const m = l.match(/(\w+Test)\.(\w+):\d+/);
        if (m && (l.includes('[ERROR]') || l.includes('FAIL'))) failed.add(m[2]);
    }
    const totals = sums.map((l) => {
        const cls = l.split('-- in ')[1]?.trim().split('.').pop() ?? '?';
        return `${cls} run=${/Tests run: (\d+)/.exec(l)?.[1]} fail=${/Failures: (\d+)/.exec(l)?.[1]} err=${/Errors: (\d+)/.exec(l)?.[1]}`;
    });
    // 一条 surefire 汇总都没有 ⇒ 根本没跑到测试（编译失败是常见原因）
    const compileBroke = sums.length === 0;
    // ★ 把编译错误原文抓出来 ★：只报"没跑到测试"会让人去翻业务代码，
    //   而真实原因（某处突变让代码编不过）其实已经写在日志里
    const compileErrors = lines
        .filter((l) => l.includes('[ERROR]') && (l.includes('.java') || l.includes('COMPILATION')))
        .slice(0, 6);
    return { failed: [...failed], totals, compileBroke, buildOk: text.includes('BUILD SUCCESS'), compileErrors };
}

/* ---------------- 主流程 ---------------- */

log('=== 红绿探针 P1-5 / P1-6：把修复改回旧写法，用例必须报红 ===');
fs.mkdirSync(TMP, { recursive: true });

const files = [FILTER, HEALTH_SVC, HEALTH_CTL];
const originals = new Map(files.map((f) => [f, { text: fs.readFileSync(f, 'utf8'), md5: md5(f) }]));
for (const [f, o] of originals) log(`  已记录 ${path.basename(f)} md5 ${o.md5}`);

let bad = 0;
let dirty = false;

function restoreAll() {
    for (const [f, o] of originals) {
        if (fs.readFileSync(f, 'utf8') !== o.text) fs.writeFileSync(f, o.text, 'utf8');
    }
    dirty = false;
}

function assertRestored(tag) {
    let ok = true;
    for (const [f, o] of originals) {
        const now = md5(f);
        if (now !== o.md5) {
            log(`  [FATAL] ${path.basename(f)} 还原后 md5 不一致：${now} != ${o.md5}`);
            ok = false;
            bad = 1;
        }
    }
    if (ok) log(`  ✓ ${tag}：三个文件均与原文件逐字节一致`);
}

function applyMutations(mutations) {
    for (const mu of mutations) {
        const cur = fs.readFileSync(mu.file, 'utf8');
        const count = cur.split(mu.find).length - 1;
        if (count !== mu.expect) {
            log(`  [FATAL] ${mu.id} 锚点命中 ${count} 次，期望 ${mu.expect} 次 —— 源码已漂移，探针不再可信。`);
            log(`         文件：${mu.file}`);
            process.exit(2);
        }
        fs.writeFileSync(mu.file, cur.split(mu.find).join(mu.replace), 'utf8');
        log(`  ${mu.id}  ${mu.desc}  （锚点命中 ${count} 次 ✓）`);
    }
}

try {
    for (const round of ROUNDS) {
        log(`\n############ 第 ${round.id} 轮 ############`);
        applyMutations(round.mutations);
        dirty = true;

        log('\n---------- 突变版跑用例（期望红）----------');
        const red = runTests();
        log(`  ${red.totals.join('\n  ')}`);
        if (red.compileBroke) {
            log(`\n[FATAL] 一条 surefire 汇总都没有 ⇒ 大概率是编译失败 —— 编译失败不算「报红」。详见 ${LOG}`);
            red.compileErrors.forEach((l) => log(`        ${l}`));
            bad = 1;
        } else {
            log(`  失败用例（${red.failed.length} 条）：`);
            red.failed.forEach((n) => log(`      ✗ ${n}`));
            if (red.failed.length === 0) {
                log('\n  [FATAL] 突变版**全绿** ⇒ 这批用例没有判别力，等于没写。');
                bad = 1;
            }
            const missing = round.mustBeRed.filter((n) => !red.failed.includes(n));
            if (missing.length) {
                log(`\n  [FATAL] 这几条核心用例没有报红：${missing.join(', ')}`);
                log('         要么判据锚错了地方，要么被同一轮里别的突变掩盖了（见文件头部那一课）。');
                bad = 1;
            } else {
                log(`\n  ✓ ${round.mustBeRed.length} 条核心用例全部报红`);
            }
            const collateral = round.mustStayGreen.filter((n) => red.failed.includes(n));
            if (collateral.length) {
                log(`\n  [FATAL] 出现误伤：${collateral.join(', ')} 与本轮这一处缺陷无关却也红了。`);
                bad = 1;
            } else {
                log(`  ✓ 无关联用例未误伤（${round.mustStayGreen.join(', ')} 仍绿）`);
            }
        }

        log('\n---------- 还原 ----------');
        restoreAll();
        assertRestored('逐字节还原');
    }

    /*
     * 收尾只跑一次全绿。
     * ★ 为什么不必每轮都跑一次绿 ★
     * 绿要证明的是「原源码下这批用例全绿」，而每轮结束都已逐字节还原并核过 md5 ——
     * 源码状态始终是同一个，重复跑只是把时间花在同样的 maven 启动上。
     * 红绿成立的两个前提（每轮的红、还原后的绿）在这一条里都齐了。
     */
    log('\n############ 收尾：还原版跑用例（期望全绿）############');
    const green = runTests();
    log(`  ${green.totals.join('\n  ')}`);
    if (green.compileBroke) {
        log('\n  [FATAL] 还原后没跑到测试 ⇒ 前面那些"红"可能是环境问题而不是断言问题。');
        green.compileErrors.forEach((l) => log(`        ${l}`));
        bad = 1;
    } else if (green.failed.length) {
        log(`\n  [FATAL] 还原后仍有 ${green.failed.length} 条失败：${green.failed.join(', ')}`);
        bad = 1;
    } else if (!green.buildOk) {
        log('\n  [FATAL] 没有 BUILD SUCCESS。');
        bad = 1;
    } else {
        log('  ✓ 全绿');
    }
} finally {
    if (dirty) {
        restoreAll();
        log('\n  （异常退出，已强制还原）');
    }
    for (const [f, o] of originals) {
        const now = md5(f);
        log(`  收尾核对 ${path.basename(f)} md5 ${now}${now === o.md5 ? ' ✓' : ' ✗ 与原文件不一致！'}`);
    }
}

log('\n========== 结论 ==========');
if (bad === 0) {
    log('  ⇒ 红→绿成立：5 轮突变各自报出预期的红，还原后 17 条用例全绿，且无关联用例未误伤。');
} else {
    log('  ⇒ 有不符项，见上文。');
}
process.exit(bad === 0 ? 0 : 1);
