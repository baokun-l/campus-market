package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.campus.market.dto.OrderStatusStat;
import com.campus.market.entity.Order;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.Map;

/**
 * 订单数据访问层
 */
@Mapper
public interface OrderMapper extends BaseMapper<Order> {
    /** 买/卖家我的订单 */
    IPage<Order> selectUserOrders(Page<Order> page,
                                   @Param("userId") Long userId,
                                   @Param("status") String status,
                                   @Param("role") String role);

    /** 管理端多条件检索 */
    IPage<Order> selectAdminOrders(Page<Order> page, @Param("query") Map<String, Object> query);

    /** 管理端导出（不分页） */
    List<Order> selectAdminOrdersForExport(@Param("query") Map<String, Object> query);

    /**
     * 订单工作台总览聚合：总数 / 成交额 / 待处理额 / 已退额 / 今日新增 / 超时单数。
     * 返回 {@code total, gmv, pendingGmv, refundedAmount, todayCount, issues}
     */
    Map<String, Object> selectOrderStats();

    /**
     * 按状态汇总笔数与金额（前端 `AdminOrderStats.byStatus` 与概览卡分组的原始数据）。
     * 分组口径在 Service 层统一拼接，SQL 只按状态聚合。
     */
    List<OrderStatusStat> selectStatusStats();
}
