package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Favorite;
import org.apache.ibatis.annotations.Mapper;

/**
 * 收藏数据访问层
 */
@Mapper
public interface FavoriteMapper extends BaseMapper<Favorite> {}
