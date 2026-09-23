package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.entity.Goods;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.CategoryMapper;
import com.campus.market.mapper.CommentMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.ReviewMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 商品详情「浏览量自增」的写法测试。
 * <p>
 * ★ 守的是「详情页不能把别人刚扣掉的库存盖回去」★
 * <p>
 * {@code fetchGoodsDetail} 是**全站写入最频繁**的接口（每看一次商品写一行），
 * 它与「下单扣库存」天然并发。原实现是
 * {@code selectById 读整实体 → setViewCount(+1) → updateById 整体回写}：
 * <ul>
 *   <li>买家 A 打开详情，读到 {@code stock = 1}；</li>
 *   <li>买家 B 下单，{@code OrderService} 用 {@code stock = stock - qty} 原子扣到 0，订单成立；</li>
 *   <li>A 的这次请求把整行（含 {@code stock = 1}）写回去 ⇒ <b>防超卖被旁路，库存凭空多出一件</b>。</li>
 * </ul>
 * 同一瞬间卖家改过的 {@code price}、别人加上的 {@code favorite_count} 也会被一并还原成旧值。
 * <p>
 * 修复后只发一条**单列原子自增**（不读整行，就不可能覆盖别的列）。
 * 本文件把「绝不 updateById」这条性质钉死，防止将来有人「顺手改回整实体回写」。
 */
class GoodsServiceViewCountTest {

    private static final long GOODS_ID = 1L;
    private static final long SELLER = 5L;

    private GoodsMapper goodsMapper;
    private GoodsService service;

    @BeforeEach
    void setUp() {
        goodsMapper = mock(GoodsMapper.class);
        service = new GoodsService(
                goodsMapper,
                mock(CategoryMapper.class),
                mock(AuditLogMapper.class),
                mock(UserMapper.class),
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(CommentMapper.class),
                mock(ReviewMapper.class),
                mock(ActivityService.class),
                mock(AnalyticsService.class));
        // fetchGoodsDetail 走 LambdaUpdateWrapper<Goods>：set() 解析列名需要实体元数据，
        // 纯单测没有 MyBatis 启动流程，手动注册一次（等价于容器扫描实体的那一步）
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Goods.class);
    }

    private Goods givenOnSaleGoods(Integer viewCount) {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setSellerId(SELLER);
        g.setStatus("on_sale");
        g.setStock(1);
        g.setViewCount(viewCount);
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
        return g;
    }

    @Test
    @DisplayName("★ 浏览量自增走「单列原子 UPDATE」，绝不 updateById 整实体回写")
    void viewCountUsesSingleColumnUpdate() {
        givenOnSaleGoods(41);

        service.fetchGoodsDetail(GOODS_ID, null, null);

        // 只发一条 .setSql 单列自增，以主键为条件；不是整实体回写
        verify(goodsMapper).update(isNull(), any());
        verify(goodsMapper, never()).updateById(any());
    }

    @Test
    @DisplayName("返回给前端的展示值在内存里 +1（不为了 ±1 的精确度再补一次读）")
    void returnedValueIsIncrementedInMemory() {
        givenOnSaleGoods(41);

        Goods got = service.fetchGoodsDetail(GOODS_ID, null, null);

        assertEquals(42, got.getViewCount(), "展示值应为原值 +1");
    }

    @Test
    @DisplayName("★ 老数据 view_count 为 NULL：按 0 起算，不让浏览量永远停在空值上")
    void nullViewCountStartsFromZero() {
        givenOnSaleGoods(null);

        Goods got = service.fetchGoodsDetail(GOODS_ID, null, null);

        assertEquals(1, got.getViewCount(), "NULL 应视作 0 再加 1（SQL 侧由 COALESCE 保证同一口径）");
        verify(goodsMapper, never()).updateById(any());
    }
}
