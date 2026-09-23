package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Category;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;
import java.util.Map;

/**
 * 分类数据访问层
 */
@Mapper
public interface CategoryMapper extends BaseMapper<Category> {
    /** 分类 + 商品数（后台分类管理列表） */
    List<Map<String, Object>> selectCategoryStats();
}
