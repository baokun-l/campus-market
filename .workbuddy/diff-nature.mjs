/**
 * 精确判定两份同名文件的差异性质：
 * 1) 是否仅行尾符不同（CRLF vs LF）
 * 2) 若内容真有差异，统计「忽略行尾符与行尾空白」后的差异行，摘掉噪音
 *
 * 为什么要这么细：`diff` 会把 CRLF/LF 差异渲染成「整段整段看起来一模一样」的
 * 改动块，肉眼判断会误以为文件被大改；而实际新增的往往只有几行。
 * 判断同步方向前必须先剥掉这层噪音，否则会做出「要不要整文件覆盖」的错误决定。
 */
import { readFileSync } from 'node:fs'

const R = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发'
const T2 = `${R}/实践任务2：Web前端开发(Vue3+Element Plus+ECharts)/campus-secondhand-frontend`
const T3 = `${R}/实践任务3：后端开发(前后端分离)/campus-secondhand-frontend`

const files = [
  'src/api/activity.ts',
  'src/api/audit.ts',
  'src/api/order-admin.spec.ts',
  'src/api/order.ts',
  'src/api/promo.spec.ts',
  'src/components/common/AiAssistant.vue',
  'src/stores/modules/user.spec.ts',
  'src/stores/modules/user.ts',
  'src/views/admin/panels/SettingsPanel.vue',
  'src/views/admin/panels/orders/OrderDetailDrawer.vue',
  'src/views/goods/List.vue'
]

/** 把文本拆成行，并剥离 CR 与行尾空白 */
const norm = (t) => t.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''))

for (const f of files) {
  const a = readFileSync(`${T2}/${f}`)
  const b = readFileSync(`${T3}/${f}`)
  const crlfA = (a.toString('binary').match(/\r\n/g) || []).length
  const crlfB = (b.toString('binary').match(/\r\n/g) || []).length
  const linesA = a.toString('utf8').split('\n').length
  const linesB = b.toString('utf8').split('\n').length

  const na = norm(a.toString('utf8'))
  const nb = norm(b.toString('utf8'))
  const setB = new Set(nb)
  const setA = new Set(na)
  // 语义：t2Only = 只出现在 T2 的非空行；t3Only = 只出现在 T3 的非空行
  const t2Only = na.filter((l) => l.trim() && !setB.has(l)).length
  const t3Only = nb.filter((l) => l.trim() && !setA.has(l)).length

  console.log(
    `${f}\n` +
      `  行数 T2=${linesA} T3=${linesB} | CRLF T2=${crlfA} T3=${crlfB}\n` +
      `  去重后：T2独有非空行=${t2Only}  T3独有非空行=${t3Only}  → ${
        t3Only > 0 && t2Only === 0
          ? 'T3 是超集（纯新增）'
          : t2Only === 0 && t3Only === 0
            ? '内容等价'
            : '双向差异，需人工看'
      }`
  )
}
