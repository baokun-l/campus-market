package com.campus.market.service;

import com.campus.market.dto.ActivityDiscountClaim;
import com.campus.market.entity.Activity;
import com.campus.market.mapper.ActivityMapper;
import com.campus.market.mapper.AuditLogMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 活动状态判定与让利归属解析测试。
 * <p>
 * ★ 守的是「谁掏的钱不能记错」与「状态由服务端时钟说了算」★
 * <ul>
 *   <li>{@code fundSourceFor()} 是结算与后台统计的唯一入口。同一分类可以挂两条活动
 *       （一条卖家让利、一条平台补贴），一旦归属判错，后台 GMV 会把平台掏的钱算到卖家头上，
 *       卖家看到的实收也凭空变少 —— 报价类系统里最不能接受的一类错误。</li>
 *   <li>状态判定顺序（先看 enabled 再看时间）反了的话，被下架的活动第二天会
 *       因为「仍在有效期内」自己回到前台。</li>
 * </ul>
 */
class ActivityServiceClaimTest {

    private static final long DAY = 86_400_000L;
    private static final long CATEGORY = 5L;

    /**
     * 基准时刻必须取**真实时钟**，不能写成固定时间戳。
     * <p>
     * {@code claimActivity()} 刻意用 {@code System.currentTimeMillis()} 判定状态
     * （这正是「状态由服务端时钟说了算」的实现方式），如果这里写一个固定值，
     * 相对真实时钟它可能落在未来 —— 于是「已到期」的用例实际上构造出了一个「待开始」的活动，
     * 测试就变成了假绿。相对偏移（±N 天）不受此影响。
     */
    private static final long NOW = System.currentTimeMillis();

    private ActivityMapper activityMapper;
    private ActivityService service;

    @BeforeEach
    void setUp() {
        activityMapper = mock(ActivityMapper.class);
        service = new ActivityService(activityMapper, mock(AuditLogMapper.class));
        // 让 seedIfEmpty() 认为表非空，避免测试里去打桩「插入出厂活动」
        when(activityMapper.selectCount(any())).thenReturn(1L);
    }

    /** 造一条活动：startAt 相对此刻的偏移、声明某分类的折扣率 */
    private Activity activity(String id, boolean enabled, long startOffsetDays, int days,
                              String fundSource, List<ActivityDiscountClaim> claims) {
        Activity a = new Activity();
        a.setId(id);
        a.setEnabled(enabled);
        a.setStartAt(NOW + startOffsetDays * DAY);
        a.setDurationDays(days);
        a.setPriority(50);
        a.setFundSource(fundSource);
        a.setClaims(claims);
        a.setHighlights(List.of());
        return a;
    }

    private ActivityDiscountClaim claim(long categoryId, double rate) {
        return new ActivityDiscountClaim(categoryId, rate);
    }

    // ==================== 状态判定 ====================

    @Test
    @DisplayName("状态由服务端时钟算：未开始 = pending，进行中 = active，超期 = expired")
    void stateByClock() {
        assertEquals("pending", service.stateOf(activity("a", true, 2, 7, "seller", List.of()), NOW));
        assertEquals("active", service.stateOf(activity("a", true, -1, 7, "seller", List.of()), NOW));
        assertEquals("expired", service.stateOf(activity("a", true, -30, 7, "seller", List.of()), NOW));
    }

    @Test
    @DisplayName("先看 enabled 再看时间：下架的活动即使仍在有效期内也必须是 cancelled")
    void disabledWinsOverTime() {
        Activity off = activity("a", false, -1, 7, "seller", List.of());
        assertEquals("cancelled", service.stateOf(off, NOW));
        // 反过来的话，下架的第二天它会因为「仍在有效期内」自己回到前台
    }

    @Test
    @DisplayName("刚好到期的瞬间算 expired（边界不留给「还在跑」的错觉）")
    void expiresExactlyAtDeadline() {
        Activity a = activity("a", true, -7, 7, "seller", List.of());
        assertEquals("expired", service.stateOf(a, NOW));
    }

    // ==================== 报名口径：只认进行中 ====================

    @Test
    @DisplayName("报名只认进行中的活动：待开始的活动不能用来生成让利价")
    void onlyActiveIsJoinable() {
        Activity pending = activity("future", true, 2, 7, "seller", List.of(claim(CATEGORY, 0.8)));
        when(activityMapper.selectById("future")).thenReturn(pending);

        assertNull(service.claimActivity("future", CATEGORY, true),
                "活动还没开始就让商品打折，是「活动没生效、价格先降」的经典缺陷");
        assertNotNull(service.claimActivity("future", CATEGORY, false),
                "结算口径允许待开始：商品一旦报名就带着 activityId，不该因此查不到");
    }

