package com.campus.market.dto;

import com.campus.market.entity.Activity;
import lombok.Data;

/**
 * 活动展示模型（对应前端 `ActivityDisplay`）
 * <p>
 * ★ 为什么状态（state）由**服务端**算好下发，而不是前端自己按时间戳判断 ★
 * <p>
 * 前端与后端各算一遍，就会出现「后台列表说『已到期』、首页 Banner 还在倒计时」
 * 这种同一活动两个结论的分裂。状态、到期时间、剩余毫秒必须同源，
 * 以服务端时钟为准 —— 客户端时间被改过也不会显示出还没开始的活动。
 */
@Data
public class ActivityDisplay {

    private Activity config;

    /** pending / active / expired / cancelled */
    private String state;

    /** 到期时间戳（ms）= startAt + durationDays × 86400000 */
    private Long expiresAt;

    /** 剩余毫秒数（已过期则为 0，不会出现负数倒计时） */
    private Long remainingMs;

    /** 是否该在**前台**展示：仅 active / pending */
    private Boolean shouldShow;
}
