package com.campus.market.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 发起支付的返回体（前端收银台据此渲染下一步）。
 * <p>
 * ★★ 为什么要把 {@code kind} 明确返回给前端，而不是后端自己跳转 ★★
 * <p>
 * 三种渠道的「下一步」形态不同：支付宝给的是**跳转地址**，将来接扫码支付会给
 * **二维码内容**，钱包与演示渠道**当场就完成了**。前端必须知道该渲染哪一种，
 * 否则只能靠「url 非空就跳转」这种猜测 —— 一旦某条渠道两者都返回，前端就抓瞎。
 * <p>
 * 所以这里用显式的 {@link Kind} 枚举把三种形态写进契约：
 * <ul>
 *   <li>{@link Kind#REDIRECT} —— 前端 {@code window.location.href = url}；</li>
 *   <li>{@link Kind#QR} —— 前端把 {@code qrCode} 渲染成二维码并开始轮询；</li>
 *   <li>{@link Kind#DONE} —— 已经付完了，前端直接刷新订单，不必轮询。</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PayLaunch(
        String paymentId,
        String orderId,
        String channel,
        String channelLabel,
        BigDecimal amount,
        Kind kind,
        /** REDIRECT 时的收银台地址 */
        String url,
        /** QR 时的二维码内容 */
        String qrCode,
        /** 给用户看的一句话（「钱包支付 ¥45.00 已完成，剩余余额 ¥455.00」） */
        String message,
        /** 支付截止时间（前端据此显示倒计时） */
        LocalDateTime expireAt,
        /** 支付单当前状态（DONE 时已是 success） */
        String status,
        /** 钱包渠道支付后的剩余余额；其它渠道为 null */
        BigDecimal balance) {

    public enum Kind {
        REDIRECT, QR, DONE
    }
}
