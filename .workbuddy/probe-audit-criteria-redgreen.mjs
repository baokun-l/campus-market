/**
 * 审计判据「红绿」全量探针 —— 证明 audit-deploy-gap.mjs 的 27 条判据真的有判别力
 *
 * 背景：审计脚本自己也会撒谎（本仓已抓到 9 种形态）。一条恒真的判据 = 一条注释。
 *       做法：把**代码变回旧实现**（能力被移除），要求**那条判据必须报红**，
 *       同时点名「其余判据必须仍绿」——防止「一改就全红」式的掩盖。
 *
 * 纪律（逐条落实）：
 *   ① 一轮只验证一个可观测后果；同一 key 被两条判据共用时，如实声明两条都红＝引用耦合
 *   ② 变异必须是**真实旧实现**，不是「删一行让它编译不过」
 *   ③ 自证：锚点必须在文件里**恰好出现声明次数**，否则整轮结论作废（退出码 2）
 *   ④ 还原：先写回原内容、再还原移动，逐文件 sha256 比对；**任何 infra 退出都发生在还原之后**
 *   ⑤ 对照组：① 纯注释变异必须不翻转；② 无关配置改值必须不翻转；③ 判定函数自测
 *   ⑥ 解析只吃本次运行的 stdout；先剥 ANSI；用「与基线同一图标位」判状态，不依赖 emoji 编码
 *   ⑦ 退出码三态：0 = 全部符合预期；1 = 判据有缺陷（该红没红 / 不该红却红）；2 = 脚本或环境坏了
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const AUDIT = path.join(ROOT, '.workbuddy', 'audit-deploy-gap.mjs');
const A = (p) => path.join(ROOT, p);
const EXPECTED_CRITERIA = 27;

const BE = 'campus-secondhand-backend';
const FE = 'campus-secondhand-frontend';
const J = (sub) => `${BE}/src/main/java/com/campus/market/${sub}`;

const F = {
    prod: `${BE}/src/main/resources/application-prod.yml`,
    appyml: `${BE}/src/main/resources/application.yml`,
    logback: `${BE}/src/main/resources/logback-spring.xml`,
    pom: `${BE}/pom.xml`,
    guard: J('config/DeploymentGuard.java'),
    build: `${BE}/deploy/build-release.mjs`,
    healthCtl: J('controller/HealthController.java'),
    trace: J('config/RequestTraceFilter.java'),
    uploadCtl: J('controller/UploadController.java'),
    userSvc: J('service/UserService.java'),
    aiSvc: J('service/AiAssistantService.java'),
    cookie: J('security/AuthCookie.java'),
    gitignore: `${BE}/.gitignore`,
    fePkg: `${FE}/package.json`,
    feVite: `${FE}/vite.config.ts`,
    feLock: `${FE}/package-lock.json`,
    mvnw: `${BE}/mvnw`,
    serviceFile: `${BE}/deploy/campus-market.service`,
    loginGuard: J('security/LoginAttemptGuard.java'),
};

const hashOf = (t) => createHash('sha256').update(t).digest('hex');
const sha = (p) => createHash('sha256').update(fs.readFileSync(A(p))).digest('hex');
const readF = (p) => fs.readFileSync(A(p), 'utf8');
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

/* ---------------- 变异原语 ---------------- */
const edit = (file, from, to, count = 1) => ({ kind: 'edit', file, from, to, count });
const move = (file) => ({ kind: 'move', file, to: file + '.redgreen-bak' });
const scrub = (file, re, to) => ({ kind: 'scrub', file, re, to });

