/**
 * 浮层焦点归还。
 *
 * ## 为什么需要这个东西
 *
 * Element Plus 的 `el-drawer` / `el-dialog` 打开时会把焦点交给浮层内部的
 * **哨兵元素**（`.el-drawer__sr-focus` / `.el-dialog__sr-focus`，一个
 * `tabindex="-1"` 的隐藏 span，用于把键盘焦点圈进浮层）。浮层关闭后，
 * 这个哨兵**不会**被清掉——焦点仍留在它身上，而它所在的浮层 DOM 是保留的
 * （只是 display:none）。
 *
 * 于是出现一个很难查的现象：**抽屉里套过弹窗之后，页面上其它 el-select 点不开**。
 * 原因是 `useFocusController`：点击 select 的 wrapper 会触发 focus，
 * 紧接着残留焦点元素触发一次迟到的 blur，走到 `afterBlur()` 里的
 * `expanded.value = false`，把刚展开的下拉当场关掉 —— 表现就是「点一下没反应」，
 * 而且反复点都没用（每次展开都被同一个残留状态吃掉）。
 *
 * 排查过程（可用 `scripts/diag-focus.cjs` 复现）：
 *   document.activeElement → SPAN.el-drawer__sr-focus（在抽屉内、浮层已不可见）
 *   activeElement.blur() → 再点 select → 下拉正常展开（open 0 → 1）
 *
 * ## 用法
 *
 * 在浮层的 `@closed` 上挂一次即可（`@closed` 是动画结束后的回调，
 * 此时浮层已不可见，归还焦点不会让浮层内的表单失去操作上下文）：
 *
 * ```html
 * <el-drawer @closed="releaseOverlayFocus">
 * <el-dialog @closed="releaseOverlayFocus">
 * ```
 *
 * 只处理「焦点在**已不可见**的浮层内」这一种情况：
 * 焦点正常落在输入框/按钮上时不做任何事，避免打断用户的输入。
 */
export function releaseOverlayFocus(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body) return

  // 哨兵本身，或任何位于「已关闭浮层」里的元素 —— 焦点都该还回去
  const className = typeof active.className === 'string' ? active.className : ''
  const isSentinel = /__sr-focus/.test(className)
  const holder = active.closest('.el-overlay')
  const insideHiddenOverlay = !!holder && holder.getBoundingClientRect().width === 0

  if (isSentinel || insideHiddenOverlay) active.blur()
}
