package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Goods;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.CategoryMapper;
import com.campus.market.mapper.CommentMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.ReviewMapper;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 批量修改商品状态（{@link GoodsService#batchUpdateStatus}）的校验缺口测试。
 * <p>
 * ★ 守的是「批量上架绕过审核」+「状态白名单缺失」两条缺陷 ★
 * <p>
 * 单条通道 {@code updateGoodsStatus} 早就修了这两道闸（白名单 476 行、待审挡板 477 行），
 * 批量通道原先一个都没有：{@code teleport} 能落库、勾一件 pending 点「批量上架」直接变 on_sale。
 * 下面每条用例对应一种绕过尝试，修复后都必须收敛。
 * <p>
 * 构造方式沿用 {@link GoodsServiceVisibilityTest} / {@link GoodsServicePromoPricingTest}：
 * 直接 new 出 {@code GoodsService} 并塞入 mock Mapper。
 */
class GoodsServiceBatchStatusTest {

    private static final long G1 = 1L;
    private static final long G2 = 2L;
    private static final long G3 = 3L;

    private GoodsMapper goodsMapper;
    private AuditLogMapper auditLogMapper;
    private GoodsService service;

    @BeforeEach
    void setUp() {
        goodsMapper = mock(GoodsMapper.class);
        auditLogMapper = mock(AuditLogMapper.class);
        service = new GoodsService(
                goodsMapper,
                mock(CategoryMapper.class),
                auditLogMapper,
                mock(UserMapper.class),
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(CommentMapper.class),
                mock(ReviewMapper.class),
                mock(ActivityService.class),
                // 每日发布上限来自系统配置；本测试只覆盖状态闸门，配置给个不限制的桩即可
                mock(AnalyticsService.class));
    }

    /** 造一件指定状态的商品（只关心 id / status 两个字段） */
    private static Goods goods(long id, String status) {
        Goods g = new Goods();
        g.setId(id);
        g.setStatus(status);
        return g;
    }

    @Test
    @DisplayName("status 非法（如 teleport）→ 抛 1001，且 batchUpdateStatus mapper 从未被调用")
    void illegalStatusIsRejectedAndMapperNeverCalled() {
        List<Long> ids = List.of(G1, G2);
        // 白名单在校验最前面就拦下，连 selectBatchIds 都不该触发
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.batchUpdateStatus(ids, "teleport"));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(), "非法状态必须按 1001 返回");
        // 校验在 mapper 之前，SQL 一次都不能发出去
        verify(goodsMapper, never()).batchUpdateStatus(anyList(), any());
        verify(goodsMapper, never()).selectBatchIds(any());
    }

    @Test
    @DisplayName("status=on_sale 且选中含 pending → 整体拒绝（1001），mapper 从未被调用")
    void batchOnSaleWithPendingRejectedAndMapperNeverCalled() {
        List<Long> ids = List.of(G1, G2);
        // 拉当前状态时发现 G1 还在审核中
        when(goodsMapper.selectBatchIds(ids))
                .thenReturn(List.of(goods(G1, "pending"), goods(G2, "off_shelf")));

        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.batchUpdateStatus(ids, "on_sale"));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(), "绕过审核必须按 1001 返回");
        // 含待审商品：要么全做要么不做，绝不能部分成功 → SQL 一次都不能发
        verify(goodsMapper, never()).batchUpdateStatus(anyList(), any());
    }

    @Test
    @DisplayName("status=off_shelf 且选中含 pending → 允许，mapper 调用一次，返回条数正确")
    void batchOffShelfWithPendingIsAllowed() {
        List<Long> ids = List.of(G1, G2);
        // 把待审商品批量下架是正当处置，不该被第 ② 道闸拦
        when(goodsMapper.selectBatchIds(ids))
                .thenReturn(List.of(goods(G1, "pending"), goods(G2, "off_shelf")));

        int updated = service.batchUpdateStatus(ids, "off_shelf");

        assertEquals(2, updated, "返回值语义是更新条数，等于入参 id 数");
        verify(goodsMapper).batchUpdateStatus(eq(ids), eq("off_shelf"));
    }

    @Test
    @DisplayName("status=on_sale 且选中全是 off_shelf → 允许，mapper 调用一次，且审计日志有写入")
    void batchOnSaleAllOffShelfAllowedAndAuditLogged() {
        List<Long> ids = List.of(G1, G2);
        when(goodsMapper.selectBatchIds(ids))
                .thenReturn(List.of(goods(G1, "off_shelf"), goods(G2, "off_shelf")));

        int updated = service.batchUpdateStatus(ids, "on_sale");

        assertEquals(2, updated);
        verify(goodsMapper).batchUpdateStatus(eq(ids), eq("on_sale"));
        // 正常路径审计日志必须落地（真正更新的 id 集合 == 入参 ids）
        verify(auditLogMapper).insert(any());
    }
}