/* ---------------- 轮次表 ---------------- */
const ROUNDS = [
    { n: 'R01', crit: 'P0-1', expect: 'flip', mustFlip: ['P0-1', 'P1-8'],
      why: 'prod 的 sql.init.mode 改回 always（原缺陷：生产会灌弱口令种子）',
      muts: [edit(F.prod, 'mode: ${SQL_INIT_MODE:never}', 'mode: ${SQL_INIT_MODE:always}')],
      note: '引用耦合：P0-1 与 P1-8 读同一 key，必然同时红（≠ 错了两个能力）' },

    { n: 'R02', crit: 'P0-2', expect: 'flip', mustFlip: ['P0-2'],
      why: '删掉 DeploymentGuard 的 RESET_CONFIRMED_KEY 常量（能力：demo 必须显式确认）',
      muts: [edit(F.guard, '    public static final String RESET_CONFIRMED_KEY = "app.demo.reset-confirmed";', '')] },

    { n: 'R03', crit: 'P0-2b', expect: 'flip', mustFlip: ['P0-2b'],
      why: '删掉 pom 里对 db/demo-*.sql 的打包排除（第二层物理剔除失效）',
      muts: [edit(F.pom, '                            <exclude>db/demo-*.sql</exclude>\n', '')] },

    { n: 'R04', crit: 'P0-3', expect: 'flip', mustFlip: ['P0-1', 'P0-3'],
      why: 'JWT 密钥写死成默认值（原缺陷：生产用弱密钥）',
      muts: [edit(F.prod, 'secret: ${JWT_SECRET}', 'secret: campus-default-secret')],
      note: '引用耦合：P0-1「prod profile 收口」同时要求 mode=never 与 secret 为必需占位符 ⇒ 本变异两条一起红' },

    { n: 'R05', crit: 'P0-4', expect: 'flip', mustFlip: ['P0-4'],
      why: '去掉 forward-headers-strategy（反代后拿不到真实客户端信息）',
      muts: [edit(F.prod, 'forward-headers-strategy: framework', '# (red-green：forward-headers 处理已移除)')] },

    { n: 'R06', crit: 'P0-5', expect: 'flip', mustFlip: ['P0-5'],
      why: '去掉 hikari 连接级时区设置（跨源时区会让「在线」整体静默失效）',
      muts: [edit(F.prod, "connection-init-sql: SET time_zone = '${app.time-zone-offset:+08:00}'",
          '# (red-green：连接级时区设置已移除)')] },

    { n: 'R07', crit: 'P0-6', expect: 'flip', mustFlip: ['P0-6'],
      why: '把 mvnw 移走（服务器无法再用 wrapper 构建）',
      muts: [move(F.mvnw)] },

    { n: 'R08', crit: 'P0-7', expect: 'flip', mustFlip: ['P0-7'],
      why: '删掉发版脚本里「产物含 demo 资源即拒产出」的 assert（真正的闸门）',
      muts: [edit(F.build, "assert(demoRes.length === 0, '产物里仍有 demo 资源：检查是否真的带了 -Pprod');\n", '')],
      probe: '若仍绿 ⇒ 判据只认一句日志文案，根本没看闸门在不在' },

    { n: 'R09', crit: 'P0-7', expect: 'noflip', mustFlip: [],
      why: '只改日志文案（「demo 资源（必须 0）」→「demo 资源统计」），语义零变化',
      muts: [edit(F.build, 'demo 资源（必须 0）', 'demo 资源统计')],
      note: '同一变异在判据修复**前**报红（锚文案）、修复**后**必须不翻转 ⇒ 这条同时是修复有效性的证据' },

    { n: 'R10', crit: 'P0-8', expect: 'flip', mustFlip: ['P0-8'],
      why: '移除日志保留策略 maxHistory（两处策略各一份，须同时移除才算真拿掉）',
      muts: [edit(F.logback, '<maxHistory>30</maxHistory>', '', 2)] },

    { n: 'R11', crit: 'P0-9', expect: 'flip', mustFlip: ['P0-9'],
      why: 'mapper 日志调回 debug（生产会回显 SQL）',
      muts: [edit(F.prod, 'com.campus.market.mapper: info', 'com.campus.market.mapper: debug')] },

    { n: 'R12', crit: 'P0-10', expect: 'flip', mustFlip: ['P0-10'],
      why: '让应用绑回 0.0.0.0（原来只绑回环，反代之外不可达）',
      muts: [edit(F.prod, '${SERVER_ADDRESS:127.0.0.1}', '${SERVER_ADDRESS:0.0.0.0}')] },

    { n: 'R13', crit: 'P1-1', expect: 'flip', mustFlip: ['P1-1'],
      why: 'JDBC URL 带回 createDatabaseIfNotExist（生产账号不该有建库权限）',
      muts: [edit(F.prod, 'url: ${DB_URL}', 'url: ${DB_URL}?createDatabaseIfNotExist=true')] },

    { n: 'R14', crit: 'P1-3', expect: 'flip', mustFlip: ['P1-3'],
      why: '发版产物命名去掉版本号（版本化溯源能力被移除）',
      muts: [edit(F.build, 'campus-market-${version}-${rev}-${stamp}.jar', 'campus-market-${rev}-${stamp}.jar')] },

    { n: 'R15', crit: 'P1-4', expect: 'flip', mustFlip: ['P1-4'],
      why: '把 systemd 单元文件移走（部署载体缺失）',
      muts: [move(F.serviceFile)] },

    { n: 'R16', crit: 'P1-5', expect: 'flip', mustFlip: ['P1-5'],
      why: '健康端点路径改成 /healthz（监控按 /health 探测会全挂）',
      muts: [edit(F.healthCtl, '@GetMapping("/health")', '@GetMapping("/healthz")')] },

    { n: 'R17', crit: 'P1-6', expect: 'flip', mustFlip: ['P1-6'],
      why: '删掉 finally 里的 MDC.clear()（原缺陷：线程复用会顶着上一个请求的身份）',
      muts: [edit(F.trace, '            MDC.clear();\n', '')] },

    { n: 'R18', crit: 'P1-7', expect: 'flip', mustFlip: ['P1-7'],
      why: '把 LoginAttemptGuard 移走（登录不再有失败次数闸门）',
      muts: [move(F.loginGuard)] },

    { n: 'R19', crit: 'P1-10', expect: 'flip', mustFlip: ['P1-10'],
      why: '注释掉上传接口里的闸门调用（闸门类还在，但没接上线）',
      muts: [edit(F.uploadCtl, '        uploadQuotaGuard.acquire(currentUserId(request));',
          '        // red-green：闸门未接线')] },

    { n: 'R20', crit: 'P1-11', expect: 'flip', mustFlip: ['P1-11'],
      why: '删掉一处鉴权缓存显式失效（失效点 5 → 4，D11 拆除后阈值已 6→5，账本三十一）',
      muts: [edit(F.userSvc, '        authSnapshotCache.invalidate(userId);', '        // red-green：显式失效被移除')] },

    { n: 'R21', crit: 'P1-12', expect: 'flip', mustFlip: ['P1-12'],
      why: 'tomcat 线程数拉到连接池的 20 倍（线程/池配套关系被破坏）',
      muts: [edit(F.prod, 'max-threads: ${TOMCAT_MAX_THREADS:50}', 'max-threads: ${TOMCAT_MAX_THREADS:200}')] },

    { n: 'R22', crit: 'P2-2', expect: 'flip', mustFlip: ['P2-2'],
      why: '删掉前端 package.json 的 engines 约束（本仓无 .nvmrc，engines 是唯一约束来源）',
      muts: [edit(F.fePkg,
          '    "@vitest/coverage-v8": "^1.6.0"\n  },\n  "engines": {\n    "node": ">=18.19.0"\n  }\n}',
          '    "@vitest/coverage-v8": "^1.6.0"\n  }\n}')] },

    { n: 'R23', crit: 'P2-3', expect: 'flip', mustFlip: ['P2-3'],
      why: '把打包 base 写死成 /（不再由环境变量驱动 ⇒ 子路径部署失效）',
      muts: [edit(F.feVite, "base: env.VITE_BASE || '/',", "base: '/',")] },

    { n: 'R24', crit: 'P2-4', expect: 'flip', mustFlip: ['P2-4'],
      why: '应用层图片上限 2MB → 3MB（三层口径不再一致）',
      muts: [edit(F.appyml, 'max-image-bytes: ${UPLOAD_MAX_IMAGE_BYTES:2097152}',
          'max-image-bytes: ${UPLOAD_MAX_IMAGE_BYTES:3145728}')] },

    { n: 'R25', crit: 'P2-6', expect: 'flip', mustFlip: ['P2-6'],
      why: '删掉 .gitignore 里 uploads/ 这条规则行（注释里仍留 uploads 字样）',
      muts: [edit(F.gitignore, '\nuploads/\n\n# ---------- 日志 ----------', '\n\n# ---------- 日志 ----------')],
      probe: '若仍绿 ⇒ 判据的「.gitignore 含 uploads」被**注释**满足，等于没查规则' },

    { n: 'R26', crit: 'P2-6', expect: 'flip', mustFlip: ['P2-6'],
      why: '把 .gitignore 里所有 uploads 字样一并清掉（证明该判据不是恒真，只是太宽）',
      muts: [scrub(F.gitignore, /uploads/g, 'uploadz')] },

    { n: 'R27', crit: 'L9', expect: 'flip', mustFlip: ['L9'],
      why: '删掉对话入口的额度闸门调用（调模型 2 处、过闸只剩 1 处）',
      muts: [edit(F.aiSvc, '        quotaGuard.acquire(userId);\n\n        String userContent = fenced(message);',
          '        String userContent = fenced(message);')] },

    { n: 'R28', crit: 'D9', expect: 'flip', mustFlip: ['D9'],
      why: '把**下发**那一支的 HttpOnly 改成 false（D9 的安全收益被整体抹掉）',
      muts: [edit(F.cookie, 'ResponseCookie.from(NAME, token)\n                .httpOnly(true)',
          'ResponseCookie.from(NAME, token)\n                .httpOnly(false)')] },

    // ★ 第 29 轮：判据名写着「.nvmrc / npm ci」，但实现只查 `.nvmrc || engines`。
    //   `npm ci` 的前提是**有 lockfile**；把 lockfile 拿走，`npm ci` 直接失败。
    //   本轮先取证：若这一轮**不报红**，说明「npm ci」这半条判据根本不存在。
    { n: 'R29', crit: 'P2-2', expect: 'flip', mustFlip: ['P2-2'],
      why: '把 package-lock.json 移走（`npm ci` 没了 lockfile 直接失败）',
      muts: [move(F.feLock)],
      probe: '若仍绿 ⇒ 判据名里的「npm ci」是空的：它只查 .nvmrc/engines，从不看 lockfile' },

    /* ---------------- 对照组 ---------------- */
    { n: 'C01', crit: '对照组', expect: 'noflip', mustFlip: [],
      why: '纯注释变异（给 HealthController 加一行注释）——必须**不**翻转',
      muts: [edit(F.healthCtl, '@GetMapping("/health")', '// red-green control：纯注释\n    @GetMapping("/health")')] },

    { n: 'C02', crit: '对照组', expect: 'noflip', mustFlip: [],
      why: '改一个无判据依赖的配置值（prod 日志目录）——必须**不**翻转',
      muts: [edit(F.prod, 'log-dir: ${LOG_DIR:/data/campus/logs}', 'log-dir: ${LOG_DIR:/data/campus/logs2}')] },
];

