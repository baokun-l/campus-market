package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Activity;
import org.apache.ibatis.annotations.Mapper;

/**
 * 限时活动数据访问层
 * <p>
 * 活动表没有联表查询需求（让利声明随活动一起读），
 * 因此只用 MyBatis-Plus 的通用 CRUD，无需 XML。
 */
@Mapper
public interface ActivityMapper extends BaseMapper<Activity> {}
