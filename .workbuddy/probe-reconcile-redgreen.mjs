/**
 * 红绿探针：证明「回调丢失对账兜底」这一轮新增的判据**真的有判别力**。
 *
 * ★ 为什么必须做 ★
 * 522 条测试全绿，只能说明「当前代码满足这些断言」，不能说明「这些断言抓得住 bug」。
 * 一个恒真断言、一个锚错对象的断言，在绿灯里和真判据长得一模一样 ——
 * 而本轮**已经踩过两次锚错对象**（详见 PaymentServiceTest 里那段注释）。
 * 唯一能区分两者的办法：把**能力**去掉，看它是否报红。
 *
 * ★ 第 0 轮是对照组 ★
 * 未突变时必须全绿，而且用例数必须等于期望值。少了它就分不清
 * 「突变没报红」到底是「判据没判别力」还是「这一轮压根没跑到那条用例」——
 * 本项目已经吃过一次「跑完发现一条测试都没跑」的亏。
 *
 * ★ 六次突变，每次只移掉**一个**可观测后果 ★
 *   M1 金额闸门：对账时说「付款了」就结算，不再比金额 ⇒ 必须红 paidWithMismatchedAmountNeverSettles
 *   M2 可结算来源：把 closed 从条件更新里去掉       ⇒ 必须红 settleAcceptsClosedAsSourceStatus
 *   M3 四态语义：把「不认识的业务码」当成「确认没成」⇒ 必须红 unknownCodeIsUnavailable
 *   M4 无法识别的响应：把「缺节点/非 JSON」当成「确认没成」⇒ 必须红 两条（同一能力的两个入口）
 *   M5 接待闸门：把 closed 从可对账状态里去掉       ⇒ 必须红 两条（同一能力的两个入口）
 *   M6 候选查询：把「刚被关掉的」那一段整段去掉     ⇒ 必须红 两条
 *
 * ★ M5 与 M6 必须互不重叠 ★
 * 这一轮（closed 候选回看窗口）改的两处是「候选选得出」与「选出后进得来」，
 * 缺任何一处新能力都不成立，但症状相反（一个静默无候选、一个满屏 SKIPPED）。
 * 两轮的 mustRed 集合完全不重叠 ⇒ 证明两处改动确实各自可被单独证伪，
 * 而不是「只要拆掉任意一处，整套判据就一起红」那种分不清责任的红。
 *
 * ★ mustRed 写成**集合**：要求「恰好这些红、其余全绿」★
 * 只写一个名字时，无法区分「判据精确」与「顺手把别的也弄红了」。
 * M4 声明两个名字是因为它们本就是**同一个能力的两个入口**（缺节点 / 非 JSON），
 * 而不是把两个不相干的后果塞进一轮 —— M3 与 M4 能各自被单独证伪，这一条是可验证的：
 * 加了「缺节点」独立守卫之后，M3 只红一条（原本它会让两条一起红）。
 *
 * ★ 每轮同时点名「必须红」与「必须仍绿」★
 * 只盯报红那几条不够：把整段逻辑删掉的突变也会让它们报红，但那证明不了判据精确。
 * 所以每轮都要求：声明的用例全红 + 同批其余用例全绿 + 用例总数不缩水。
 *
 * ★ 脚本自证 ★
 *   - 突变点必须**恰好命中 1 次**（0 次或 ≥2 次直接判本轮 ERROR，不做「大概改对了」的推断）；
 *   - 还原后**逐字节**比对 sha256，不一致直接标 RESTORE-FAILED；
 *   - 还原在 finally 里，任一轮抛异常也不会把源码留在突变状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const NODE = String.raw`C:\Users\刘宝杰\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`;
const MAIN = path.join(ROOT, 'campus-secondhand-backend', 'src', 'main', 'java', 'com', 'campus', 'market');
const PAY_SERVICE = path.join(MAIN, 'service', 'PaymentService.java');
const ALIPAY = path.join(MAIN, 'service', 'pay', 'AlipaySandboxPayChannel.java');

const RUN_TESTS = 'PaymentServiceReconcileTest,PaymentServiceTest,AlipaySandboxQueryTest';
/** 16 + 13 + 15（QueryTest 的四个 @Nested）= 44（ReconcileTest 由 12 涨到 16：+4 条 closed 候选） */
const EXPECTED_TESTS = 44;

