package com.campus.market.dto;

import com.campus.market.entity.Goods;
import lombok.Data;

import java.math.BigDecimal;

/**
 * 热销榜一行（对应前端 `HotGoodsRow`）
 * <p>
 * 排序依据是**成交单数**而非浏览量 —— 浏览量高只说明有人围观，
 * 成交才算真实带货能力。
 */
@Data
public class HotGoodsRow {
    private Goods goods;
    /** 成交单数 */
    private Integer soldCount;
    /** 成交金额 */
    private BigDecimal amount;
}
