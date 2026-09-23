package com.campus.market.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 数据大屏趋势的一个点（对应前端 `{ date, pv, uv, orders }`）
 * <p>
 * 三个指标都取自**真实库表**，口径如下：
 * <ul>
 *   <li><b>pv</b>（浏览量）：当日 {@code t_history} 记录数 —— 商品详情页每次打开
 *       都会 {@code POST /user/history} 落一条足迹，它本来就是一份访问日志；</li>
 *   <li><b>uv</b>（访客数）：当日 {@code t_history} 的去重用户数；</li>
 *   <li><b>orders</b>（订单数）：当日 {@code t_order} 下单数。</li>
 * </ul>
 * 不引入额外的埋点表，也不做任何系数放大。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class TrendPoint {
    /** yyyy-MM-dd */
    private String date;
    private Long pv;
    private Long uv;
    private Long orders;
}
