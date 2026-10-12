package com.campus.market.dto;

import java.math.BigDecimal;

/**
 * 一次校园币充值的结果。
 * <p>
 * ★ 为什么回的是「余额」而不是「充值后余额」★
 * <p>
 * 两个字段看起来是一回事，但 {@link #balance} 读的是**事务内重新查库**得到的真实值，
 * 而不是「充值前余额 + amount」在内存里算出来的。并发下后者用的是过期快照，会算错。
 * 前端拿这个值直接刷新余额显示，不需要自己再算一遍，也就不会算错。
 *
 * @param rechargeId 本次充值的流水号（幂等键，也是流水表里的 biz_id）
 * @param amount     实际入账金额（已按两位小数归一）
 * @param balance    入账后的钱包余额（重新查库得到）
 * @param message    给用户看的一句话
 */
public record WalletRechargeResult(String rechargeId, BigDecimal amount, BigDecimal balance, String message) {
}
