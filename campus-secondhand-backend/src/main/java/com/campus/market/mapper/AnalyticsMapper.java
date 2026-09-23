package com.campus.market.mapper;

import com.campus.market.dto.GoodsSalesStat;
import com.campus.market.dto.NameValue;
import com.campus.market.dto.TrendPoint;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 统计报表数据访问层
 * <p>
 * 与业务 Mapper 分开：这里的每个查询都是**只读聚合**，
 * 不参与任何写事务，便于单独优化（加索引 / 加缓存）。
 */
@Mapper
public interface AnalyticsMapper {

    /**
     * 按日浏览量与访客数。
     * 数据源是 t_history —— 商品详情页每次打开都会落一条足迹，本身就是访问日志。
     */
    List<TrendPoint> selectDailyViews(@Param("from") LocalDateTime from);

    /** 按日下单数 */
    List<TrendPoint> selectDailyOrders(@Param("from") LocalDateTime from);

    /** 分类商品数占比 */
    List<NameValue> selectCategoryDistribution();

    /**
     * 热销商品：按成交单数排序。
     * 只统计「已付款及之后」的订单状态，未付款/已取消不计入成交。
     */
    List<GoodsSalesStat> selectHotGoods(@Param("limit") int limit);

    /** 操作日志按动作类型计数（goods / user / order …） */
    List<NameValue> countAuditLogsByType();
}
