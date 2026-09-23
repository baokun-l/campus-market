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
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 商品可见性规则测试（列表侧收敛 + 详情侧判定）。
 * <p>
 * ★ 这两个口子都是**真实发生过**的越权缺陷，且都属于「功能测试永远测不出来」的那类 ★
 * <ol>
 *   <li><b>详情侧</b>：广场里看不见「审核中 / 已下架」的商品，但直接按 id 访问详情却能读到 ——
 *       把详情链接发出去就绕过了审核闸门；因违规被下架的商品也仍可访问，下架意图没真正生效。</li>
 *   <li><b>列表侧</b>：可见状态白名单由**调用方**通过 {@code ?statuses=} 自己声明，
 *       服务端照单全收。于是匿名只要多带一个 {@code ?statuses=pending} 就能把口子重新打开。</li>
 * </ol>
 * 两者的共同教训是同一句话：**把访问控制交给调用方，等于没有控制**。
 * 所以这里逐个身份、逐个越界条件地钉住行为，防止将来有人「顺手简化」掉这段收敛逻辑。
 */
class GoodsServiceVisibilityTest {

    private static final long SELLER = 5L;
    private static final long OTHER_USER = 9L;
    private static final long GOODS_ID = 1L;

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
                // 本测试只覆盖「可见性收敛」，不触碰发布流程，所以活动服务给个空实现即可
                mock(ActivityService.class),
                // 同上：发布上限配置与可见性无关，给个不限制的桩
                mock(AnalyticsService.class));
    }

    // ==================== 列表侧：越界筛选条件必须被收敛 ====================

    /**
     * 调一次列表接口，并断言**实际下发给 SQL 的状态条件**。
     * <p>
     * 断言点在 Mapper 入参而不是返回值 —— 因为这条规则的实现方式就是「改写查询条件」，
     * 返回什么由数据库决定，而「收敛后的条件是什么」才是服务端的责任。
     */
    private void assertEffectiveStatus(String status, List<String> statuses,
                                       Long viewerId, String viewerRole, Long sellerId,
                                       String expectedStatus, List<String> expectedStatuses) {
        service.fetchGoods(1, 10, null, null, sellerId, status, statuses, null, viewerId, viewerRole);
        verify(goodsMapper).selectGoodsPage(
                any(),
                isNull(), isNull(),
                sellerId == null ? isNull() : eq(sellerId),
                expectedStatus == null ? isNull() : eq(expectedStatus),
                expectedStatuses == null ? isNull() : eq(expectedStatuses),
                isNull());
    }

    @Test
    @DisplayName("匿名不带条件 → 收敛到默认可见范围 [on_sale, sold]（不再是全量）")
    void anonymousWithoutStatusGetsDefaultScope() {
        assertEffectiveStatus(null, null, null, null, null,
                null, List.of("on_sale", "sold"));
    }

    @Test
    @DisplayName("匿名显式传 statuses=pending → 越界条件被剔除，退回默认范围（P1-12 回归）")
    void anonymousCannotWidenScopeByStatuses() {
        assertEffectiveStatus(null, List.of("pending"), null, null, null,
                null, List.of("on_sale", "sold"));
    }

    @Test
    @DisplayName("匿名传 status=pending → 同样被剔除（换一种参数名也绕不过去）")
    void anonymousCannotWidenScopeByStatus() {
        assertEffectiveStatus("pending", null, null, null, null,
                null, List.of("on_sale", "sold"));
    }

    @Test
    @DisplayName("越界与合法条件混传 → 只保留合法的那部分，不整体放行")
    void mixedConditionsKeepOnlyAllowed() {
        assertEffectiveStatus(null, List.of("on_sale", "pending", "off_shelf"), null, null, null,
                null, List.of("on_sale"));
    }

    @Test
    @DisplayName("匿名只传合法单状态 → 原样执行，且清空 statuses 避免 AND 打架")
    void allowedSingleStatusPassesThrough() {
        assertEffectiveStatus("on_sale", null, null, null, null,
                "on_sale", null);
    }

    @Test
    @DisplayName("登录买家（非卖家本人）同样被收敛 —— 只看「登录了」是不够的")
    void loggedInBuyerIsStillConstrained() {
        assertEffectiveStatus(null, List.of("pending", "off_shelf"), OTHER_USER, "user", null,
                null, List.of("on_sale", "sold"));
    }

    @Test
    @DisplayName("后台角色 → 条件原样执行，可拿全量（后台商品管理依赖这条）")
    void backendRoleIsUnrestricted() {
        assertEffectiveStatus(null, null, OTHER_USER, "admin", null, null, null);
    }

    @Test
    @DisplayName("goods_admin 同样视为后台角色")
    void goodsAdminIsUnrestricted() {
        assertEffectiveStatus(null, null, OTHER_USER, "goods_admin", null, null, null);
    }

    @Test
    @DisplayName("report_admin 同样视为后台角色")
    void reportAdminIsUnrestricted() {
        assertEffectiveStatus(null, null, OTHER_USER, "report_admin", null, null, null);
    }

    @Test
    @DisplayName("卖家查自己（sellerId == 自己）→ 放开，否则「我的发布」看不到待审/已下架")
    void sellerViewingOwnGoodsIsUnrestricted() {
        assertEffectiveStatus(null, List.of("pending", "off_shelf"), SELLER, "user", SELLER,
                null, List.of("pending", "off_shelf"));
    }

    @Test
    @DisplayName("卖家传别人的 sellerId → 不享受放开待遇（否则随便填个 id 就成后台了）")
    void sellerCannotBorrowOthersSellerId() {
        assertEffectiveStatus(null, List.of("pending"), SELLER, "user", OTHER_USER,
                null, List.of("on_sale", "sold"));
    }

    // ==================== 详情侧：不可见返 404 而非 403 ====================

    private Goods givenGoods(String status) {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setStatus(status);
        g.setSellerId(SELLER);
        g.setViewCount(0);
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
        return g;
    }

    @Test
    @DisplayName("on_sale / sold → 匿名也能看（买家要能浏览，已售出要能参考行情）")
    void openStatusesVisibleToAnonymous() {
        Goods onSale = givenGoods("on_sale");
        assertSame(onSale, service.fetchGoodsDetail(GOODS_ID, null, null));

        Goods sold = givenGoods("sold");
        assertSame(sold, service.fetchGoodsDetail(GOODS_ID, null, null));
    }

    @Test
    @DisplayName("pending → 匿名读不到，返回 404（不是 403，403 会泄露存在性）")
    void pendingHiddenFromAnonymous() {
        givenGoods("pending");
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.fetchGoodsDetail(GOODS_ID, null, null));
        assertEquals(BusinessCode.NOT_FOUND, ex.getCode());
    }

    @Test
    @DisplayName("off_shelf → 匿名与无关登录用户都读不到（下架必须真正生效）")
    void offShelfHiddenFromOutsiders() {
        givenGoods("off_shelf");
        assertEquals(BusinessCode.NOT_FOUND,
                assertThrows(BusinessException.class,
                        () -> service.fetchGoodsDetail(GOODS_ID, null, null)).getCode());
        assertEquals(BusinessCode.NOT_FOUND,
                assertThrows(BusinessException.class,
                        () -> service.fetchGoodsDetail(GOODS_ID, OTHER_USER, "user")).getCode());
    }

    @Test
    @DisplayName("卖家本人能看自己的 pending / off_shelf（「我的发布 → 查看」依赖这条，别回归）")
    void ownerCanSeeOwnHiddenGoods() {
        Goods pending = givenGoods("pending");
        assertSame(pending, service.fetchGoodsDetail(GOODS_ID, SELLER, "user"));

        Goods offShelf = givenGoods("off_shelf");
        assertSame(offShelf, service.fetchGoodsDetail(GOODS_ID, SELLER, "user"));
    }

    @Test
    @DisplayName("后台角色能看任意状态的详情（审核台 / 举报台要打开目标商品）")
    void backendRolesCanSeeAnyStatus() {
        givenGoods("pending");
        assertSame(givenGoods("pending"), service.fetchGoodsDetail(GOODS_ID, OTHER_USER, "goods_admin"));
        assertSame(givenGoods("pending"), service.fetchGoodsDetail(GOODS_ID, OTHER_USER, "report_admin"));
        assertSame(givenGoods("pending"), service.fetchGoodsDetail(GOODS_ID, OTHER_USER, "admin"));
    }

    @Test
    @DisplayName("商品不存在 → 404")
    void missingGoodsIs404() {
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(null);
        assertEquals(BusinessCode.NOT_FOUND,
                assertThrows(BusinessException.class,
                        () -> service.fetchGoodsDetail(GOODS_ID, null, null)).getCode());
    }

    @Test
    @DisplayName("浏览量列允许为空：view_count=null 不能把详情页打成 500")
    void nullViewCountDoesNotBreakDetail() {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setStatus("on_sale");
        g.setSellerId(SELLER);
        g.setViewCount(null);
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);

        Goods got = service.fetchGoodsDetail(GOODS_ID, null, null);
        assertEquals(1, got.getViewCount());
    }
}