/* ---------------- 运行审计并解析 ---------------- */
function runAudit() {
    let out = '';
    try {
        out = execFileSync(process.execPath, [AUDIT], { encoding: 'utf8', cwd: ROOT });
    } catch (e) {
        if (e.status === 2) out = String(e.stdout || '') + String(e.stderr || '');
        else throw new Error(`审计脚本运行失败（status=${e.status}）：${e.message}`);
    }
    out = stripAnsi(out);
    const rows = new Map();
    for (const line of out.split(/\r?\n/)) {
        const t = line.trim().split(/\s+/);
        if (t.length >= 3 && /^[A-Z]\d/.test(t[1])) rows.set(t[1], t[0]);
    }
    const last = out.split(/\r?\n/).filter((l) => /合计/.test(l)).pop() || '';
    const nums = [...last.matchAll(/\d+/g)].map((m) => Number(m[0]));
    return { out, rows, nums };
}

/* ---------------- 判定与自测 ---------------- */
function verdictOf(expect, mustFlip, flipped) {
    const set = new Set(flipped);
    if (expect === 'flip') {
        const missing = mustFlip.filter((id) => !set.has(id));
        if (missing.length) return { kind: 'DEFECT', detail: `该红没红：${missing.join(',')}` };
        const extra = [...set].filter((id) => !mustFlip.includes(id));
        if (extra.length) return { kind: 'COUPLED', detail: `额外翻转：${extra.join(',')}` };
        return { kind: 'OK', detail: '' };
    }
    return set.size ? { kind: 'DEFECT', detail: `不该红却红：${[...set].join(',')}` } : { kind: 'OK', detail: '' };
}

