/**
 * B4 红绿探针（L5 订单号 / L8 requireOwner）
 *
 * 纪律：只报「绿」不算证明，必须报出「红 → 绿」。
 *   - 把一个实现临时改回**旧逻辑**，对应测试必须变红；
 *   - 改完按字节还原（sha256 比对），再跑一遍必须回绿。
 *
 * 自证：补丁没打上 / 还原不是字节一致 / 一轮都没红 → 退出码 2（脚本自己坏了，别信它的结论）。
 * 退出码：0 = 红绿都符合预期；1 = 有断言不符；2 = 脚本自身失效。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const BE = path.join(ROOT, 'campus-secondhand-backend')
const MVN = 'D:/apache-maven-3.9.4/bin/mvn.cmd'

const ORDER_SERVICE = path.join(BE, 'src/main/java/com/campus/market/service/OrderService.java')
const GOODS_SERVICE = path.join(BE, 'src/main/java/com/campus/market/service/GoodsService.java')

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const results = []
let scriptBroken = null

const fail = (msg) => { if (!scriptBroken) scriptBroken = msg }

function applyPatches(file, patches) {
  let src = fs.readFileSync(file, 'utf8')
  for (const p of patches) {
    const hits = src.split(p.from).length - 1
    if (hits !== 1) {
      fail(`补丁锚点不唯一（命中 ${hits} 次）：${p.label} @ ${path.basename(file)}`)
      return null
    }
    src = src.replace(p.from, p.to)
  }
  fs.writeFileSync(file, src, 'utf8')
  return src
}

/** 跑一轮 maven，把输出抓在手里（★ 不要读上一次的日志文件：那是上一次的结论） */
function runTests(testClasses) {
  const args = [
    '-o', '-s', '../.workbuddy/mvn-aliyun-settings.xml',
    `-Dtest=${testClasses}`, '-DfailIfNoSpecifiedTests=false', 'test',
  ]
  let out = ''
  try {
    // ★ Windows 上 mvn.cmd 不是可执行文件，execFileSync 不加 shell 会直接 EINVAL ★
    // 参数里没有空格/引号，所以交给 shell 拼接是安全的。
    out = execFileSync(MVN, args, {
      cwd: BE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024, shell: true,
    })
  } catch (e) {
    // 测试失败时 mvn 非 0 退出，属预期：结果从它自己的输出里解析
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
  if (!out || out.length < 200) {
    fail(`maven 输出为空或过短（${out.length} 字符），这一轮结论不可信`)
    return { failed: [], total: -1, failures: -1, errors: -1 }
  }
  const lines = out.split(/\r?\n/)
  const failed = []
  for (const line of lines) {
    let m = line.match(/^\[ERROR\]\s{2,}([A-Za-z0-9_$]+)\.([A-Za-z0-9_]+)(?::\d+)?\s/)
    if (m) { failed.push(`${m[1]}.${m[2]}`); continue }
    m = line.match(/^\[ERROR\]\s{2,}([A-Za-z0-9_$]+)\s+(.+)$/)
    if (m && /Time elapsed|expected:|AssertionFailedError|Test\b/.test(m[2])) {
      failed.push(`${m[1]} :: ${m[2].slice(0, 100)}`)
    }
  }
  const totals = [...out.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)]
  const last = totals.length ? totals[totals.length - 1] : null
  if (!last) fail('这一轮输出里没有 "Tests run:" 汇总行，无法判定')
  return {
    failed: [...new Set(failed)],
    total: last ? Number(last[1]) : -1,
    failures: last ? Number(last[2]) : -1,
    errors: last ? Number(last[3]) : -1,
  }
}

function variant(label, file, patches, testClasses, mustFailSubstrings) {
  const original = fs.readFileSync(file, 'utf8')
  const originalSha = sha(original)

  const patched = applyPatches(file, patches)
  if (patched === null) return
  if (sha(patched) === originalSha) { fail(`${label}：打完补丁文件没变化`); return }

  const red = runTests(testClasses)

  fs.writeFileSync(file, original, 'utf8')
  const restoredOk = sha(fs.readFileSync(file, 'utf8')) === originalSha

  const missing = mustFailSubstrings.filter((s) => !red.failed.some((f) => f.includes(s)))
  results.push({ label, red, missing, mustFail: mustFailSubstrings, restoredOk })

  if (!restoredOk) fail(`${label}：还原不是字节一致，仓库已脏`)
}

// ==================== 红：L5 把发号退回「全局计数器 % 1000」 ====================

