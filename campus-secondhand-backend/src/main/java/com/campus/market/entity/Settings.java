package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * 平台参数实体（系统设置表）
 */
@Data
@TableName("t_settings")
public class Settings {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String siteName;
    private String servicePhone;
    private String announceText;
    private Boolean goodsAuditRequired;
    private Integer maxPublishPerDay;
    private Integer autoOfflineDays;
    private Boolean reportAutoHide;
    private Double commissionRate;
}