const hardFail = (m) => { console.error('[INFRA] ' + m); process.exit(2); };

/* ★ 对照组③：判定函数自测 —— 它若把「该红没红」判成 OK，整套探针都是装饰品 */
{
    const t1 = verdictOf('flip', ['P0-1'], []);
    const t2 = verdictOf('flip', ['P0-1'], ['P0-1']);
    const t3 = verdictOf('noflip', [], ['P0-9']);
    const t4 = verdictOf('flip', ['P0-1'], ['P0-1', 'P1-8']); // 额外翻转 → COUPLED（不算缺陷）
    if (t1.kind !== 'DEFECT' || t2.kind !== 'OK' || t3.kind !== 'DEFECT' || t4.kind !== 'COUPLED') {
        hardFail('判定函数自测失败：探针本身没有判别力，立即停止（此前结论一律作废）');
    }
    console.log('[C03] 判定函数自测通过：该红没红→DEFECT · 红到位→OK · 不该红却红→DEFECT · 额外红→COUPLED');
}

/* ---------------- 基线 ---------------- */
let base;
try { base = runAudit(); } catch (e) { hardFail(e.message); }
if (base.rows.size !== EXPECTED_CRITERIA) hardFail(`基线判据条数为 ${base.rows.size}，应为 ${EXPECTED_CRITERIA}`);
const doneIcon = base.rows.get('P0-1');
const notDone = [...base.rows.entries()].filter(([, v]) => v !== doneIcon);
if (notDone.length) hardFail(`基线并非全绿（${notDone.map(([k]) => k).join(',')}）—— 先修好再看红绿，否则红绿无意义`);
console.log(`[基线] ${base.rows.size} 条判据全绿（未完成 ${base.nums[2]}，无法判定 ${base.nums[3]}）\n`);