variant(
  'L5 订单号退回旧实现（全局 AtomicInteger % 1000 静默回绕）',
  ORDER_SERVICE,
  [
    {
      label: '插入旧的静态计数器',
      from: '    private final Object orderIdLock = new Object();',
      to: '    private static final java.util.concurrent.atomic.AtomicInteger ORDER_SEQ_RED ='
        + ' new java.util.concurrent.atomic.AtomicInteger(0);\n'
        + '    private final Object orderIdLock = new Object();',
    },
    {
      label: '把发号状态机换回回绕计数',
      from: `        long millis;
        int seq;
        synchronized (orderIdLock) {
            if (nowMillis > orderIdLastMillis) {
                orderIdLastMillis = nowMillis;
                orderIdSeqInMs = 0;
            } else if (orderIdSeqInMs >= ORDERS_PER_MS - 1) {
                // 这一毫秒发满了：把毫秒推一格，序号重来 —— 绝不回绕到已发过的号上
                orderIdLastMillis++;
                orderIdSeqInMs = 0;
            } else {
                orderIdSeqInMs++;
            }
            millis = orderIdLastMillis;
            seq = orderIdSeqInMs;
        }
        String ts = LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneId.systemDefault())
                .format(ORDER_ID_TS);
        return ts + instanceId + String.format("%02d", seq);`,
      to: `        String ts = LocalDateTime.ofInstant(Instant.ofEpochMilli(nowMillis), ZoneId.systemDefault())
                .format(ORDER_ID_TS);
        int seq = ORDER_SEQ_RED.updateAndGet(v -> (v + 1) % 1000);
        return ts + String.format("%03d", seq);`,
    },
  ],
  'OrderIdUniquenessTest',
  ['sameMillisecondNeverCollides', 'seqResetsEveryMillisecond'],
)

// ==================== 红：L8 恢复「传 null 就放行」 ====================

variant(
  'L8 requireOwner 退回「operatorId == null 静默放行」',
  GOODS_SERVICE,
  [
    {
      label: '恢复 null 旁路',
      from: `        if (operatorId == null) {
            // 失败关闭。用 403 而不是 404/1001：这不是「商品不存在」也不是「参数不合法」，
            // 而是「没认出你是谁」的鉴权问题 —— 与下面那条越权拒绝同类。
            throw BusinessException.forbidden("无法确认操作者身份，已拒绝该操作");
        }`,
      to: '        if (operatorId == null) return;',
    },
  ],
  'GoodsOwnershipGuardTest',
  ['updateStatusRejectsNullOperator', 'deleteRejectsNullOperator'],
)

// ==================== 绿：全部还原后必须回绿 ====================

const green = runTests('OrderIdUniquenessTest,GoodsOwnershipGuardTest,RegisterAndDeleteCascadeTest')

// ==================== 汇报 ====================

console.log('================ B4 红绿验证 ================')
for (const r of results) {
  console.log('')
  console.log(`【红】${r.label}`)
  console.log(`   测试规模 ${r.red.total} 个，失败 ${r.red.failures} + 错误 ${r.red.errors}`)
  console.log(`   变红的用例：${r.red.failed.join(' | ') || '(无 —— 这条不对！)'}`)
  console.log(`   要求变红的锚点：${r.mustFail.join(', ')}`)
  console.log(`   还原字节一致：${r.restoredOk ? '是' : '否 ★'}`)
  if (r.missing.length) console.log(`   ★ 未变红（说明断言没守住）：${r.missing.join(', ')}`)
}

console.log('')
console.log(`【绿】全部还原后：${green.total} 个测试，失败 ${green.failures} + 错误 ${green.errors}`)
if (green.failed.length) console.log(`   仍失败：${green.failed.join(' | ')}`)

const bad = []
if (scriptBroken) bad.push(`脚本自身失效：${scriptBroken}`)
for (const r of results) {
  if (!r.restoredOk) bad.push(`${r.label}：还原不是字节一致`)
  if (r.red.failures + r.red.errors === 0) bad.push(`${r.label}：整轮没红，等于没验证`)
  if (r.missing.length) bad.push(`${r.label}：${r.missing.join(',')} 没有变红`)
}
if (green.failures + green.errors !== 0) bad.push(`还原后没有回绿：失败 ${green.failures} + 错误 ${green.errors}`)

console.log('')
if (scriptBroken) {
  console.log('★ 退出码 2：脚本自身失效，上面所有结论都不可信。')
  process.exit(2)
}
if (bad.length) {
  console.log('★ 有不符合预期的项：')
  bad.forEach((b) => console.log('   - ' + b))
  process.exit(1)
}
console.log('★ 红绿均符合预期：两处旧实现都能被现有测试抓到，还原后全绿。')
