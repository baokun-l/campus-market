package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 商品留言实体（留言表：用户-商品留言、留言-留言评论回复）
 * <p>
 * 两层结构：顶层留言（parentId = null）与回复（parentId 指向父留言）。
 */
@Data
@TableName("t_comment")
public class Comment {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long goodsId;
    private Long userId;
    private String userName;
    private String userAvatar;
    private String content;
    /** 回复的父留言 id；顶层为 null */
    private Long parentId;
    /** 被回复人昵称（冗余，展示「回复 @xxx」） */
    private String replyToName;
    private LocalDateTime createTime;
}
