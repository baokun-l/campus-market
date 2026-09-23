package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 私信消息实体（消息表：用户-用户-会话-消息）
 * <p>
 * 会话 id 规则：s_{goodsId}_{minUserId}_{maxUserId}
 * 双方各自登录后都能在自己的消息中心看到同一条会话记录。
 * <p>
 * 已读字段刻意命名为 {@code read}（列名 is_read）而非 {@code isRead}：
 * 前端 `Message.read` 是它唯一的判断依据，Lombok 对 `isRead` 生成的是
 * `getIsRead()`，Jackson 会输出成 `isRead`，两边对不上。
 */
@Data
@TableName(value = "t_message", autoResultMap = true)
public class Message {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String sessionId;
    private Long fromUserId;
    private Long toUserId;
    private String content;
    @TableField("is_read")
    private Boolean read;
    private LocalDateTime createTime;
}
