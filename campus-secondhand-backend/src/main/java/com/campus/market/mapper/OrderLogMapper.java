package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.OrderLog;
import org.apache.ibatis.annotations.Mapper;

/**
 * 订单操作日志数据访问层
 */
@Mapper
public interface OrderLogMapper extends BaseMapper<OrderLog> {}
