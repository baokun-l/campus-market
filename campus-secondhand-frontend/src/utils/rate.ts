/**
 * 费率单位的边界换算：百分比（界面）↔ 比率（线上）。
 *
 * ★ 为什么需要这个工具 ★
 * 平台服务费率在两侧的表达不一致，而**没有任何一处做过换算**：
 *
 *   · 后端契约：`t_settings.commission_rate` 是 `DECIMAL(5,4)`，语义为**比率**（0 ~ 1）。
 *     `AnalyticsService.saveSettings` 按 0 ~ 1 校验，写 `2` 直接抛 1001
 *     「平台佣金比例应在 0 ~ 1 之间（当前 2.0）」。
 *   · 界面契约：`SettingsPanel.vue` 的表单是**百分比**（0 ~ 20，带 `%` 后缀，
 *     并以「累计成交额 × 费率 ÷ 100」估算平台收入）。
 *
 * 于是管理员只要动一下「服务费率」再点保存，整个设置页就报错 ——
 * 而输入框里那个数看起来完全合法。这类错误的共同特征是：
 * **两侧各自的校验都通过，只有真正提交时才炸**，所以它既不会被表单校验拦住，
 * 也不会被只测 Mock 分支的单测发现（Mock 里存的就是百分比，自洽）。
 *
 * ★ 换算只应发生一次，且必须在边界上 ★
 * 调用点放在 `api/settings.ts`（唯一同时知道「界面格式」与「线上格式」的地方）。
 * 若在上层 View 里换算，Mock 数据、日志文案、单测都要跟着改口径。
 *
 * ★ 为什么收敛到 4 位小数 ★
 * `DECIMAL(5,4)` 只能存 4 位小数。浮点除法会给出 `0.005000000000000001` 这类尾数，
 * 多余位数被 MySQL 静默截断后，「保存 0.5% 再读回来」可能与提交值不同，
 * 表单的「已修改 N 项」提示会永远挂着消不掉。在边界上先 `toFixed(4)`，
 * 是保证「存进去 = 读出来」的唯一写法。
 */

/** 比率 → 百分比：0.02 → 2 */
export function ratioToPercent(ratio: unknown): number {
  return scale(ratio, 100)
}

/** 百分比 → 比率：2 → 0.02 */
export function percentToRatio(percent: unknown): number {
  return scale(percent, 1 / 100)
}

/**
 * 统一收口：非法输入一律回落 0，不让 NaN / undefined 流进表单或请求体
 * （NaN 序列化成 JSON 会变成 `null`，后端会当「显式传 null」处理，比报错更难查）。
 */
function scale(value: unknown, factor: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Number((value * factor).toFixed(4))
}
