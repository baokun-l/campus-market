/**
 * 回流前预检：把 T3（本次改动）与 T2（正本）做行级 diff，
 * 确认 T2 侧除了「本次要同步的改动」之外没有他人/历史遗留的独立改动，
 * 避免一次覆盖把正本上别的活儿冲掉。
 *
 * 用法：node .workbuddy/pre-sync-diff.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发';
const T2 = join(ROOT, '实践任务2：Web前端开发(Vue3+Element Plus+ECharts)', 'campus-secondhand-frontend');
const T3 = join(ROOT, '实践任务3：后端开发(前后端分离)', 'campus-secondhand-frontend');

const FILES = [
  'src/App.vue',
  'src/api/user.ts',
  'src/components/common/GoodsCard.vue',
  'src/stores/modules/app.spec.ts',
  'src/stores/modules/app.ts',
  'src/stores/modules/online.ts',
  'src/types/index.ts',
  'src/utils/prefs.ts',
  'src/views/goods/Detail.vue',
  'src/views/message/Index.vue',
  'src/views/settings/Index.vue',
];

/** 极简 LCS 行级 diff，返回 -/+/空格 前缀的行 */
function diffLines(a, b) {
  const n = a.length, m = b.length;
  // 长度可控（单文件 < 3000 行），直接 DP
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push('  ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('- ' + a[i]); i++; }
    else { out.push('+ ' + b[j]); j++; }
  }
  while (i < n) out.push('- ' + a[i++]);
  while (j < m) out.push('+ ' + b[j++]);
  return out;
}

let totalChanged = 0;
for (const rel of FILES) {
  let a, b;
  try { a = readFileSync(join(T2, rel), 'utf8').split(/\r?\n/); }
  catch { console.log(`\n########## ${rel} ##########\n  (T2 不存在 → 纯新增文件，直接复制)`); totalChanged++; continue; }
  try { b = readFileSync(join(T3, rel), 'utf8').split(/\r?\n/); }
  catch { console.log(`\n########## ${rel} ##########\n  (T3 不存在，跳过)`); continue; }

  const d = diffLines(a, b);
  const changed = d.filter((l) => l[0] !== ' ').length;
  totalChanged += changed;
  console.log(`\n########## ${rel}  (T2 ${a.length} 行 → T3 ${b.length} 行, 变更块 ${changed} 行) ##########`);
  // 折叠长上下文：只保留变更行 ±2 行
  const keep = new Set();
  d.forEach((l, idx) => { if (l[0] !== ' ') for (let k = idx - 2; k <= idx + 2; k++) keep.add(k); });
  let prevKept = -2;
  d.forEach((l, idx) => {
    if (!keep.has(idx)) return;
    if (idx - prevKept > 1) console.log('   ...');
    console.log('   ' + l);
    prevKept = idx;
  });
}
console.log(`\n===== 合计变更 ${totalChanged} 行 =====`);
