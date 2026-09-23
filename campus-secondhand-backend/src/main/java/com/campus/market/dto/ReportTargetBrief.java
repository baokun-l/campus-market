package com.campus.market.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 举报"被举报对象现状快照"（对应前端 `ReportTargetBrief`）
 * <p>
 * 处理举报不能只看举报文案：必须能当场看到被举报对象**现在**是什么状态
 * （商品还在不在架、卖家信用分多少、描述与图片是否自相矛盾），处置决定才有依据。
 * 所以商品类举报要给出完整商品档案，而不是一行小卡。
 */
@Data
public class ReportTargetBrief {

    /** 对象是否还存在（商品/用户可能已被删除） */
    private Boolean exists;
    /** 展示标题：商品标题 / 用户昵称 / 订单号 */
    private String title;
    /** 当前状态标签（在售中 / 已下架 / 正常 / 已封禁 …） */
    private String statusLabel;
    /** Element Plus tag 类型 */
    private String statusType;

    /* ---------- 用户类 ---------- */
    private Integer creditScore;
    private String avatar;

    /* ---------- 商品 / 订单类 ---------- */
    private String sellerName;
    private String buyerName;
    private String cover;
    private BigDecimal price;

    /* ---------- 商品类：完整商品档案 ---------- */
    /** 挂牌价（划线价的唯一来源） */
    private BigDecimal listPrice;
    /** 活动让利价（未参加活动为 null） */
    private BigDecimal promoPrice;
    private String description;
    private String categoryName;
    private String location;
    private Integer stock;
    private String deliveryMethod;
    /** 图片集（判定「图片有使用痕迹」的直接证据） */
    private List<String> images;
    private LocalDateTime createTime;
    private Integer viewCount;
    private Integer favoriteCount;
}