/* ---------------- 逐轮变异（任何 infra 退出都发生在还原之后） ---------------- */
let exitCode = 0;
const findings = [];

for (const r of ROUNDS) {
    const orig = new Map();   // file -> 原内容
    const moves = [];
    let infraMsg = null;
    let result = null;

    try {
        for (const m of r.muts) {
            const abs = A(m.file);
            if (m.kind === 'move') {
                if (!fs.existsSync(abs)) throw new Error(`${r.n}: 待移动文件不存在 ${m.file}`);
                if (fs.existsSync(A(m.to))) throw new Error(`${r.n}: 目标名已存在，无法安全移动 ${m.to}`);
                fs.renameSync(abs, A(m.to));
                moves.push(m);
                continue;
            }
            if (!fs.existsSync(abs)) throw new Error(`${r.n}: 文件不存在 ${m.file}`);
            if (!orig.has(m.file)) orig.set(m.file, readF(m.file));
            let text = readF(m.file);
            if (m.kind === 'edit') {
                const hits = text.split(m.from).length - 1;
                if (hits !== m.count) {
                    throw new Error(`${r.n}: 自证失败 —— 锚点在 ${m.file} 命中 ${hits} 次，声明 ${m.count} 次。` +
                        `变异未生效，本轮结论作废`);
                }
                text = m.count === 1 ? text.replace(m.from, m.to) : text.split(m.from).join(m.to);
            } else if (m.kind === 'scrub') {
                const hits = (text.match(m.re) || []).length;
                if (hits === 0) throw new Error(`${r.n}: scrub 锚点零命中（${m.re}）`);
                text = text.replace(m.re, m.to);
            }
            fs.writeFileSync(abs, text, 'utf8');
        }

        const run = runAudit();
        if (run.rows.size !== base.rows.size) {
            throw new Error(`${r.n}: 变异后判据条数 ${run.rows.size} ≠ 基线 ${base.rows.size}（解析或脚本坏了）`);
        }
        const flipped = [...run.rows].filter(([id, icon]) => icon !== doneIcon).map(([id]) => id);
        const v = verdictOf(r.expect, r.mustFlip, flipped);
        result = { ...r, flipped, verdict: v, evSample: [...run.rows].find(([id]) => id === r.crit)?.[1] };

        if (v.kind === 'DEFECT') findings.push({ n: r.n, crit: r.crit, ...v, why: r.why, probe: r.probe });
        const tag = v.kind === 'OK' ? 'OK  ' : v.kind;
        console.log(`[${tag}] ${r.n} (${r.crit}) 翻转=[${flipped.join(',') || '-'}]` +
            (v.detail ? `  ← ${v.detail}` : '') + `\n        变异：${r.why}`);
    } catch (e) {
        infraMsg = e.message;
    } finally {
        for (const [file, text] of orig) fs.writeFileSync(A(file), text, 'utf8');
        for (const m of moves) if (fs.existsSync(A(m.to))) fs.renameSync(A(m.to), A(m.file));
        for (const [file, text] of orig) {
            if (sha(file) !== hashOf(text)) { infraMsg = `${r.n}: 还原后字节不一致：${file}`; }
        }
        for (const m of moves) {
            if (!fs.existsSync(A(m.file))) infraMsg = `${r.n}: 移动未还原：${m.file}`;
        }
    }
    if (infraMsg) { console.error('[INFRA] ' + infraMsg); process.exit(2); }
    if (r.note) console.log(`        ★ ${r.note}`);
}

/* ---------------- 收尾：复原后再跑一次，必须仍全绿 ---------------- */
try {
    const after = runAudit();
    if (after.rows.size !== EXPECTED_CRITERIA || [...after.rows.values()].some((v) => v !== doneIcon)) {
        hardFail('收尾复核失败：全部还原后判据不再全绿 —— 工作区已被污染，立即停下人工检查');
    }
    console.log(`\n[收尾] 全部还原后复跑：${after.rows.size} 条判据仍全绿（未完成 ${after.nums[2]}，无法判定 ${after.nums[3]}）`);
} catch (e) { hardFail(e.message); }

console.log('');
if (findings.length) {
    console.log(`=== 发现判据缺陷 ${findings.length} 项 ===`);
    for (const f of findings) {
        console.log(`· ${f.n}（${f.crit}）${f.kind}：${f.detail}`);
        console.log(`  变异：${f.why}`);
        if (f.probe) console.log(`  含义：${f.probe}`);
    }
    exitCode = 1;
} else {
    console.log(`=== ${ROUNDS.length} 轮全部符合预期 ===`);
}
process.exit(exitCode);