    @Test
    @DisplayName("已下架 / 已到期的活动两边都不认")
    void cancelledAndExpiredAreNeverValid() {
        when(activityMapper.selectById("off")).thenReturn(
                activity("off", false, -1, 7, "platform", List.of(claim(CATEGORY, 0.8))));
        when(activityMapper.selectById("old")).thenReturn(
                activity("old", true, -30, 7, "platform", List.of(claim(CATEGORY, 0.8))));

        assertNull(service.claimActivity("off", CATEGORY, false));
        assertNull(service.claimActivity("old", CATEGORY, false));
    }

    @Test
    @DisplayName("活动没声明该分类 → 查不到（不让商品蹭上别的分类的折扣）")
    void categoryMustBeDeclared() {
        when(activityMapper.selectById("a")).thenReturn(
                activity("a", true, -1, 7, "seller", List.of(claim(1L, 0.5))));
        assertNull(service.claimActivity("a", CATEGORY, false));
        assertNull(service.rateOf(activity("a", true, -1, 7, "seller", List.of(claim(1L, 0.5))), CATEGORY));
    }

    // ==================== 资金归属 ====================

    @Test
    @DisplayName("优先认商品自己的 activityId：同分类两条活动，各记各的账")
    void resolveByActivityIdFirst() {
        Activity sellerFund = activity("seller-act", true, -1, 7, "seller", List.of(claim(CATEGORY, 0.8)));
        sellerFund.setPriority(90);
        Activity platformFund = activity("platform-act", true, -1, 7, "platform", List.of(claim(CATEGORY, 0.85)));
        platformFund.setPriority(10);
        when(activityMapper.selectById("platform-act")).thenReturn(platformFund);
        when(activityMapper.selectById("seller-act")).thenReturn(sellerFund);

        assertEquals("platform", service.fundSourceFor("platform-act", CATEGORY));
        assertEquals("seller", service.fundSourceFor("seller-act", CATEGORY));
    }

    @Test
    @DisplayName("★ activityId 非空却解析不到（活动被删/下架/到期）→ 回落 seller，绝不借分类反查改写归属")
    void unresolvableActivityIdNeverFallsBackToCategory() {
        Activity high = activity("high", true, -1, 7, "platform", List.of(claim(CATEGORY, 0.85)));
        high.setPriority(99);
        when(activityMapper.selectList(any())).thenReturn(List.of(high));

        // activityId 指向的活动已经查不到了（被删除 / 下架 / 到期）
        when(activityMapper.selectById("ghost")).thenReturn(null);

        /*
         * 商品**报过名**（activityId 非空）= 这单让利的归属已被那次报名锁定。
         * 锁定过的活动没了，只能认「卖家让利」；
         * 若这里回落到「按分类反查」，就会命中同分类下 fundSource 相反的 high（平台补贴），
         * 于是平台凭空多出一笔它从未承诺的支出 —— 归属判错，正是本类头注释要防的事。
         */
        assertEquals("seller", service.fundSourceFor("ghost", CATEGORY));
    }

    @Test
    @DisplayName("activityId 缺失（老数据）才回退按分类反查，且取优先级最高的那条")
    void legacyGoodsWithoutActivityIdFallsBackToCategory() {
        Activity low = activity("low", true, -1, 7, "seller", List.of(claim(CATEGORY, 0.8)));
        low.setPriority(10);
        Activity high = activity("high", true, -1, 7, "platform", List.of(claim(CATEGORY, 0.85)));
        high.setPriority(99);
        when(activityMapper.selectList(any())).thenReturn(List.of(low, high));

        // 商品压根没有 activityId（早期版本未落该字段）→ 只能按分类反查
        assertEquals("platform", service.fundSourceFor(null, CATEGORY));
        // 纯空白同样视为「没有」
        assertEquals("platform", service.fundSourceFor("   ", CATEGORY));
    }

    @Test
    @DisplayName("resolvedActivityId：活动可解析才给 id，否则 null（不留查不到的孤儿 activityId）")
    void resolvedActivityIdOnlyWhenResolvable() {
        when(activityMapper.selectById("live")).thenReturn(
                activity("live", true, -1, 7, "seller", List.of(claim(CATEGORY, 0.8))));
        when(activityMapper.selectById("ghost")).thenReturn(null);

        assertEquals("live", service.resolvedActivityId("live", CATEGORY));
        assertNull(service.resolvedActivityId("ghost", CATEGORY));
        assertNull(service.resolvedActivityId(null, CATEGORY));
    }

    @Test
    @DisplayName("谁都没声明 → 一律回落到 seller（宁可少声称平台补贴）")
    void defaultIsSeller() {
        when(activityMapper.selectList(any())).thenReturn(List.of());
        assertEquals("seller", service.fundSourceFor("ghost", CATEGORY));
        assertEquals("seller", service.fundSourceFor("ghost", null));
    }
}
