package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 平台公告实体（公告表：管理员发布，前台展示）
 */
@Data
@TableName("t_notice")
public class Notice {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String title;
    private String content;
    private Boolean pinned;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
