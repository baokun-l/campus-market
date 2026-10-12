#!/usr/bin/env bash
# ============================================================================
# 红绿探针：证明 scripts/check-test-coverage.mjs 真的能抓出「静默丢文件」。
#
# 为什么必须做：这个自检脚本的存在理由，就是「vitest 报全绿但实际少跑了文件」。
# 如果它自己也只会打印 ✅，那它就等于又加了一层假安全感 —— 比没有更糟。
# 所以这里**手工把 JSON 报告改坏**（不重跑测试，几秒钟一轮），看它是否报红。
#
# 三个变体：
#   RED-A 删掉一条 testResults      → 应报「有 1 个 spec 文件没有执行」
#   RED-B 用例总数改成 0            → 应报「用例数为 0，报告是空的」
#   RED-C numFailedTests 改成 3     → 应报「有 3 条用例失败」
#
# 每一轮之后都从原始备份还原，最后用 cmp 逐字节校验。
# ============================================================================
set -u

FE="C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/campus-secondhand-frontend"
REPORT="$FE/.vitest-report.json"
BAK="/c/wbtmp/_vitest-report.original.json"

cd "$FE" || exit 1

if [ ! -f "$REPORT" ]; then
  echo "✗ 找不到 .vitest-report.json，请先跑 npm run test:audit 生成"
  exit 2
fi

cp "$REPORT" "$BAK" || exit 1
ORIG_SHA=$(sha256sum "$REPORT" | cut -d' ' -f1)
echo "================================================================================"
echo "红绿探针：测试口径自检（check-test-coverage.mjs）"
echo "================================================================================"
echo "报告文件 : $REPORT"
echo "原始 SHA : $ORIG_SHA"
echo

run_check() {
  node scripts/check-test-coverage.mjs > /c/wbtmp/_audit-red.log 2>&1
  echo $?
}

# ---------- RED-A：删掉一个文件的执行记录 ----------
node -e "
const fs=require('fs');
const r=JSON.parse(fs.readFileSync('.vitest-report.json','utf8'));
const n=r.testResults.length;
r.testResults.splice(0,1);
fs.writeFileSync('.vitest-report.json',JSON.stringify(r));
console.error('  改坏：testResults 从 '+n+' 条减为 '+r.testResults.length+' 条');
"
RC=$(run_check)
echo "[RED-A] 删掉 1 个文件的执行记录 → 自检退出码 $RC  $([ "$RC" -eq 1 ] && echo '✅ 按预期报红' || echo '❌ 竟然没报错')"
grep -E '❌|磁盘上的|本次实际' /c/wbtmp/_audit-red.log | sed 's/^/        /'
echo

# ---------- RED-B：报告是空的 ----------
cp "$BAK" "$REPORT"
node -e "
const fs=require('fs');
const r=JSON.parse(fs.readFileSync('.vitest-report.json','utf8'));
r.numTotalTests=0; r.numPassedTests=0;
fs.writeFileSync('.vitest-report.json',JSON.stringify(r));
console.error('  改坏：用例总数改成 0');
"
RC=$(run_check)
echo "[RED-B] 把用例总数改成 0 → 自检退出码 $RC  $([ "$RC" -eq 1 ] && echo '✅ 按预期报红' || echo '❌ 竟然没报错')"
grep -E '❌' /c/wbtmp/_audit-red.log | sed 's/^/        /'
echo

# ---------- RED-C：有失败用例但文件数对得上 ----------
cp "$BAK" "$REPORT"
node -e "
const fs=require('fs');
const r=JSON.parse(fs.readFileSync('.vitest-report.json','utf8'));
r.numFailedTests=3; r.numPassedTests=730;
fs.writeFileSync('.vitest-report.json',JSON.stringify(r));
console.error('  改坏：失败用例数改成 3（文件数不动）');
"
RC=$(run_check)
echo "[RED-C] 文件数对得上但有用例失败 → 自检退出码 $RC  $([ "$RC" -eq 1 ] && echo '✅ 按预期报红' || echo '❌ 竟然没报错')"
grep -E '❌' /c/wbtmp/_audit-red.log | sed 's/^/        /'
echo

# ---------- 还原 + 绿 ----------
cp "$BAK" "$REPORT"
RC=$(run_check)
NEW_SHA=$(sha256sum "$REPORT" | cut -d' ' -f1)
echo "================================================================================"
echo "还原后"
echo "  SHA 一致      : $([ "$NEW_SHA" = "$ORIG_SHA" ] && echo '是 ✅' || echo '否 ❌')"
if cmp -s "$BAK" "$REPORT"; then echo "  cmp 逐字节    : IDENTICAL ✅"; CMP_OK=1; else echo "  cmp 逐字节    : DIFFERENT ❌"; CMP_OK=0; fi
echo "  自检退出码    : $RC  $([ "$RC" -eq 0 ] && echo '✅ 回到全绿' || echo '❌ 仍报错')"
grep -E '✅' /c/wbtmp/_audit-red.log | sed 's/^/        /'
echo "================================================================================"
if [ "$CMP_OK" -eq 1 ] && [ "$RC" -eq 0 ]; then
  echo "结论：3 个变体全部按预期报红，还原后逐字节一致且自检回到全绿 ✅"
  exit 0
else
  echo "结论：存在未达预期的变体 ❌"
  exit 1
fi
