package com.campus.market.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * 订单「单个状态」的单数与金额合计
 * <p>
 * 订单工作台的概览卡要同时给出每个状态的**笔数**和**金额**：
 * 只有笔数看不出「3 笔售后」和「3 笔售后、涉及 ¥8000」的区别。
 * <p>
 * 分组的聚合放在 Java 里做（见 {@code OrderService#fetchAdminOrderStats}），
 * SQL 只负责按状态汇总 —— 这样分组口径（哪几个状态合成「售后中」）
 * 只有一处定义，不会出现「页签数字与卡片数字对不上」。
 */
@Data
public class OrderStatusStat {
    /** pending_payment / pending_ship / shipped / received / completed / refunding / cancelled */
    private String status;
    /** 该状态的订单笔数 */
    private Integer cnt;
    /**
     * 该状态的金额合计。
     * <p>
     * 注意：**待付款不计入** —— 钱还没收到，算进任何一张卡的金额里都是虚增，
     * 前端 mock 的算法与此一致（`o.status === 'pending_payment' ? 0 : o.amount`）。
     */
    private BigDecimal amt;
}
