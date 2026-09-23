package com.campus.market.dto;

import com.campus.market.entity.Goods;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 我的收藏（对应前端 `Favorite`）
 * <p>
 * 前端要的是 `{ id, goodsId, goods: {...}, createTime }` —— `goods` 里必须有
 * 标题/价格/封面/状态，否则收藏列表只能显示一串 id，点不进去也看不出是什么。
 */
@Data
public class FavoriteItem {
    private Long id;
    private Long goodsId;
    private Goods goods;
    private LocalDateTime createTime;
}
