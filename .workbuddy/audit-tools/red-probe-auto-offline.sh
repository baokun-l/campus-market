#!/usr/bin/env bash
# ============================================================================
# 红绿探针：证明 campus-secondhand-frontend/src/api/settings.spec.ts
# 真的能抓住「自动下架」的实现缺陷。
# ============================================================================
# ★ 为什么用 Bash 而不是 Node 写这个探针 ★
# 第一版用 Node 的 `spawnSync('node', ...)` 派生 vitest，结果四组变体
# **全部报「仍然是绿的」** —— 看起来像是「断言没有判别力」。
# 实际上 spawnSync 直接抛 `EBUSY`（本沙箱禁止子进程派生），
# 测试一次都没跑起来，而我的解析逻辑把「没匹配到 Tests 行」当成「0 failed」。
# 也就是说：**探针自己撒了谎**，把一个「跑不起来」伪装成了「无需修复」。
# 所以这里改成 Bash 直接驱动，并且加了「跑了没有」的显式判定：
# 没有 `Tests` 行 ⇒ 记为 ERROR，一律不算通过。
#
# 四个变体各自对应一类真实会犯的错：
#   RED-A 判据丢掉 on_sale    → 待审 / 已售出的商品也会被下架（误伤）
#   RED-B 丢掉 days<=0 闸门    → 配置为「关闭」时反而全站下架（最危险的方向）
#   RED-C 只返数字、不改状态    → Mock 撒谎：预览说 1 件，实际谁也没动
#   RED-D 时间比较方向写反      → 下架的是「太新」的商品，正好反了
# ============================================================================
set -u

FE="C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/campus-secondhand-frontend"
TARGET="$FE/src/api/settings.ts"
SPEC="src/api/settings.spec.ts"
PY="C:/Users/刘宝杰/.workbuddy/binaries/python/versions/3.13.12/python.exe"
BACKUP="/c/wbtmp/settings.ts.original"
LOG="/c/wbtmp/_redgreen-vt.log"

IDS=(RED-A RED-B RED-C RED-D)
DESCS=(
  "判据丢掉 on_sale → 待审/已售出也被下架"
  "丢掉 days<=0 闸门 → 关闭时反而全站下架"
  "只返数字不改状态 → Mock 撒谎"
  "时间比较方向写反 → 下架太新的商品"
)
FROMS=(
  "g.status === 'on_sale' &&"
  "if (days <= 0) return []"
  "(hit.has(g.id) ? { ...g, status: 'off_shelf' as const } : g)"
  "new Date(g.createTime).getTime() < deadline"
)
TOS=(
  "g.status !== 'off_shelf' &&"
  "if (false) return []"
  "g"
  "new Date(g.createTime).getTime() > deadline"
)

cp "$TARGET" "$BACKUP" || { echo "备份失败"; exit 1; }
ORIG_SHA=$(sha256sum "$TARGET" | cut -d' ' -f1)
echo "================================================================================"
echo "红绿探针：自动下架的预览 / 执行"
echo "================================================================================"
echo "目标文件 : $TARGET"
echo "原始 SHA : $ORIG_SHA"
echo "备份     : $BACKUP"
echo

RESTORE_COUNT=0

for i in 0 1 2 3; do
  ID=${IDS[$i]}; DESC=${DESCS[$i]}; FROM=${FROMS[$i]}; TO=${TOS[$i]}

  cp "$BACKUP" "$TARGET"; RESTORE_COUNT=$((RESTORE_COUNT + 1))

  if ! "$PY" - "$TARGET" "$FROM" "$TO" <<'PYEOF'
