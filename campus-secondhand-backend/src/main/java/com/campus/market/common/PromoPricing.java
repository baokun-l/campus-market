package com.campus.market.common;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

/**
 * 让利价算法 —— 与前端 `src/utils/promo.ts` **逐行对应**的唯一实现。
 * <p>
 * ★ 为什么后端必须自己算，而不能采信请求体里的 {@code promoPrice} ★
 * <p>
 * 二手平台是居间撮合方，商品定价权在卖家手里，但**折扣力度不是卖家能自定的**：
 * 活动声明的才是规则（「教材 5 折起」），卖家只能决定「参不参加」。
 * 此前 {@code GoodsService.publishGoods(Goods, Long)} 直接把请求体反序列化成实体落库，
 * 于是任何登录用户都能自己 POST 一个 {@code {"price": 999, "promoPrice": 1}} ——
 * 平台一分钱没答应让，商品却以 1 元挂上了「让利」标签。
 * <p>
 * ★ 与前端保持同一算法，是为了「预览价 == 成交价」★
 * <p>
 * 发布页在提交前就把最终价格显示给卖家（{@code settleJoin()}）；
 * 如果服务端另用一套取整/取档规则，卖家看到的「省 240」到了详情页会变成「省 250」。
 * 所以下面的阶梯与取档规则是**照抄**前端实现的，两边任一处改动都必须同步另一边。
 */
public final class PromoPricing {

    private PromoPricing() {
    }

    /** 折扣阶梯的递进步长（与前端 `promoRateLadder` 的 0.05 一致） */
    private static final double STEP = 0.05;

    /**
     * 声明的折扣率 → 同分类内的让利档位阶梯。
     * <p>
     * 活动声明的是「最高 N 折」（0.5 = 5 折起，即最深力度），但同分类里每件商品
     * 让多少是卖家各自决定的，所以从声明值起取三档：0.5 → [0.5, 0.55, 0.6]。
     * 阶梯**全部 ≥ 声明值**，保证「实际折扣不比活动声明的更深」——
     * 比声明更深意味着平台擅自超卖了卖家没答应的折扣。
     */
    public static List<Double> rateLadder(double rate) {
        double base = round2(rate);
        List<Double> ladder = new ArrayList<>();
        for (double r : new double[]{base, round2(base + STEP), round2(base + 2 * STEP)}) {
            if (r > 0 && r < 1) ladder.add(r);
        }
        // 声明值本身就越界（≥1）时退化为单档，避免空列表让调用方踩空
        if (ladder.isEmpty()) ladder.add(base);
        return ladder;
    }

    /**
     * 某件商品报名某活动时**实际落在阶梯的哪一档**。
     * <p>
     * 用挂牌价取模选档，而不是随机数：选档规则必须可预览、可复现，
     * 这样「发布页看到的价」与「提交后落库的价」必然一致（前端注释同款理由）。
     */
    public static double rateFor(BigDecimal listPrice, double rate) {
        List<Double> ladder = rateLadder(rate);
        int idx = listPrice == null ? 0 : listPrice.setScale(0, RoundingMode.DOWN).intValue() % ladder.size();
        return ladder.get(Math.abs(idx) % ladder.size());
    }

    /**
     * 由折扣率算出让利价（结果恒 ≥ 1，不出现 0 元或负价）。
     * <p>
     * 取整用「向下取整」而非四舍五入：少收一分钱的风险由平台/卖家承担，
     * 但不能出现「算出来的价高于声明价」这种反向偏差。
     */
    public static BigDecimal promoPriceFor(BigDecimal listPrice, double rate) {
        if (listPrice == null) return null;
        BigDecimal price = listPrice.multiply(BigDecimal.valueOf(rate)).setScale(0, RoundingMode.FLOOR);
        BigDecimal min = BigDecimal.ONE;
        return price.compareTo(min) < 0 ? min : price;
    }

    /**
     * 结算结果：让利价 + 资金归属拆出来的三项金额。
     * <p>
     * 三个金额必须满足恒等式 {@code sellerCut + platformSubsidy + payAmount == listPrice}，
     * 否则后台对账时会出现「拆项加起来不等于总额」的离谱账。
     */
    public record Settlement(BigDecimal listPrice, BigDecimal payAmount, BigDecimal sellerCut,
                             BigDecimal platformSubsidy, BigDecimal sellerIncome, boolean onPromo) {
    }

    /**
     * 结算一件商品（对应前端 `settlePrice()`）。
     * <p>
     * {@code promoPrice} 只有「大于 0 且低于挂牌价」时才成立 —— 数据脏了也绝不能算出负让利。
     */
    public static Settlement settle(BigDecimal listPrice, BigDecimal promoPrice, String fundSource) {
        BigDecimal list = nz(listPrice);
        boolean onPromo = promoPrice != null && promoPrice.signum() > 0 && promoPrice.compareTo(list) < 0;
        BigDecimal pay = onPromo ? promoPrice : list;
        BigDecimal delta = list.subtract(pay).setScale(2, RoundingMode.HALF_UP);

        boolean platform = "platform".equals(fundSource);
        BigDecimal sellerCut = onPromo && !platform ? delta : BigDecimal.ZERO;
        BigDecimal platformSubsidy = onPromo && platform ? delta : BigDecimal.ZERO;
        return new Settlement(list, pay, sellerCut, platformSubsidy, list.subtract(sellerCut), onPromo);
    }

    private static BigDecimal nz(BigDecimal v) {
        return v == null ? BigDecimal.ZERO : v;
    }

    /**
     * 保留两位小数。偏移量取 {@code Math.ulp(1.0)}（= 2.22e-16），
     * 与前端 `Number.EPSILON` **同值** —— 这样 1.005 这类边界值的进位结果两边一致，
     * 不会出现「前端 1.01、后端 1.00」的价格分歧。
     */
    private static double round2(double n) {
        return Math.round((n + Math.ulp(1.0)) * 100) / 100.0;
    }
}
