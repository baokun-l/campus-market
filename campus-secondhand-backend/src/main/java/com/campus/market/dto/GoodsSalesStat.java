package com.campus.market.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * 商品成交统计原始行（热销榜的 SQL 投影）
 */
@Data
public class GoodsSalesStat {
    private Long goodsId;
    /** 成交单数 */
    private Integer soldCount;
    /** 成交金额 */
    private BigDecimal amount;
}