import io, sys
p, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8', newline='').read()
if frm not in s:
    sys.exit(3)
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace(frm, to, 1))
PYEOF
  then
    echo "[$ID] ✗ 定位失败：源码里找不到待替换片段，探针本身不成立"
    RESULT[$i]="定位失败"
    continue
  fi

  ( cd "$FE" && NO_COLOR=1 node node_modules/vitest/vitest.mjs run "$SPEC" --no-file-parallelism > "$LOG" 2>&1 )

  cp "$BACKUP" "$TARGET"; RESTORE_COUNT=$((RESTORE_COUNT + 1))

  # ★ vitest 即使重定向到文件也会加 ANSI 颜色码 ★
  # `^ *Tests` 于是匹配不上（真实行首是 ESC[2m 而不是空格），
  # 解析不到 ⇒ STAT 为空 ⇒ 上一版把它误判成「0 failed / 仍然全绿」。
  # 这是同一类缺陷的第二次现身（第一次是 spawnSync EBUSY），所以一律先剥码再解析。
  sed -i 's/\x1b\[[0-9;]*m//g' "$LOG"

  STAT=$(grep -oE '^ *Tests +.*' "$LOG" | tail -1 | sed 's/^ *//')
  if [ -z "$STAT" ]; then
    echo "[$ID] $DESC"
    echo "       ❌ ERROR：日志里没有 Tests 行 —— 测试根本没跑起来，不算通过"
    tail -6 "$LOG" | sed 's/^/         | /'
    RESULT[$i]="ERROR"
    continue
  fi

  if echo "$STAT" | grep -q 'failed'; then
    echo "[$ID] $DESC"
    echo "       改坏后：$STAT  → ✅ 按预期变红"
    grep -E '^ *×' "$LOG" | sed 's/^ */         × /' | head -5
    RESULT[$i]="变红 ✅"
  else
    echo "[$ID] $DESC"
    echo "       改坏后：$STAT  → ❌ 仍然是绿的（断言无判别力！）"
    RESULT[$i]="仍绿 ❌"
  fi
  echo
done

# ---------------- 还原校验 ----------------
cp "$BACKUP" "$TARGET"; RESTORE_COUNT=$((RESTORE_COUNT + 1))
NEW_SHA=$(sha256sum "$TARGET" | cut -d' ' -f1)

echo "================================================================================"
echo "还原校验"
echo "  还原后 SHA        : $NEW_SHA"
echo "  与原始一致(SHA)   : $([ "$NEW_SHA" = "$ORIG_SHA" ] && echo '是 ✅' || echo '否 ❌')"
if cmp -s "$BACKUP" "$TARGET"; then
  echo "  cmp 逐字节复核    : IDENTICAL ✅"
  CMP_OK=1
else
  echo "  cmp 逐字节复核    : DIFFERENT ❌"
  CMP_OK=0
fi
echo "  还原次数          : $RESTORE_COUNT"

echo
echo "还原后重跑测试（应回到 10 PASS / 0 FAIL）："
( cd "$FE" && NO_COLOR=1 node node_modules/vitest/vitest.mjs run "$SPEC" --no-file-parallelism > "$LOG" 2>&1 )
sed -i 's/\x1b\[[0-9;]*m//g' "$LOG"
FINAL=$(grep -oE '^ *Tests +.*' "$LOG" | tail -1 | sed 's/^ *//')
echo "  $FINAL"

echo
echo "================================================================================"
echo "汇总"
echo "================================================================================"
FAILED_VARIANTS=0
for i in 0 1 2 3; do
  R=${RESULT[$i]:-未执行}
  echo "  ${IDS[$i]}  ${DESCS[$i]}"
  echo "        → $R"
  [ "$R" = "变红 ✅" ] || FAILED_VARIANTS=$((FAILED_VARIANTS + 1))
done
echo
if [ "$FAILED_VARIANTS" -eq 0 ] && [ "$CMP_OK" -eq 1 ] && echo "$FINAL" | grep -q '10 passed'; then
  echo "结论：4 个变体全部按预期变红；还原后逐字节一致且 10/10 全绿 ✅"
  exit 0
else
  echo "结论：存在未达预期的变体 ❌"
  exit 1
fi
