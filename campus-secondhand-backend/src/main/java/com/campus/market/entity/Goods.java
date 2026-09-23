package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 商品实体（商品表：商品-分类-卖家-审核）
 * <p>
 * 挂牌价（price）是平台记录在案的真实价格，也是划线价的唯一来源；
 * promoPrice 是卖家让利后的活动价，未参与活动为 null。
 * <p>
 * images 在库里是 TEXT（JSON 数组），在 API 层必须是字符串数组 ——
 * 前端 `Goods.images: string[]` 直接用于 v-for 渲染，若原样透传 JSON 字符串
 * 会退化成逐字符遍历。故用 JacksonTypeHandler 在持久层完成 JSON ↔ List 转换。
 */
@Data
@TableName(value = "t_goods", autoResultMap = true)
public class Goods {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String title;
    /** 卖家挂牌价（真实价格） */
    private BigDecimal price;
    /** 活动让利价；未参与活动为 null */
    private BigDecimal promoPrice;
    /** 参与的活动 id */
    private String activityId;
    private String cover;
    /** 图片集（DB 存 JSON 数组，API 输出 string[]） */
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<String> images;
    private String description;
    /** on_sale / off_shelf / sold / pending */
    private String status;
    /** 可售数量（库存），未填视为 1 */
    private Integer stock;
    /** face / express / self */
    private String deliveryMethod;
    private Long categoryId;
    private String categoryName;
    private Long sellerId;
    private String sellerName;
    private String sellerAvatar;
    private String location;
    private Integer viewCount;
    private Integer favoriteCount;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;

    /**
     * 图片集。**出参永远是数组，不会是 null**。
     * <p>
     * ★ 为什么要在读取侧兜这一下 ★
     * <p>
     * 库里的 {@code images} 是可以为 NULL 的（老数据、发布时未传图），
     * 而前端 `types/index.ts` 把 {@code images} 声明为**必填**的 {@code string[]}。
     * 原样把 null 透出去，前端的 `goods.images.map(...)`、
     * `[cover, ...goods.images]` 这类写法会直接抛 TypeError ——
     * 一件「没上传图」的商品就足以把整个详情页打白。
     * <p>
     * 写入侧语义不变：DB 里该是 NULL 还是 NULL（MyBatis-Plus 回写时读到的
     * 是空列表，落库为 {@code []}，与 NULL 在业务上等价，都是「没有图」）。
     */
    public List<String> getImages() {
        return images == null ? List.of() : images;
    }
}
