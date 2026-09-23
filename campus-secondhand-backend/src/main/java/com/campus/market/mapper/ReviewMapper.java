package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.campus.market.entity.Review;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.Map;

/**
 * 评价数据访问层
 */
@Mapper
public interface ReviewMapper extends BaseMapper<Review> {
    List<Review> selectByGoods(@Param("goodsId") Long goodsId);

    List<Review> selectByUser(@Param("userId") Long userId);

    Review selectByOrder(@Param("orderId") String orderId);

    IPage<Map<String, Object>> selectAdminReviews(Page<Map<String, Object>> page,
                                                     @Param("keyword") String keyword,
                                                     @Param("rating") Object rating);
}
