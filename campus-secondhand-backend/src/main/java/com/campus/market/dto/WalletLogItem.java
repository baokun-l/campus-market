package com.campus.market.dto;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 钱包流水的一条（只读展示用）。
 * <p>
 * ★ 为什么不直接返回 {@code WalletLog} 实体 ★
 * <p>
 * 实体上的字段是「数据库长什么样」，接口该暴露的是「前端要显示什么」。
 * 直接返回实体的话，将来往表里加内部列（对账标记、风控标记）会自动出现在响应里，
 * 而且没有任何一处代码会提醒你 —— 这是最典型的「悄悄扩大对外契约」。
 * 显式开一个 DTO，加列时前端不受影响，要暴露得手动加一行。
 *
 * @param id           流水号（自增主键，同时是时间序）
 * @param amount       变动金额：正 = 入账，负 = 出账
 * @param balanceAfter 变动后余额（与 {@code amount} 一起构成可逐行核对的对账链）
 * @param type         机器可读类型：recharge / pay / refund
 * @param typeLabel    中文名（由服务端下发，见 {@code WalletLog#labelOf}）
 * @param bizId        关联业务号（支付单号 / 充值流水号）
 * @param remark       说明
 * @param createTime   发生时间
 */
public record WalletLogItem(Long id, BigDecimal amount, BigDecimal balanceAfter,
                            String type, String typeLabel, String bizId,
                            String remark, LocalDateTime createTime) {
}
