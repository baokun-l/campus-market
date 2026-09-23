#!/usr/bin/env node
/**
 * 红绿探针 B5（L10 + L5 复验）
 *
 * 证明两件事：
 *  ① L10：把 ActivityService 的旧实现（static AtomicLong + base36 拼接）放回去，
 *     新增的用例必须**报红**；
 *  ② L5：OrderService 刚被重构成共用 InstanceSeqGenerator，要复验它的用例
 *     **仍然有判别力**（重构最容易干的事就是"把测试变成永远为真"）。
 *
 * 纪律（与 red-probe-b4.mjs 同）：
 *  - 只解析**本次运行自己的 stdout**，不读旧日志
 *  - 解析前剥 ANSI（vitest/maven 走管道时带色，会让行首锚定全部落空 → 伪装成绿）
 *  - 没有 `Tests` 汇总行 = **基础设施信号** → 带间隔重试 → 仍失败才退出码 2，绝不算红或绿
 *  - `finally` 里还原 + sha256 逐字节校验
 *  - 每个 patch 必须**真的命中 1 次**，命中 0 或 >1 ⇒ 退出码 2
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BE = path.join(ROOT, 'campus-secondhand-backend');
const MVN = 'D:/apache-maven-3.9.4/bin/mvn.cmd';
const SETTINGS = path.join(ROOT, '.workbuddy', 'mvn-aliyun-settings.xml').replace(/\\/g, '/');

const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s);
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');

let fatal = 0;
let checked = 0;
const ok = (m) => console.log('  [OK] ' + m);
const bad = (m) => { console.error('  [!!] ' + m); fatal++; };
const infra = (m) => { console.error('  [INFRA] ' + m); process.exit(2); };

/** 精确替换：必须命中 1 次 */
function sub(src, from, to, label) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`${label}: 锚点命中 ${n} 次（要求 1）`);
  return src.replace(from, to);
}

