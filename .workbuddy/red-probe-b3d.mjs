/**
 * 红绿探针：验证 `.workbuddy/audit-guest-requests.mjs` **真的有判别力**
 *
 * ★ 为什么必须有这一步 ★
 * 审计脚本给出的「✅ 干净」是一个**声明**，不是证据。这类静态脚本最大的风险
 * 是「它其实什么都没检查到，却报了通过」—— 而它的通过比不审计更危险，
 * 因为它会让人停止怀疑。
 *
 * 判据：**故意把每一类真实缺陷注入进去，审计必须报红，且报的是对的那一处**。
 * 只报「绿」不算证明，报出「红 → 绿」才算。
 *
 * 本探针做的四件事，正好对应审计的四个环节：
 *   V1 去掉一个守卫函数调用      → 必须报「公开页无守卫调用」（环节⑤）
 *   V2 去掉子组件的契约标记      → 必须报「子组件无人担保」（环节⑥）
 *   V3 把一条路由的 public 删掉  → 必须报「手写清单与路由不一致」（环节②交叉核对）
 *   V4 改掉后端白名单常量名      → 必须**退出码 2**（环节①自证：解析器坏了要响亮地失败，
 *                                  绝不能静默返回 0）
 *
 * ★ 每个变体都是「写入 → 跑 → 还原」，且还原后**校验字节哈希** ★
 * 不复原就等于把真实代码改坏了；不校验哈希就等于"以为"还原了。
 *
 * 用法：node .workbuddy/red-probe-b3d.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`
const FE = join(ROOT, 'campus-secondhand-frontend')
const BE = join(ROOT, 'campus-secondhand-backend')
const AUDIT = join(ROOT, '.workbuddy/audit-guest-requests.mjs')

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** 跑审计，返回 {code, out} */
function runAudit() {
  try {
    const out = execFileSync(process.execPath, [AUDIT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name}  -> ${detail}`) }
}

/** 基线：改动前必须是绿的 */
console.log('== 基线 ==')
const base = runAudit()
check('B0 未注入缺陷时审计为绿（退出码 0）', base.code === 0, `exit=${base.code}`)

const VARIANTS = [
  {
    id: 'V1',
    name: '去掉 onFavorite 里的 requireLogin 守卫',
    file: join(FE, 'src/views/goods/Detail.vue'),
    // 保留注释行、只删守卫那一行（模拟"有人重构时把守卫删了"）
    from: "  if (!requireLogin('收藏商品')) return\n",
    to: '',
    expectExit: 1,
    expectMatch: /toggleFavorite[\s\S]{0,80}无守卫|无守卫[\s\S]{0,80}toggleFavorite/,
    expectHint: '报出 toggleFavorite 无守卫'
  },
  {
    id: 'V2',
    name: '去掉 ChatWindow 的调用方契约标记',
    file: join(FE, 'src/components/business/ChatWindow.vue'),
    from: ' * guest-guard: caller-contract\n',
    to: '',
    expectExit: 1,
    expectMatch: /无人担保/,
    expectHint: '报出子组件无人担保'
  },
  {
    id: 'V3',
    name: '把商品广场路由的 public 改回 requireAuth',
    file: join(FE, 'src/router/index.ts'),
    from: "meta: { title: '商品广场', icon: 'Box', public: true }",
    to: "meta: { title: '商品广场', icon: 'Box', requireAuth: true }",
    expectExit: 2,
    expectMatch: /手写清单里有、但路由没标 public/,
    expectHint: '触发手写清单与路由的交叉核对（脚本自证失败=退出码 2）'
  },
  {
    id: 'V4',
    name: '改掉后端白名单常量名（模拟解析器失效）',
    file: join(BE, 'src/main/java/com/campus/market/interceptor/AuthInterceptor.java'),
    from: 'private static final List<String> PUBLIC_GET = List.of(',
    to: 'private static final List<String> PUBLIC_GET_RENAMED = List.of(',
    expectExit: 2,
    expectMatch: /未能在 AuthInterceptor 中找到 PUBLIC_GET/,
    expectHint: '解析器失效必须退出码 2，绝不能静默通过'
  }
]

for (const v of VARIANTS) {
  console.log(`\n== ${v.id} ${v.name} ==`)
  const original = readFileSync(v.file, 'utf8')
  const before = sha(original)
  if (!original.includes(v.from)) {
    check(`${v.id} 注入点存在`, false, `文件里找不到待替换文本：${JSON.stringify(v.from.slice(0, 60))}`)
    continue
  }
  try {
    writeFileSync(v.file, original.replace(v.from, v.to), 'utf8')
    const r = runAudit()
    check(`${v.id} 审计报红且退出码 = ${v.expectExit}`, r.code === v.expectExit, `实际 exit=${r.code}`)
    check(`${v.id} ${v.expectHint}`, v.expectMatch.test(r.out),
      `输出未匹配；尾部=${r.out.slice(-400).replace(/\n/g, ' | ')}`)
  } finally {
    writeFileSync(v.file, original, 'utf8')
    const after = sha(readFileSync(v.file, 'utf8'))
    check(`${v.id} 已字节级还原（sha 一致）`, before === after, `${before} -> ${after}`)
  }
}

console.log('\n== 收尾：还原后必须重新变绿 ==')
const final = runAudit()
check('R1 全部还原后审计回到绿（退出码 0）', final.code === 0, `exit=${final.code}`)

console.log('\n==================== 结果 ====================')
console.log(`PASS=${pass}  FAIL=${fail}`)
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