const MUTATIONS = [
  {
    id: 'M1',
    name: '金额闸门：对账时说「付款了」就结算，不再比金额',
    file: PAY_SERVICE,
    from: '|| result.paidAmount().compareTo(payment.getAmount()) != 0',
    to: '|| false /* MUTATED-M1 */',
    mustRed: ['paidWithMismatchedAmountNeverSettles'],
  },
  {
    id: 'M2',
    name: '可结算来源：把 closed 从条件更新里去掉',
    file: PAY_SERVICE,
    from: `.in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING,
                        Payment.STATUS_CLOSED)`,
    to: '.in(Payment::getStatus, Payment.STATUS_CREATED, Payment.STATUS_PAYING)',
    mustRed: ['settleAcceptsClosedAsSourceStatus'],
  },
  {
    id: 'M3',
    name: '四态语义：把「不认识的业务码」当成「确认没成」',
    file: ALIPAY,
    from: '        return QueryResult.unavailable("支付宝查单返回 code=" + code + " sub_code=" + subCode);',
    to: '        return new QueryResult(QueryOutcome.NOT_PAID, outTradeNo, null, null, null, "MUTATED-M3");',
    mustRed: ['unknownCodeIsUnavailable'],
  },
  {
    id: 'M4',
    name: '无法识别的响应：把「缺节点 / 非 JSON」当成「确认没成」',
    file: ALIPAY,
    from: `        if (node == null || node.isMissingNode()) {
            return QueryResult.unavailable("支付宝查单响应缺少 " + RESP_QUERY + " 节点");
        }`,
    to: `        if (node == null || node.isMissingNode()) {
            return new QueryResult(QueryOutcome.NOT_PAID, outTradeNo, null, null, null, "MUTATED-M4");
        }`,
    // 同一个能力的两个入口，都是「无法识别的响应绝不能被当成业务结论」
    mustRed: ['missingNodeIsUnavailable', 'malformedBodyIsUnavailable'],
  },
  /*
   * ★ 下面两轮（M5/M6）补的是 2026-09-24 新增的「closed 候选回看窗口」★
   * 这一轮改了两处**互相独立**的代码：候选查询多了一段、接待闸门放宽了一档。
   * 两处缺任何一处，新能力都不成立，但**症状完全不同**：
   *   - 缺候选（M6）：整条路径静默失效，一笔都不会被问 —— 不报错、不打日志；
   *   - 缺闸门（M5）：候选选出来了，但每一笔都在发请求之前被跳过 —— 日志里只有 SKIPPED。
   * 所以必须各自能被单独证伪，否则「一起删掉」和「只删一处」在红灯里长得一样。
   * M5 与 M6 的 mustRed 完全不重叠，且彼此互为对方的 mustStayGreen 对照组。
   */
  {
    id: 'M5',
    name: '接待闸门：把 closed 从「可对账状态」里去掉（候选照选，但一笔都进不来）',
    file: PAY_SERVICE,
    from: `        if (!Payment.STATUS_PAYING.equals(payment.getStatus())
                && !Payment.STATUS_CLOSED.equals(payment.getStatus())) {`,
    to: '        if (!Payment.STATUS_PAYING.equals(payment.getStatus())) {',
    // 同一个能力的两个入口：确认收款 → 结算退钱；渠道说没成 → 一毫不改
    mustRed: ['closedPaymentIsReconciledThenAutoRefunded',
      'closedPaymentChannelSaysUnpaidIsLeftUntouched'],
  },
  {
    id: 'M6',
    name: '候选查询：把「刚被关掉的」那一段整段去掉（闸门放宽了，但永远没人被送来）',
    file: PAY_SERVICE,
    from: `        List<Payment> justClosed = paymentMapper.selectList(new LambdaQueryWrapper<Payment>()
                .eq(Payment::getStatus, Payment.STATUS_CLOSED)
                .ge(Payment::getUpdateTime, closedAfter)
                .orderByAsc(Payment::getUpdateTime)
                .last("LIMIT " + limit));`,
    to: '        List<Payment> justClosed = List.of(); /* MUTATED-M6 */',
    mustRed: ['candidateQueriesCarryBothTimeWindows', 'justClosedCandidatesComeFirst'],
  },
];

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/*
 * ★★★ 断点自愈：突变**不能**依赖「脚本一定会跑完」★★★
 *
 * 还原写在 finally 里，只能覆盖「进程正常走完或抛出异常」。它**覆盖不了**
 * 「进程被 SIGTERM / 超时 / 关窗口杀掉」—— 那种情况下突变就留在源码里了。
 * 更坏的是：它看起来完全正常。M1/M3/M4/M6 会留下 MUTATED 字样还能被 grep 到，
 * 而 **M2 与 M5 只是把一段条件改窄/去掉，没有任何标记** ——
 * 肉眼看 diff 都未必反应过来，而后果是资金路径变窄。
 *
 * 本项目 2026-09-24 真的踩了一次：一条命令里误带了一次重跑，它被 shell 结束时的
 * SIGTERM 打断，恰好停在 M2 中间 —— settle 的条件更新里 STATUS_CLOSED 被摘掉，
 * 而当时只有 git diff 能看出来。
 *
 * 所以：开跑前先把原始字节留底到 .redgreen-backup/；发现上次留下的备份
 * （= 上次没跑完）就**先无条件还原再继续**；只有完整跑完才删掉备份。
 * 这样任何一次被打断，都会在下一次运行时自愈，而不是静静地把突变留在仓库里。
 */
