package com.campus.market.dto;

import java.math.BigDecimal;

/**
 * 充值入参。
 * <p>
 * ★ {@code amount} 为什么声明成 {@link BigDecimal} 而不是 double / Double ★
 * <p>
 * Jackson 从 JSON 文本直接构造 BigDecimal 时，走的是**十进制字符串**路径，
 * 不经过二进制浮点。若声明成 double，{@code 100.1} 会先被解析成
 * 100.099999999999994315658113919198513031005859375，再传给我们 ——
 * 金额从这里开始就已经不准了，后面怎么归一都是补救。
 * 钱相关的入参一律用 BigDecimal，这是唯一不引入误差的接法。
 * <p>
 * ★ 没有 userId 字段是刻意的 ★
 * <p>
 * 给谁充值只能由 JWT 决定（见 {@code WalletController} 的取用方式）。
 * 一旦入参里带 userId，任何人只要在请求体里换一个数字
 * 就能给别人（或自己）任意加钱 —— 这是**直接就变成钱的**漏洞。
 *
 * @param amount    充值金额（元）。两位小数，见 {@code WalletService#recharge}
 * @param requestId 幂等键，可空。同一次充值的重试必须复用同一个值
 */
public record WalletRechargeRequest(BigDecimal amount, String requestId) {
}
