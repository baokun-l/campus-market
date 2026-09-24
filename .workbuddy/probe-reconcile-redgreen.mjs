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
 * ★ 四次突变，每次只移掉**一个**可观测后果 ★
 *   M1 金额闸门：对账时说「付款了」就结算，不再比金额 ⇒ 必须红 paidWithMismatchedAmountNeverSettles
 *   M2 可结算来源：把 closed 从条件更新里去掉       ⇒ 必须红 settleAcceptsClosedAsSourceStatus
 *   M3 四态语义：把「不认识的业务码」当成「确认没成」⇒ 必须红 unknownCodeIsUnavailable
 *   M4 无法识别的响应：把「缺节点/非 JSON」当成「确认没成」⇒ 必须红 两条（同一能力的两个入口）
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
/** 12 + 13 + 15（QueryTest 的四个 @Nested）= 40。用例数不对说明这一轮没跑到该跑的东西 */
const EXPECTED_TESTS = 40;

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
];

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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

/* ---------- 三次突变 ---------- */
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

console.log(JSON.stringify(report, null, 2));
const allPass = report.every((r) => r.verdict === 'PASS');
console.log(allPass ? '\nREDGREEN ALL PASS' : '\nREDGREEN HAS FAILURE');
