package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 系统操作日志实体（审计流水表：管理员每个有副作用的动作都写一条）
 */
@Data
@TableName("t_audit_log")
public class AuditLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String action;
    private String actionLabel;
    private String target;
    private String detail;
    private String operator;
    private LocalDateTime createTime;
}
