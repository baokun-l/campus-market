package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Settings;
import org.apache.ibatis.annotations.Mapper;

/**
 * 系统设置数据访问层
 */
@Mapper
public interface SettingsMapper extends BaseMapper<Settings> {}
