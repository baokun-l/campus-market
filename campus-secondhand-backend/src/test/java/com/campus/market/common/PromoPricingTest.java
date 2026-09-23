package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 让利价算法测试 —— 守的是两件事：
 * <ol>
 *   <li><b>与前端同规则</b>：{@code src/utils/promo.ts} 的 {@code promoRateLadder / promoRateFor /
 *       promoPriceFor / settlePrice} 是本文件 Java 实现的对照物。两边一旦漂移，
 *       卖家在发布页看到的价与落库成交的价就会是两个数。</li>
 *   <li><b>恒等式不破</b>：{@code sellerCut + platformSubsidy + payAmount == listPrice}。
 *       破了就是后台对账时「拆项加起来不等于总额」。</li>
 * </ol>
 */
class PromoPricingTest {

    private static final double EPS = 1e-9;

    /**
     * 金额断言统一用 {@code compareTo} 而不是 {@code equals}：
     * BigDecimal 的 equals 连**精度**一起比，{@code 200} 与 {@code 200.00} 会被判为不等，
     * 于是测试会因为「小数位数」这种与业务无关的差别而红 —— 账目只关心数值。
     */
    private static void assertAmount(String expected, BigDecimal actual) {
        assertEquals(0, new BigDecimal(expected).compareTo(actual),
                "期望 " + expected + "，实际 " + actual);
    }

    @Test
    @DisplayName("阶梯：从声明值起按 0.05 取三档，且全部 ≥ 声明值")
    void rateLadder() {
        assertEquals(List.of(0.5, 0.55, 0.6), PromoPricing.rateLadder(0.5));
        assertEquals(List.of(0.8, 0.85, 0.9), PromoPricing.rateLadder(0.8));
        // 越界声明（≥1）退化为单档，不能返回空列表让人踩空
        assertEquals(List.of(1.0), PromoPricing.rateLadder(1.0));
        for (double r : PromoPricing.rateLadder(0.5)) {
            assertTrue(r >= 0.5, "档位不得低于活动声明的力度");
        }
    }

    @Test
    @DisplayName("阶梯上界被 1 截断：0.95 只留一档，绝不出现 ≥1 的折扣率")
    void rateLadderClamped() {
        // 0.95 + 0.05 = 1.0 与 0.95 + 0.1 = 1.05 都不满足 (0,1)，被过滤掉
        assertEquals(List.of(0.95), PromoPricing.rateLadder(0.95));
        for (double r : PromoPricing.rateLadder(0.95)) {
            assertTrue(r < 1, "折扣率必须严格小于 1，否则「让利价」会等于挂牌价、让利形同虚设");
        }
    }

    @Test
    @DisplayName("取档用挂牌价取模，同价同档 —— 发布页预览与落库结果必然一致")
    void rateForIsDeterministic() {
        // floor(100) % 3 = 1 → ladder[1]
        assertEquals(0.55, PromoPricing.rateFor(new BigDecimal("100"), 0.5), EPS);
        assertEquals(0.55, PromoPricing.rateFor(new BigDecimal("100"), 0.5), EPS);
        // floor(101) % 3 = 2 → ladder[2]
        assertEquals(0.6, PromoPricing.rateFor(new BigDecimal("101"), 0.5), EPS);
        // 小数挂牌价按向下取整选档（99.9 → 99 → 99 % 3 = 0 → ladder[0]）
        assertEquals(0.5, PromoPricing.rateFor(new BigDecimal("99.9"), 0.5), EPS);
    }

    @Test
    @DisplayName("让利价恒 ≥ 1，且不高于挂牌价（不出现 0 元、负价、越算越贵）")
    void promoPriceFloor() {
        assertEquals(new BigDecimal("50"), PromoPricing.promoPriceFor(new BigDecimal("100"), 0.5));
        // 向下取整：95 × 0.85 = 80.75 → 80（宁可少收一分，也不能算出高于声明的价）
        assertEquals(new BigDecimal("80"), PromoPricing.promoPriceFor(new BigDecimal("95"), 0.85));
        // 1 元商品 5 折 → 0.5 → 落到下限 1
        assertEquals(BigDecimal.ONE, PromoPricing.promoPriceFor(BigDecimal.ONE, 0.5));
        assertTrue(PromoPricing.promoPriceFor(new BigDecimal("100"), 0.5)
                .compareTo(new BigDecimal("100")) < 0);
    }

    @Test
    @DisplayName("卖家让利：差价从卖家实收里出，平台补贴为 0")
    void settleSellerFund() {
        PromoPricing.Settlement s = PromoPricing.settle(new BigDecimal("200"), new BigDecimal("160"), "seller");
        assertTrue(s.onPromo());
        assertAmount("160", s.payAmount());
        assertAmount("40", s.sellerCut());
        assertAmount("0", s.platformSubsidy());
        assertAmount("160", s.sellerIncome()); // 卖家实收 = 挂牌价 − 让利
    }

    @Test
    @DisplayName("平台补贴：卖家实收不变，差价记在平台头上")
    void settlePlatformFund() {
        PromoPricing.Settlement s = PromoPricing.settle(new BigDecimal("200"), new BigDecimal("160"), "platform");
        assertTrue(s.onPromo());
        assertAmount("160", s.payAmount());
        assertAmount("0", s.sellerCut()); // 平台补贴不该让卖家少收钱
        assertAmount("40", s.platformSubsidy());
        assertAmount("200", s.sellerIncome());
    }

    @Test
    @DisplayName("无让利价 / 让利价 ≥ 挂牌价 → 视为未参与，按挂牌价成交")
    void settleWithoutPromo() {
        PromoPricing.Settlement noPromo = PromoPricing.settle(new BigDecimal("200"), null, "seller");
        assertFalse(noPromo.onPromo());
        assertAmount("200", noPromo.payAmount());
        assertAmount("0", noPromo.sellerCut());

        // 脏数据（让利价比挂牌价还高）不能算出「负让利」
        PromoPricing.Settlement dirty = PromoPricing.settle(new BigDecimal("200"), new BigDecimal("260"), "seller");
        assertFalse(dirty.onPromo());
        assertAmount("200", dirty.payAmount());
        assertAmount("0", dirty.sellerCut());
        assertAmount("0", dirty.platformSubsidy());
    }

    @Test
    @DisplayName("恒等式：sellerCut + platformSubsidy + payAmount == listPrice")
    void settlementIdentity() {
        BigDecimal[][] cases = {
                {new BigDecimal("199"), new BigDecimal("99")},
                {new BigDecimal("1234.56"), new BigDecimal("987.65")},
                {new BigDecimal("7"), new BigDecimal("1")},
        };
        for (String fund : List.of("seller", "platform")) {
            for (BigDecimal[] c : cases) {
                PromoPricing.Settlement s = PromoPricing.settle(c[0], c[1], fund);
                assertEquals(0, s.listPrice().compareTo(
                        s.sellerCut().add(s.platformSubsidy()).add(s.payAmount())),
                        "拆项之和必须等于挂牌价：" + s);
            }
        }
    }
}
