package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 评价实体（评价表：订单-评价-用户-被评价人）
 * <p>
 * 首评一经提交不再可改；追评是另起一个字段追加（appendContent / appendTime）。
 */
@Data
@TableName("t_review")
public class Review {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String orderId;
    private Long goodsId;
    private Long fromUserId;
    private String fromUserName;
    private String fromUserAvatar;
    private Long toUserId;
    /** 星级 1-5 */
    private Integer rating;
    private String content;
    /** 追评内容 */
    private String appendContent;
    private LocalDateTime appendTime;
    private LocalDateTime createTime;
}
