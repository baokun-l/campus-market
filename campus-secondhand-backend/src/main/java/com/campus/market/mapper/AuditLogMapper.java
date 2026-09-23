package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.AuditLog;
import org.apache.ibatis.annotations.Mapper;

/**
 * 系统操作日志数据访问层
 */
@Mapper
public interface AuditLogMapper extends BaseMapper<AuditLog> {}
