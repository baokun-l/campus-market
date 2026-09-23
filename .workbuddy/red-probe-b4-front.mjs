/**
 * B4 前端红绿探针（L6 轮询器）
 *
 * 把 visiblePoll.ts 换成「旧写法等价物」—— 裸 setInterval、无串行化、无可见性感知，
 * 公开 API 保持不变，于是同一个 spec 能跑：
 *   - 必须红在「上一轮没结束就不排下一轮」与「隐藏时停表」两条上；
 *   - 还原后必须回绿。
 *
 * 两条踩过的坑，写在这里免得下次再踩：
 *   1. vitest 的输出**带 ANSI 转义码**（走 execFileSync 管道时仍带色，直接重定向到文件时才不带），
 *      不剥就会让 `^\s*[×✗]` 全部落空 —— 而那会伪装成「没有用例失败」；
 *   2. 本机沙箱会偶发打断 vitest 的 worker：表现为收集阶段就崩（没有 "Tests 汇总行"，
 *      报错却指向 setup.ts）。这是环境噪音不是缺陷判定，所以**重试**，
 *      连续失败才以退出码 2 认输 —— 绝不能把它算成「红」或「绿」。
 *
 * 退出码：0 = 红绿都符合预期；1 = 有断言不符；2 = 脚本自身/环境失效。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const FE = path.join(ROOT, 'campus-secondhand-frontend')
const TARGET = path.join(FE, 'src/utils/visiblePoll.ts')
const TMP = path.join(ROOT, '.workbuddy/tmp')

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

const RED_SOURCE = `/**
 * RED PROBE —— 这是「旧写法」的等价物，不是真实实现。
 * 有意做成裸 setInterval：无串行化、无可见性感知。
 */
export interface VisiblePollerHandle {
  start(): void
  stop(): void
  isRunning(): boolean
}

export interface VisiblePollerOptions {
  intervalMs: number
  tick: () => void | Promise<void>
}

export function createVisiblePoller(options: VisiblePollerOptions): VisiblePollerHandle {
  const { intervalMs, tick } = options
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        void tick()
      }, intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    isRunning() {
      return timer !== null
    },
  }
}
`

function runSpecOnce() {
  let out = ''
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'src/utils/visiblePoll.spec.ts', '--reporter=verbose'],
      {
        cwd: FE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, TEMP: TMP, TMP },
      },
    )
  } catch (e) {
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
  out = stripAnsi(out ?? '')
  const lines = out.split(/\r?\n/)
  const failedCases = []
  for (const l of lines) {
    const m = l.match(/^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?\s*$/)
    if (m) failedCases.push(m[1].trim())
  }
  const summary = (lines.find((l) => /^\s*Tests\s+\d+/.test(l)) ?? '').trim()
  const files = (lines.find((l) => /^\s*Test Files\s/.test(l)) ?? '').trim()
  return {
    failedCases,
    summary: summary || '(无 Tests 汇总行)',
    files: files || '(无 Test Files 汇总行)',
    noSummary: summary === '',
    tail: lines.slice(-22).join('\n'),
  }
}

/** 收集阶段崩了 = 环境噪音：重试；连试 4 次都不行就以 2 认输，绝不把它当成结论 */
function runSpec(label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (process.env.PROBE_DEBUG === '1') {
      const cur = fs.readFileSync(TARGET, 'utf8')
      console.log(`   [debug] cwd=${process.cwd()}`)
      console.log(`   [debug] TARGET=${TARGET} chars=${cur.length} red=${cur.includes('RED PROBE')}`)
    }
    const r = runSpecOnce()
    if (!r.noSummary) return r
    attempts.push({ label, attempt, tail: r.tail })
    if (attempt < 4) {
      console.log(`   ⚠ ${label}：第 ${attempt} 次没有汇总行（收集阶段崩，疑似沙箱抖动），3 秒后重试…`)
      // 实测：这种崩会连续命中几次，且**隔开时间**比立即重试更容易恢复 —— 所以重试要带间隔
      sleepMs(3000)
    }
  }
  throw new Error(`INFRA:${label}`)
}

/** 同步睡一会儿（探针是一次性脚本，不需要异步开销） */
function sleepMs(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 空转等待：Node 的 Atomics.wait 在部分环境不可用，这里只等几秒
  }
}

const attempts = []
const original = fs.readFileSync(TARGET, 'utf8')
const originalSha = sha(original)

let red = null
let green = null
let restoredOk = false
let infraFailure = null

try {
  // ---------- 红 ----------
  fs.writeFileSync(TARGET, RED_SOURCE, 'utf8')
  if (sha(fs.readFileSync(TARGET, 'utf8')) === originalSha) {
    throw new Error('INFRA:替换 visiblePoll.ts 后文件没变化')
  }
  red = runSpec('红色一轮')
} catch (e) {
  if (!String(e.message).startsWith('INFRA:')) throw e
  infraFailure = e.message
} finally {
  // ★ 无论走哪条路都要还原 ★：宁可报告不可信，也不能把仓库留在脏状态
  fs.writeFileSync(TARGET, original, 'utf8')
  restoredOk = sha(fs.readFileSync(TARGET, 'utf8')) === originalSha
}

try {
  if (!infraFailure) green = runSpec('绿色一轮')
} catch (e) {
  if (!String(e.message).startsWith('INFRA:')) throw e
  infraFailure = e.message
}

// ==================== 汇报 ====================

console.log('================ B4 前端红绿验证（L6）================')
console.log('')
if (red) {
  console.log('【红】visiblePoll 换成裸 setInterval 等价物')
  console.log(`   ${red.files} / ${red.summary}`)
  console.log(`   变红的用例：`)
  red.failedCases.forEach((c) => console.log(`      × ${c}`))
} else {
  console.log('【红】未能取得结论（环境抖动）')
}
console.log(`   还原字节一致：${restoredOk ? '是' : '否 ★'}`)
console.log('')
if (green) {
  console.log('【绿】还原后')
  console.log(`   ${green.files} / ${green.summary}`)
  if (green.failedCases.length) green.failedCases.forEach((c) => console.log(`      × ${c}`))
} else {
  console.log('【绿】未能取得结论（环境抖动）')
}

const mustRed = ['上一轮没结束就不排下一轮', '文档隐藏时停表']
const missing = red ? mustRed.filter((k) => !red.failedCases.some((c) => c.includes(k))) : mustRed
const bad = []
if (!restoredOk) bad.push('还原不是字节一致，仓库已脏')
if (red && red.failedCases.length === 0) bad.push('红色一轮没有任何用例变红，等于没验证')
if (red && missing.length) bad.push(`该红没红：${missing.join('、')}`)
if (green && green.failedCases.length > 0) bad.push(`还原后没有回绿：${green.failedCases.join(' | ')}`)

console.log('')
if (infraFailure) {
  console.log(`★ 退出码 2：${infraFailure.replace('INFRA:', '')}`)
  if (attempts.length) {
    const last = attempts[attempts.length - 1]
    console.log(`   最后一次（${last.label} 第 ${last.attempt} 次）的原文结尾：`)
    console.log(last.tail.split('\n').map((l) => '      | ' + l).join('\n'))
  }
  console.log('   本机环境不可信，以上红绿结论一律不成立。')
  process.exit(2)
}
if (bad.length) {
  console.log('★ 有不符合预期的项：')
  bad.forEach((b) => console.log('   - ' + b))
  process.exit(restoredOk ? 1 : 2)
}
console.log('★ 红绿均符合预期：裸 setInterval 会被现有 spec 抓住（请求叠加 + 隐藏期间空转），还原后全绿。')