/** 跑 maven 测试，返回剥色后的 stdout */
function runTests(testFilter) {
  const args = ['-o', '-s', SETTINGS, 'test', '-Dtest=' + testFilter];
  let out = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      out = stripAnsi(execFileSync(MVN, args, { cwd: BE, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      out = stripAnsi(String((e && e.stdout) || ''));
      if (!out) { console.error(`      第 ${attempt} 次：maven 无输出，重试…`); sleep(3000); continue; }
    }
    if (/Tests run:/.test(out)) return out;
    console.error(`      第 ${attempt} 次：没有 Tests 汇总行（基础设施信号），重试…`);
    sleep(3000);
  }
  infra('连续 4 次都拿不到 Tests 汇总行 —— 环境/脚本问题，不是红也不是绿');
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function variant({ label, file, patch, testFilter, mustFail }) {
  const abs = path.join(BE, file);
  const original = read(abs);
  const before = sha(abs);
  console.log('\n== ' + label + ' ==');
  try {
    write(abs, patch(original));
    console.log('     已把旧实现放回去');
    const out = runTests(testFilter);
    // 收集本次运行里失败的方法名
    const failed = new Set();
    out.split(/\r?\n/).forEach((l) => {
      const m = l.match(/\.([A-Za-z0-9_$]+)\s*\(.*\)?\s*$/) || l.match(/\[ERROR\]\s+([A-Za-z0-9_$]+)Test[^\s]*\s+--/);
      if (m) failed.add(m[1]);
    });
    // surefire 的失败行形如：ClassName.methodName:line expected: ...
    out.split(/\r?\n/).forEach((l) => {
      if (!/FAILURE|expected:|AssertionFailed/.test(l)) return;
      const m = l.match(/([A-Za-z0-9_$]+)\s+--|^\s*([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+):\d+/);
      if (m) { failed.add(m[1] || ''); failed.add(m[3] || ''); }
    });
    const summary = (out.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/) || []);
    const failCount = summary[2] ? Number(summary[2]) + Number(summary[3] || 0) : -1;
    console.log('     Tests run=' + (summary[1] ?? '?') + ' Failures+Errors=' + failCount);

    if (failCount <= 0) bad(`${label}: 旧实现放回去后**没有报红** —— 这些用例没有判别力`);
    for (const name of mustFail) {
      checked++;
      const hit = out.includes(name);
      if (hit) ok('报红：' + name);
      else bad(`${label}: 期望报红但没出现 → ${name}`);
    }
  } finally {
    write(abs, original);
    if (sha(abs) !== before) infra(`${label}: 还原后字节不一致 —— 立刻停下`);
    console.log('     已还原（sha256 一致）');
  }
}

// ---------------- L10：ActivityService 旧实现 ----------------
variant({
  label: 'L10 · ActivityService 旧实现（static AtomicLong + base36 拼接）',
  file: 'src/main/java/com/campus/market/service/ActivityService.java',
  patch: (src) => {
    let s = sub(src,
      'import java.util.Map;\nimport java.util.Set;',
      'import java.util.Map;\nimport java.util.Set;\nimport java.util.concurrent.atomic.AtomicLong;',
      'L10 import');
    s = sub(s,
      '    private final InstanceSeqGenerator activityIds = new InstanceSeqGenerator(2);',
      '    private static final AtomicLong ID_SEQ = new AtomicLong();',
      'L10 field');
    s = sub(s,
      '    String nextId(long nowMillis) {\n        return activityIds.id("act_", nowMillis, instanceId);\n    }',
      '    String nextId(long nowMillis) {\n        return "act_" + Long.toString(nowMillis, 36) + Long.toString(ID_SEQ.incrementAndGet(), 36);\n    }',
      'L10 nextId');
    return s;
  },
  testFilter: 'ActivityIdUniquenessTest',
  mustFail: [
    'instanceIdIsEmbeddedInTheId',      // 旧实现压根没有实例号这一位（多实例必撞）
    'seqResetsAndRollsForward',         // 序号不按毫秒归零、也不推毫秒
    'shapeIsUnambiguous',               // 形态不是 act_ + 20 位数字
    'outOfRangeInstanceIdThrows',       // 旧实现无视实例号，越界也不会抛
    'bothServicesUseTheSharedGenerator',// 结构断言：自造了原子计数器
    'legacyIdSeqMustStayRemoved',       // 结构断言：ID_SEQ 回来了
  ],
});

// ---------------- L5：OrderService 旧实现（复验重构没把用例变成永远为真） ----------------
variant({
  label: 'L5 · OrderService 旧实现（AtomicInteger %1000，复验重构后仍报红）',
  file: 'src/main/java/com/campus/market/service/OrderService.java',
  patch: (src) => {
    let s = sub(src,
      '    private final InstanceSeqGenerator orderIds = new InstanceSeqGenerator(2);',
      '    private final InstanceSeqGenerator orderIds = new InstanceSeqGenerator(2);\n' +
      '    private static final java.util.concurrent.atomic.AtomicInteger ORDER_SEQ_RED =\n' +
      '            new java.util.concurrent.atomic.AtomicInteger(0);',
      'L5 field');
    s = sub(s,
      '    String generateOrderId(long nowMillis) {\n' +
      '        // 前缀为空 → 仍是 20 位的「时间戳 + 实例号 + 2 位序号」，与历史订单号同形\n' +
      '        return orderIds.id("", nowMillis, instanceId);\n' +
      '    }',
      '    String generateOrderId(long nowMillis) {\n' +
      '        String ts = java.time.LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(nowMillis),\n' +
      '                java.time.ZoneId.systemDefault())\n' +
      '                .format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS"));\n' +
      '        int seq = ORDER_SEQ_RED.updateAndGet(v -> (v + 1) % 1000);\n' +
      '        return ts + String.format("%03d", seq);\n' +
      '    }',
      'L5 body');
    return s;
  },
  testFilter: 'OrderIdUniquenessTest',
  mustFail: [
    'sameMillisecondNeverCollides',
    'seqResetsEveryMillisecond',
    'clockRollbackIsSafe',
  ],
});

console.log('\n===================================');
if (fatal) {
  console.error(`红绿失败 ${fatal} 处 —— 退出码 1（用例没有判别力，或预期写法有误）`);
  process.exit(1);
}
console.log(`✅ 全部 ${checked} 条预期失败都如约报红，且还原字节一致。`);
