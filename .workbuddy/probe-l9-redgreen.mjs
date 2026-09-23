/**
 * ==================================================================
 * 红绿探针 L9：AI 助手的三处修复，测试到底有没有判别力？
 * ==================================================================
 *
 * 起因：本轮新写了 29 条用例，全绿。但「全绿」本身**不构成证明** ——
 * 一个把所有断言都写反、或者根本没断言到点子上的测试，同样会绿。
 * 本仓的纪律是：**必须报出「红→绿」才算证明**。
 *
 * 做法：把 AiAssistantService 刻意改回**修复前的写法**（三处最小改动，
 * 与原始缺陷形态一一对应），跑同一批用例，它们必须**报红**；
 * 再逐字节还原，必须**全绿**，且还原前后 md5 一致。
 *
 * 三处突变（每处的锚点都必须恰好命中预期次数，否则探针自身退出码 2）：
 *   M3 闸门挪进 try 里          ← 对应「被限流却拿到一段看似正常的模板文案」
 *   M1 两条消息拼回一条字符串    ← 对应「输入直拼 prompt」
 *   M2 长度上限乘 1000          ← 对应「无长度上限」
 *
 * ★ 为什么不是「删掉测试」或「把断言写反」★
 * 那两种做法证明的是「测试文件是活的」，与本探针要证明的东西无关。
 * 这里动的是**实现**：它回答的是「如果有人把这个缺陷改回来，测试会不会叫」。
 *
 * ★ 判据是「具体哪几条用例报红」，不是「有没有报红」★
 * 只要有一条红就算「有判别力」是不够的：那可能只是某条无关用例炸了。
 * 本探针点名要求三条核心用例必须出现在失败名单里，并断言还原后
 * 失败名单为空 —— 两头都点名，中间那段才有意义。
 *
 * 用法：node .workbuddy/probe-l9-redgreen.mjs
 * 退出码：0 = 红绿都符合预期 / 1 = 与预期不符 / 2 = 探针自身失效
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BE = path.join(ROOT, 'campus-secondhand-backend');
const SRC = path.join(BE, 'src', 'main', 'java', 'com', 'campus', 'market', 'service', 'AiAssistantService.java');
const BACKUP = path.join(ROOT, '.workbuddy', 'tmp', 'AiAssistantService.java.l9bak');
const LOG = path.join(ROOT, '.workbuddy', 'tmp', 'l9-redgreen.log');
const MVN = 'D:\\apache-maven-3.9.4\\bin\\mvn.cmd';
const JDK17 = 'C:\\Program Files\\Java\\jdk-17';
const TESTS = 'AiQuotaGuardTest,AiAssistantServiceTest';

/** 必须报红的「核心三条」——每一条对应一处缺陷的判别力 */
const MUST_BE_RED = [
    'quotaRejectionIsNotSwallowedByDegrade',   // 闸门被 try 吞掉 ⇒ 限流不可见
    'overlongMessageIsRejectedBeforeModelCall', // 无长度上限
    'systemAndUserMessagesAreSeparated'         // 输入直拼 prompt
];

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const log = (m) => console.log(m);

/* ---------------- 突变定义 ---------------- */

/**
 * 每条突变：`find` 在原文中出现的次数必须等于 `expect`。
 * <p>
 * 次数不对就是锚点漂了（源码被改过），此时**必须停**，不能「大概改一下」——
 * 改错地方会让探针去证明一件与缺陷无关的事，而它照样会打印漂亮的红/绿。
 */
const MUTATIONS = [
    {
        id: 'M3',
        desc: '把闸门挪进 try 里（修复前：限流异常被降级分支吞掉）',
        find: `        quotaGuard.acquire(userId);

        String userContent = fenced(message);
        try {
`,
        replace: `        String userContent = fenced(message);
        try {
            quotaGuard.acquire(userId);
`,
        expect: 1
    },
    {
        id: 'M1',
        desc: '把系统规则与用户输入拼回同一条字符串（修复前：输入直拼 prompt）',
        find: `        String userContent = fenced(message);
        try {
            quotaGuard.acquire(userId);
            String reply = chatModel.call(new SystemMessage(CHAT_SYSTEM_PROMPT), new UserMessage(userContent));
`,
        replace: `        String prompt = CHAT_SYSTEM_PROMPT + "\\n\\n用户问题：" + message;
        try {
            quotaGuard.acquire(userId);
            String reply = chatModel.call(prompt);
`,
        expect: 1
    },
    {
        id: 'M2',
        desc: '把长度上限放大 1000 倍（修复前：无长度上限）',
        find: '        if (v.length() > maxLength) {',
        replace: '        if (v.length() > maxLength * 1000) {',
        expect: 2    // requireText 与 requireOptional 各一处，有意如此
    }
];

/* ---------------- 跑测试 ---------------- */

