package com.campus.market.service;

import com.campus.market.entity.Activity;
import com.campus.market.entity.Category;
import com.campus.market.entity.Goods;
import com.campus.market.entity.User;
import com.campus.market.dto.ActivityDiscountClaim;
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

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;

/**
 * 发布商品时的**服务端让利定价**测试。
 * <p>
 * ★ 守的是「折扣只能来自活动声明，不能来自客户端」★
 * <p>
 * 发布接口的入参直接就是 {@code Goods} 实体，也就是请求方能自由写
 * {@code price} / {@code promoPrice} / {@code activityId}。此前这三个字段原样落库，
 * 于是任何登录用户都能 POST 一个 {@code {"price": 999, "promoPrice": 1}}：
 * 平台从没答应过这个折扣，商品却挂着「让利」标签卖出去，订单快照里的卖家实收也变成 1 元。
 * <p>
 * 下面每条用例都对应一种「绕过」的尝试，修复后都必须收敛到「按活动声明算」或「不参与活动」。
 */
class GoodsServicePromoPricingTest {

    private static final long SELLER = 5L;
    private static final long CATEGORY = 5L;   // 生活用品：两条活动同时声明
    private static final String ACTIVE_ACTIVITY = "dorm-upgrade-2026";

    private GoodsMapper goodsMapper;
    private CategoryMapper categoryMapper;
    private ActivityService activityService;
    private UserMapper userMapper;
    private GoodsService service;

    @BeforeEach
    void setUp() {
        goodsMapper = mock(GoodsMapper.class);
        categoryMapper = mock(CategoryMapper.class);
        activityService = mock(ActivityService.class);
        userMapper = mock(UserMapper.class);
        service = new GoodsService(
                goodsMapper,
                categoryMapper,
                mock(AuditLogMapper.class),
                userMapper,
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(CommentMapper.class),
                mock(ReviewMapper.class),
                activityService,
                // 本测试只覆盖让利价计算；发布上限给个不限制的桩
                mock(AnalyticsService.class));

        /*
         * 发布时 Service 会拿 categoryId 反问分类表（分类名由服务端回填、
         * 幽灵分类直接拒绝），所以这里必须给分类打桩。
         * 不打桩时 selectById 返回 null，会先撞上「商品分类不存在」，
         * 让本类所有用例都在业务校验处就断掉 —— 测不到真正想测的定价规则。
         */
        Category category = new Category();
        category.setId(CATEGORY);
        category.setName("生活用品");
        when(categoryMapper.selectById(CATEGORY)).thenReturn(category);

        User seller = new User();
        seller.setId(SELLER);
        seller.setNickname("卖家");
        seller.setStatus("active");
        seller.setAvatar("avatar");
        when(userMapper.selectById(SELLER)).thenReturn(seller);
        when(goodsMapper.insert(any(Goods.class))).thenReturn(1);
    }

    /** 打桩：活动存在且声明了该分类、折扣率 0.85 */
    private void givenActivityDeclares(Double rate) {
        Activity a = new Activity();
        a.setId(ACTIVE_ACTIVITY);
        a.setTitle("宿舍焕新补贴周");
        a.setFundSource("platform");
        a.setClaims(rate == null ? List.of() : List.of(new ActivityDiscountClaim(CATEGORY, rate)));
        when(activityService.claimActivity(eq(ACTIVE_ACTIVITY), eq(CATEGORY), anyBoolean())).thenReturn(a);
        when(activityService.rateOf(any(), anyLong())).thenReturn(rate);
    }

    private Goods published(BigDecimal price, BigDecimal clientPromoPrice, String activityId) {
        Goods g = new Goods();
        g.setTitle("宿舍小台灯");
        g.setPrice(price);
        g.setPromoPrice(clientPromoPrice);
        g.setActivityId(activityId);
        g.setCategoryId(CATEGORY);
        g.setStock(1);
        return service.publishGoods(g, SELLER);
    }

    @Test
    @DisplayName("客户端自填的 promoPrice 一律被丢弃：让利价只能由活动声明算出")
    void clientSuppliedPromoPriceIsIgnored() {
        givenActivityDeclares(0.85);
        // 卖家谎报 1 元
        Goods g = published(new BigDecimal("100"), BigDecimal.ONE, ACTIVE_ACTIVITY);
        /*
         * 声明值 0.85 只是「最深力度」，实际落档由挂牌价取模决定：
         * 阶梯 [0.85, 0.9, 0.95]，100 % 3 = 1 → 0.9 → 让利价 90。
         * 关键是它**不等于客户端传的 1**，也与前端 settleJoin() 的结果一致。
         */
        assertEquals(0, new BigDecimal("90").compareTo(g.getPromoPrice()),
                "让利价必须按活动声明算出，不能采信请求体");
        assertEquals(ACTIVE_ACTIVITY, g.getActivityId());
    }

    @Test
    @DisplayName("不参加活动时，客户端就算传了 promoPrice / activityId 也要清成空")
    void noActivityMeansNoPromo() {
        Goods g = published(new BigDecimal("100"), new BigDecimal("30"), null);
        assertNull(g.getPromoPrice(), "没报名活动的商品不该带让利价");
        assertNull(g.getActivityId());
    }

    @Test
    @DisplayName("活动已下架 / 已到期 / 不覆盖该分类 → 按挂牌价落库（静默降级，不写脏让利价）")
    void staleActivityFallsBackToFullPrice() {
        when(activityService.claimActivity(eq("ghost"), eq(CATEGORY), anyBoolean())).thenReturn(null);
        Goods g = published(new BigDecimal("100"), new BigDecimal("30"), "ghost");
        assertNull(g.getPromoPrice());
        assertNull(g.getActivityId(), "活动不可用时不能把这个 id 留在商品上 —— 后台会对不上账");
    }

    @Test
    @DisplayName("活动未声明该分类（claims 为空）→ 同样不产生让利价")
    void activityWithoutClaimForCategory() {
        when(activityService.claimActivity(eq(ACTIVE_ACTIVITY), eq(CATEGORY), anyBoolean()))
                .thenReturn(new Activity());
        when(activityService.rateOf(any(), anyLong())).thenReturn(null);
        Goods g = published(new BigDecimal("100"), null, ACTIVE_ACTIVITY);
        assertNull(g.getPromoPrice());
    }

    @Test
    @DisplayName("报名只认进行中的活动：查询时必须带 onlyActive = true")
    void onlyActiveActivitiesAreJoinable() {
        givenActivityDeclares(0.85);
        published(new BigDecimal("100"), null, ACTIVE_ACTIVITY);
        // 待开始的活动还没生效，报名它会让商品「活动没开始就先打折」
        verify(activityService).claimActivity(eq(ACTIVE_ACTIVITY), eq(CATEGORY), eq(true));
    }

    @Test
    @DisplayName("无活动时按挂牌价成交，商品本身仍能正常发布（审核中）")
    void publishStillWorksWithoutActivity() {
        Goods g = published(new BigDecimal("50"), null, null);
        assertEquals("pending", g.getStatus());
        assertEquals(SELLER, g.getSellerId());
    }
}