const BACKUP_DIR = path.join(ROOT, '.workbuddy', '.redgreen-backup');
const backupOf = (f) => path.join(BACKUP_DIR, path.basename(f) + '.bak');
const MUTATED_FILES = [...new Set(MUTATIONS.map((m) => m.file))];

fs.mkdirSync(BACKUP_DIR, { recursive: true });
for (const f of MUTATED_FILES) {
  const bp = backupOf(f);
  if (fs.existsSync(bp)) {
    const pristine = fs.readFileSync(bp, 'utf8');
    if (fs.readFileSync(f, 'utf8') !== pristine) {
      fs.writeFileSync(f, pristine, 'utf8');
      console.log(`[self-heal] 上次运行未走完，已还原 ${path.basename(f)}`);
    } else {
      console.log(`[self-heal] 上次运行未走完，但 ${path.basename(f)} 与留底一致（无需还原）`);
    }
    fs.unlinkSync(bp);
  }
  fs.copyFileSync(f, backupOf(f));
}
/** 本轮结束时各文件的原始字节，用于全局还原校验 */
const PRISTINE_HASH = Object.fromEntries(MUTATED_FILES.map((f) => [f, sha(f)]));

function runTests(logName) {
  execFileSync(NODE,
    [path.join(ROOT, '.workbuddy', 'run-mvn.mjs'), 'test', `-Dtest=${RUN_TESTS}`, '-DfailIfNoTests=false'],
    { cwd: ROOT, env: { ...process.env, MVN_LOG: logName }, stdio: 'ignore' });
  return fs.readFileSync(path.join(ROOT, '.workbuddy', logName), 'utf8');
}

function parse(log) {
  const failed = [...log.matchAll(/\[ERROR\]\s+([A-Za-z0-9_$]+)\.([A-Za-z0-9_]+):\d+/g)]
    .map((m) => m[2]);
  const totals = [...log.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)/g)].pop();
  return {
    failed: [...new Set(failed)],
    total: totals ? +totals[1] : -1,
    failures: totals ? +totals[2] : -1,
    errors: totals ? +totals[3] : -1,
    built: /BUILD SUCCESS/.test(log) ? 'SUCCESS' : (/BUILD FAILURE/.test(log) ? 'FAILURE' : '?'),
  };
}