function runTests() {
    const r = spawnSync(MVN, [
        // ★ -s 的路径必须是正斜杠 ★（本仓工具坑之一：反斜杠会让 maven 找不到 settings）
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
        if (m && (l.includes('[ERROR]') || l.includes('FAIL'))) {
            failed.add(m[2]);
        }
    }
    const totals = sums.map((l) => {
        const cls = l.split('-- in ')[1]?.trim().split('.').pop() ?? '?';
        const run = /Tests run: (\d+)/.exec(l)?.[1];
        const fail = /Failures: (\d+)/.exec(l)?.[1];
        const err = /Errors: (\d+)/.exec(l)?.[1];
        return `${cls} run=${run} fail=${fail} err=${err}`;
    });
    // 一条 surefire 汇总都没有 ⇒ 根本没跑到测试（编译失败是常见原因）
    const compileBroke = sums.length === 0;
    return { failed: [...failed], totals, compileBroke, buildOk: text.includes('BUILD SUCCESS') };
}

/* ---------------- 主流程 ---------------- */

log('=== 红绿探针 L9：故意把修复改回旧写法，用例必须报红 ===');
log(`  源码 ${SRC}`);

const original = fs.readFileSync(SRC, 'utf8');
const originalMd5 = md5(SRC);
fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
fs.writeFileSync(BACKUP, original, 'utf8');
log(`  已备份（md5 ${originalMd5}）→ ${BACKUP}`);

let bad = 0;
let restored = false;

try {
    /* ---- 施加突变：锚点次数必须精确 ---- */
    log('\n---------- 施加三处突变 ----------');
    let mutated = original;
    for (const mu of MUTATIONS) {
        const count = mutated.split(mu.find).length - 1;
        if (count !== mu.expect) {
            log(`  [FATAL] ${mu.id} 锚点命中 ${count} 次，期望 ${mu.expect} 次 —— 源码已漂移，探针不再可信。`);
            process.exit(2);
        }
        mutated = mutated.split(mu.find).join(mu.replace);
        log(`  ${mu.id}  ${mu.desc}  （锚点命中 ${count} 次 ✓）`);
    }
    if (mutated === original) {
        log('  [FATAL] 突变后内容与原文完全相同 ⇒ 什么都没改，红绿无从谈起。');
        process.exit(2);
    }
    fs.writeFileSync(SRC, mutated, 'utf8');
    log(`  已写入突变版本（md5 ${md5(SRC)}，原文 md5 ${originalMd5}）`);

    /* ---- 第一轮：必须红 ---- */
    log('\n---------- 第一轮：突变版跑用例（期望红）----------');
    const red = runTests();
    log(`  ${red.totals.join('\n  ')}`);
    if (red.compileBroke) {
        log('\n[FATAL] 一条 surefire 汇总都没有 ⇒ 大概率是编译失败。');
        log('        编译失败不能算「报红」：它证明不了任何断言有判别力。');
        log(`        详见 ${LOG}`);
        bad = 1;
    } else {
        log(`  失败用例（${red.failed.length} 条）：`);
        red.failed.forEach((n) => log(`      ✗ ${n}`));
        if (red.failed.length === 0) {
            log('\n  [FATAL] 突变版**全绿** ⇒ 这批用例没有判别力，等于没写。');
            bad = 1;
        }
        const missing = MUST_BE_RED.filter((n) => !red.failed.includes(n));
        if (missing.length) {
            log(`\n  [FATAL] 这几条核心用例没有报红：${missing.join(', ')}`);
            log('        说明对应的那处缺陷即使改回来也拦不住 —— 判据锚错了地方。');
            bad = 1;
        } else {
            log(`\n  ✓ 三条核心用例全部报红：${MUST_BE_RED.join(', ')}`);
        }
    }

    /* ---- 还原 ---- */
    log('\n---------- 逐字节还原 ----------');
    fs.writeFileSync(SRC, original, 'utf8');
    restored = true;
    const afterMd5 = md5(SRC);
    log(`  还原后 md5 ${afterMd5}`);
    if (afterMd5 !== originalMd5) {
        log(`  [FATAL] 还原后 md5 与原文件不一致！原 ${originalMd5}`);
        bad = 1;
    } else {
        log('  ✓ 与原文件逐字节一致');
    }

    /* ---- 第二轮：必须全绿 ---- */
    log('\n---------- 第二轮：还原版跑用例（期望全绿）----------');
    const green = runTests();
    log(`  ${green.totals.join('\n  ')}`);
    if (green.compileBroke) {
        log('\n  [FATAL] 还原后没跑到测试 ⇒ 上一轮的"红"可能是环境问题而不是断言问题。');
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
    if (!restored) {
        fs.writeFileSync(SRC, original, 'utf8');
        log(`\n  （异常退出，已强制还原；md5 ${md5(SRC)}）`);
    }
}

log('\n========== 结论 ==========');
if (bad === 0) {
    log('  ⇒ 红→绿成立：三处修复各自有用例守着，改回旧写法会报红，还原后全绿。');
} else {
    log('  ⇒ 有不符项，见上文。');
}
process.exit(bad === 0 ? 0 : 1);
