package com.campus.market.dto;

import java.math.BigDecimal;
import java.util.List;

/**
 * 钱包概览：当前余额 + 最近若干条流水。
 * <p>
 * ★ 为什么余额和流水要一起给 ★
 * <p>
 * 只给余额，用户无法回答「我的钱怎么少了」；只给流水，每次都要自己从头累加。
 * 两者一起给，用户能一眼看到「余额是多少」以及「它是怎么变成这样的」，
 * 与 {@code WalletLog} 类注释里「现状 + 过程」的分工是同一条设计。
 *
 * @param balance 当前余额
 * @param logs    最近的流水，**按 id 倒序**（最新在前）
 */
public record WalletSummary(BigDecimal balance, List<WalletLogItem> logs) {
}
