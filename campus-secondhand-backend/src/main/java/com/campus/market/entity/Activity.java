package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import com.campus.market.dto.ActivityDiscountClaim;
import lombok.Data;

import java.util.List;

/**
 * 限时活动实体（活动表：活动-让利声明-资金归属）
 * <p>
 * ★ 主键是**业务字符串 id**，不是自增数字 ★
 * <p>
 * 活动 id 会被写进商品（{@code t_goods.activity_id}）与订单快照，
 * 用自增数字意味着「换库/重导数据后 id 变了」，历史订单里的 activityId
 * 就指向了另一条活动 —— 让利归属会算错。业务 id（如
 * {@code back-to-school-2026-fall}）跨环境稳定，可读、可对账。
 * <p>
 * ★ 时间字段一律是 **毫秒时间戳（Long）** ★
 * <p>
 * 前端 `ActivityConfig` 的 startAt / createTime / updateTime 都是 number，
 * 倒计时直接做减法。若这里用 LocalDateTime 序列化成 ISO 字符串，
 * 前端每一处都要再 Date.parse 一次，漏一处就是 NaN 倒计时。
 * <p>
 * ★ highlights / claims 是 JSON 列，API 层必须是数组 ★
 * <p>
 * 与 `Goods.images` 同一处理：库里 TEXT 存 JSON，出参必须是真数组，
 * 否则前端 `v-for` 会退化成逐字符遍历（「卖家」「让利」被拆成一堆单字 chip）。
 */
@Data
@TableName(value = "t_activity", autoResultMap = true)
public class Activity {

    /** 活动 id（业务主键，如 back-to-school-2026-fall） */
    @TableId(type = IdType.INPUT)
    private String id;

    /** 是否上架：false = 管理员手动下架（状态判定为 cancelled） */
    private Boolean enabled;

    /** 活动开始时间戳（ms） */
    private Long startAt;

    /** 活动天数 */
    private Integer durationDays;

    /** 主标题 */
    private String title;

    /** 副标题 / 导引文案 */
    private String subtitle;

    /** CTA 按钮文案 */
    private String ctaText;

    /** CTA 跳转链接 */
    private String ctaLink;

    /** 卖点 chip 列表（DB 存 JSON 数组，API 输出 string[]） */
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<String> highlights;

    /** 大表情 */
    private String icon;

    /** 配色主题：orange / blue / green / purple */
    private String theme;

    /** 优先级，数字越大越先展示 */
    private Integer priority;

    /** 谁承担让利成本：seller（卖家让利）/ platform（平台补贴） */
    private String fundSource;

    /** 让利清单（DB 存 JSON 数组）；不涉及改价的活动为空数组 */
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<ActivityDiscountClaim> claims;

    /** 后台备注（仅管理端可见） */
    private String note;

    /** 创建时间戳（ms） */
    private Long createTime;

    /** 更新时间戳（ms） */
    private Long updateTime;

    /** 管理员下架时间戳（ms），用于日志展示 */
    private Long cancelledAt;

    /** 管理员下架操作者 */
    private String cancelledBy;

    /**
     * 卖点 chip 列表。**出参永远是数组**。
     * <p>
     * 前端 `ActivityConfig.highlights` 是必填的 {@code string[]}，
     * 直接 {@code v-for} 渲染；null 会让整个 Banner 渲染中断。
     */
    public List<String> getHighlights() {
        return highlights == null ? List.of() : highlights;
    }

    /**
     * 让利声明。**出参永远是数组**。
     * <p>
     * 前端要用它做 `claims.find(c => c.categoryId === id)` —— 一旦是 null，
     * 卖家发布页会直接抛错（「当前分类暂无活动」的分支都走不到）。
     */
    public List<ActivityDiscountClaim> getClaims() {
        return claims == null ? List.of() : claims;
    }
}