const report = [];

/* ---------- 第 0 轮：对照组（未突变，必须全绿且用例数齐全） ---------- */
{
  const p = parse(runTests('redgreen-M0-baseline.log'));
  const ok = p.total === EXPECTED_TESTS && p.failures === 0 && p.errors === 0;
  report.push({
    id: 'M0', name: '对照组：未突变必须全绿、且用例数齐全',
    expectedTests: EXPECTED_TESTS, actualTests: p.total,
    counts: `failures=${p.failures} errors=${p.errors} build=${p.built}`,
    verdict: ok ? 'PASS' : 'FAIL',
  });
}

/* ---------- 六次突变 ---------- */
for (const m of MUTATIONS) {
  const originalSrc = fs.readFileSync(m.file, 'utf8');
  const originalHash = sha(m.file);
  const hits = originalSrc.split(m.from).length - 1;
  if (hits !== 1) {
    report.push({ id: m.id, name: m.name, verdict: 'ERROR', error: `突变点命中 ${hits} 次（必须恰好 1 次）` });
    continue;
  }

  fs.writeFileSync(m.file, originalSrc.split(m.from).join(m.to), 'utf8');
  let result;
  try {
    const p = parse(runTests(`redgreen-${m.id}.log`));
    const expected = m.mustRed;
    // 该红没红 = 判据没有判别力（最危险）；不该红却红了 = 突变波及了别处（说不出结论）
    const missingRed = expected.filter((x) => !p.failed.includes(x));
    const unexpectedRed = p.failed.filter((x) => !expected.includes(x));
    result = {
      id: m.id,
      name: m.name,
      mustRed: expected,
      redAsExpected: expected.filter((x) => p.failed.includes(x)),
      missingRed,
      unexpectedRed,
      counts: `total=${p.total} failures=${p.failures} errors=${p.errors} build=${p.built}`,
      verdict: missingRed.length === 0 && unexpectedRed.length === 0 && p.total === EXPECTED_TESTS
        ? 'PASS' : 'FAIL',
    };
  } catch (e) {
    result = { id: m.id, name: m.name, mustRed: m.mustRed, verdict: 'ERROR', error: e.message };
  } finally {
    fs.writeFileSync(m.file, originalSrc, 'utf8');
  }
  if (sha(m.file) !== originalHash) {
    result.verdict = 'RESTORE-FAILED';
    result.error = '还原后源码 sha256 不一致 —— 必须人工检查！';
  }
  report.push(result);
}

/*
 * ★ 全局还原校验：逐个文件比对本轮开跑前留下的原始哈希 ★
 * 单轮内的 sha 校验只能证明「那一轮还原得对」；这里再证明「整轮跑完以后
 * 三份源码都回到了出发时的字节」。两者都过才敢说「源码没有被留在突变状态」。
 */
const restored = MUTATED_FILES.filter((f) => sha(f) !== PRISTINE_HASH[f]);
if (restored.length > 0) {
  report.push({
    id: 'RESTORE', name: '全局还原校验：所有被突变过的源码必须回到出发字节',
    verdict: 'RESTORE-FAILED',
    error: '未还原的文件：' + restored.map((f) => path.basename(f)).join(', '),
  });
} else if (!report.some((r) => r.verdict === 'RESTORE-FAILED')) {
  // 全部走完才删备份；中途被杀时备份会留下，供下一次运行自愈
  for (const f of MUTATED_FILES) {
    if (fs.existsSync(backupOf(f))) fs.unlinkSync(backupOf(f));
  }
  report.push({
    id: 'RESTORE', name: '全局还原校验：所有被突变过的源码必须回到出发字节',
    files: MUTATED_FILES.map((f) => path.basename(f)),
    verdict: 'PASS',
  });
}

console.log(JSON.stringify(report, null, 2));
const allPass = report.every((r) => r.verdict === 'PASS');
console.log(allPass ? '\nREDGREEN ALL PASS' : '\nREDGREEN HAS FAILURE');
process.exit(allPass ? 0 : 1);
