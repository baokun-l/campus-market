package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Category;
import com.campus.market.entity.Goods;
import com.campus.market.entity.User;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.CategoryMapper;
import com.campus.market.mapper.CommentMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.ReviewMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.math.BigDecimal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 每日发布上限（{@code t_settings.max_publish_per_day}）真正生效的测试。
 * <p>
 * ★ 守的是「后台那个输入框真的能拦住人」★
 * <p>
 * 这个配置项此前是「存得进、读得出、不产生任何行为」：管理员把上限改成 2 也拦不住谁，
 * 改回 10 也没有任何变化。一个看起来能配置、实际不生效的开关，
 * 比根本没有这个开关更容易误导人 —— 所以它必须有行为，且行为必须被钉住。
 * <p>
 * ★ 两条边界要同时守住 ★
 * <ol>
 *   <li><b>0 = 不限</b>：这是前端表单上的文案（{@code SettingsPanel.vue}「0 表示不限」），
 *       必须与后端一致，否则管理员按提示填 0 反而会变成「一件都不许发」；</li>
 *   <li><b>拒绝时一行都不能写</b>：超限必须在 insert 之前拦下，不能先落库再补删 ——
 *       那会让「今天发了两件、其中一件被系统悄悄删掉」这种不可解释的结果出现在用户面前。</li>
 * </ol>
 * <p>
 * 构造方式沿用 {@link GoodsServiceBatchStatusTest}：直接 new 出 {@code GoodsService} 并塞入 mock Mapper。
 */
class GoodsServicePublishLimitTest {

    private static final long SELLER_ID = 3L;
    private static final long CATEGORY_ID = 1L;

    private GoodsMapper goodsMapper;
    private CategoryMapper categoryMapper;
    private UserMapper userMapper;
    private AnalyticsService analyticsService;
    private GoodsService service;

    @BeforeAll
    static void registerEntityMetadata() {
        // 发布上限的那条统计查询用了 LambdaQueryWrapper<Goods>，解析列名要读实体元数据
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Goods.class);
    }

    @BeforeEach
    void setUp() {
        goodsMapper = mock(GoodsMapper.class);
        categoryMapper = mock(CategoryMapper.class);
        userMapper = mock(UserMapper.class);
        analyticsService = mock(AnalyticsService.class);

        service = new GoodsService(
                goodsMapper,
                categoryMapper,
                mock(AuditLogMapper.class),
                userMapper,
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(CommentMapper.class),
                mock(ReviewMapper.class),
                mock(ActivityService.class),
                analyticsService);

        // 卖家：active 账号，才能走到「发布上限」这一步
        User seller = new User();
        seller.setId(SELLER_ID);
        seller.setStatus("active");
        seller.setNickname("卖家小王");
        when(userMapper.selectById(SELLER_ID)).thenReturn(seller);

        // 分类必须真实存在：validatePublishPayload 会反查并回填分类名
        Category category = new Category();
        category.setId(CATEGORY_ID);
        category.setName("教材");
        when(categoryMapper.selectById(CATEGORY_ID)).thenReturn(category);
    }

    /** 造一个能通过 publishGoods 全部入参校验的商品 */
    private static Goods validGoods() {
        Goods g = new Goods();
        g.setTitle("高等数学 同济第七版");
        g.setPrice(new BigDecimal("18.00"));
        g.setCategoryId(CATEGORY_ID);
        g.setStock(1);
        return g;
    }

    @Test
    @DisplayName("上限 0 → 不限制：查询都不发，正常发布成功")
    void zeroLimitMeansUnlimited() {
        when(analyticsService.maxPublishPerDay()).thenReturn(0);

        service.publishGoods(validGoods(), SELLER_ID);

        // 上限为 0 时不该产生「今天发了几件」这条额外查询
        verify(goodsMapper, never()).selectCount(any());
        verify(goodsMapper).insert(any());
    }

    @Test
    @DisplayName("已达上限 → 1001，且商品一行都没插入")
    void overLimitIsRejectedBeforeInsert() {
        when(analyticsService.maxPublishPerDay()).thenReturn(3);
        when(goodsMapper.selectCount(any())).thenReturn(3L);

        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.publishGoods(validGoods(), SELLER_ID));

        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(),
                "超限属于业务拒绝（1001），不是服务端故障（500）");
        // ★ 关键：先拦后写，绝不允许「先落库再补删」★
        verify(goodsMapper, never()).insert(any());
    }

    @Test
    @DisplayName("超出上限（已发 4 件，上限 3）→ 同样 1001 且不落库")
    void farOverLimitIsAlsoRejected() {
        when(analyticsService.maxPublishPerDay()).thenReturn(3);
        when(goodsMapper.selectCount(any())).thenReturn(4L);

        assertThrows(BusinessException.class, () -> service.publishGoods(validGoods(), SELLER_ID));
        verify(goodsMapper, never()).insert(any());
    }

    @Test
    @DisplayName("未达上限（差一件）→ 放行")
    void underLimitIsAllowed() {
        when(analyticsService.maxPublishPerDay()).thenReturn(3);
        when(goodsMapper.selectCount(any())).thenReturn(2L);

        service.publishGoods(validGoods(), SELLER_ID);

        verify(goodsMapper).insert(any());
    }

    @Test
    @DisplayName("上限 1 且今天一件都没发 → 放行（边界：第一件不算超限）")
    void firstPublishOfTheDayIsAllowedWhenLimitIsOne() {
        when(analyticsService.maxPublishPerDay()).thenReturn(1);
        when(goodsMapper.selectCount(any())).thenReturn(0L);

        service.publishGoods(validGoods(), SELLER_ID);

        verify(goodsMapper).insert(any());
    }

    @Test
    @DisplayName("上限 1 且今天已发 1 件 → 拒绝（边界：等于上限即算满）")
    void secondPublishOfTheDayIsRejectedWhenLimitIsOne() {
        when(analyticsService.maxPublishPerDay()).thenReturn(1);
        when(goodsMapper.selectCount(any())).thenReturn(1L);

        assertThrows(BusinessException.class, () -> service.publishGoods(validGoods(), SELLER_ID));
        verify(goodsMapper, never()).insert(any());
    }

    @Test
    @DisplayName("统计口径落在当前卖家 + 今天之后（不能把别人的商品算进来）")
    void countIsScopedToTheSeller() {
        when(analyticsService.maxPublishPerDay()).thenReturn(2);
        when(goodsMapper.selectCount(any())).thenReturn(0L);

        service.publishGoods(validGoods(), SELLER_ID);

        // 查询条件必须是「seller_id = 当前卖家 AND create_time >= 今天零点」
        // 这里用捕获到的 wrapper 的 SQL 片段做断言，防止有人把条件写漏
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Wrapper<Goods>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(goodsMapper).selectCount(captor.capture());
        String sql = captor.getValue().getSqlSegment();
        assertTrue(sql.contains("seller_id"), "统计必须按卖家隔离，实际 SQL：" + sql);
        assertTrue(sql.contains("create_time"), "统计必须是「今天之后」，实际 SQL：" + sql);
    }
}
