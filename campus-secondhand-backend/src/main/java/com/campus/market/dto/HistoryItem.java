package com.campus.market.dto;

import com.campus.market.entity.Goods;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 浏览足迹（对应前端 `HistoryItem`）
 * <p>
 * 与收藏同理：`goods` 必须内嵌，足迹列表才有东西可渲染。
 */
@Data
public class HistoryItem {
    private Long id;
    private Long goodsId;
    private Goods goods;
    private LocalDateTime viewTime;
}
