package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.History;
import org.apache.ibatis.annotations.Mapper;

/**
 * 浏览历史数据访问层
 */
@Mapper
public interface HistoryMapper extends BaseMapper<History> {}
