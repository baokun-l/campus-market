/**
 * 红绿探针：证明新写的支付用例**真的有判别力**。
 *
 * 铁律：只报「绿」不算证明，必须报出「红→绿」。
 * 做法：把被测的那一道闸临时改成 `if (false)`，指定单条用例跑，必须 FAIL；
 *       还原后再跑必须 PASS，且还原要逐字节校验（md5）。
 *
 * ★ 脚本本身也要自证（否则 "脚本撒谎" 比用例没用更糟）：
 *   ① 锚点必须恰好命中 1 次；
 *   ② 每次跑分都必须真的执行了 ≥1 条用例（"Tests run: 0" 视为 ERROR）；
 *   ③ 结果只能由 surefire 的 Failures/Errors 计数判定，不看退出码。
 *
 * 三个探针 = 这次支付改造的三条命脉：
 *   ① 金额校验（少一分也不结算）
 *   ② 结算幂等（重复回调不重复推进订单）
 *   ③ app_id 比对（别的商户的合法报文不能推进我们的订单）
 *
 * 退出码：0 = 三个探针都成功报出「红→绿」；2 = 编译失败 / 没跑用例 / 没报红
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)';
const MVN = 'D:/apache-maven-3.9.4/bin/mvn.cmd';
const LOG = `${ROOT}/.workbuddy/tmp-probe.log`;

const PAY_SVC = `${ROOT}/campus-secondhand-backend/src/main/java/com/campus/market/service/PaymentService.java`;
const ALIPAY = `${ROOT}/campus-secondhand-backend/src/main/java/com/campus/market/service/pay/AlipaySandboxPayChannel.java`;

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

/** 跑一条指定用例，返回 PASS / FAIL / ERROR（ERROR = 没跑起来或没跑到用例） */
function runOne(spec) {
  const r = spawnSync(MVN, ['-o', '-s', '.workbuddy/mvn-aliyun-settings.xml',
    `-Dtest=${spec}`, '-DfailIfNoSpecifiedTests=false', 'test',
    '-f', 'campus-secondhand-backend/pom.xml'],
    // Windows 下 mvn 是 .cmd，必须走 shell，否则 spawnSync 直接 ENOENT 且什么输出都没有
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true });
  const out = ((r.stdout || '') + (r.stderr || '') + (r.error ? 'SPAWN ERROR: ' + r.error.message : ''));
  writeFileSync(LOG, out, 'utf8');

  const runs = [...out.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/g)];
  if (runs.length === 0) {
    return { verdict: 'ERROR', why: 'surefire 没有输出任何 "Tests run"（多半是编译失败）' };
  }
  const total = runs.reduce((s, m) => s + Number(m[1]), 0);
  const bad = runs.reduce((s, m) => s + Number(m[2]) + Number(m[3]), 0);
  if (total === 0) {
    return { verdict: 'ERROR', why: 'Tests run: 0 —— 用例名没匹配上，等于什么都没证明' };
  }
  return { verdict: bad > 0 ? 'FAIL' : 'PASS', why: `run=${total} bad=${bad}` };
}

/** 单次替换；锚点必须恰好命中 1 次，否则退出码 2（防「改了个寂寞」） */
function patchOnce(file, from, to) {
  const src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) {
    console.error(`[probe] 锚点命中 ${n} 次（期望 1）：${JSON.stringify(from.slice(0, 70))}…`);
    process.exit(2);
  }
  writeFileSync(file, src.replace(from, to), 'utf8');
}

const probes = [
  {
    name: '① 金额校验：回调金额与支付单不符必须拒绝',
    file: PAY_SVC,
    from: `        if (notify.paidAmount() == null
                || notify.paidAmount().compareTo(payment.getAmount()) != 0) {`,
    to: `        if (false) {`,
    test: 'PaymentServiceTest#amountMismatchIsRejected',
  },
  {
    name: '② 结算幂等：重复回调不能重复推进订单',
    file: PAY_SVC,
    from: `        if (affected == 0) {
            log.info("[pay] settlement skipped (already terminal) paymentId={} status={}",`,
    to: `        if (false) {
            log.info("[pay] settlement skipped (already terminal) paymentId={} status={}",`,
    test: 'PaymentServiceTest#settleIsIdempotent',
  },
  {
    name: '③ app_id 比对：别的商户的合法报文不能推进我们的订单',
    file: ALIPAY,
    from: `        if (!props.getAlipayAppId().equals(appId)) {`,
    to: `        if (false) {`,
    test: 'AlipaySandboxNotifyTest#foreignAppIdRejected',
  },
];

let allOk = true;
for (const p of probes) {
  const before = md5(p.file);
  patchOnce(p.file, p.from, p.to);

  const red = runOne(p.test);

  // 还原并逐字节校验
  writeFileSync(p.file, readFileSync(p.file, 'utf8').replace(p.to, p.from), 'utf8');
  const restored = md5(p.file) === before;

  const green = runOne(p.test);

  const ok = red.verdict === 'FAIL' && green.verdict === 'PASS' && restored;
  console.log(`${ok ? 'OK  ' : 'BAD '} ${p.name}`);
  console.log(`     破坏后=${red.verdict} (${red.why})  还原后=${green.verdict} (${green.why})  逐字节还原=${restored ? 'yes' : 'NO'}`);
  if (!ok) allOk = false;
}

console.log(allOk ? '\nPASS 三个探针全部报出「红→绿」' : '\nFAIL 有用例没有判别力，或脚本没跑起来');
process.exit(allOk ? 0 : 2);
