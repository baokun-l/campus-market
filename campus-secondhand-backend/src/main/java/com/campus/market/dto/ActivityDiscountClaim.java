package com.campus.market.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 活动对外的让利声明（对应前端 `ActivityDiscountClaim`）
 * <p>
 * C2C 平台的商品定价权在卖家手里，平台只能**公示**卖家或平台自己给出的让利，
 * 不能单方面承诺折扣。所以活动里的折扣力度必须是**结构化**的：
 * 前台价格与活动文案都以它为准，卖家报名时也只能在「声明覆盖到的分类」里选。
 * <p>
 * {@code rate} 是**最低折扣率**：0.5 表示「5 折起」（即最低价 = 挂牌价 × 0.5）。
 * 取 0.5 表示「最多让到半价」；越接近 1 力度越浅。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class ActivityDiscountClaim {

    /**
     * 分类 id。
     * <p>
     * ⚠️ 类型必须与 {@code Goods.categoryId}（{@code Long}）**一致**，不要改成 Integer ★
     * <p>
     * 让利声明的匹配就是「商品分类 == 声明分类」。两边一旦一个是 Long、一个是 Integer，
     * {@code categoryId.equals(...)} 会**恒为 false**（包装类型不跨类型比较），
     * 表现为「卖家报名了活动、发布后却没有让利价」，而代码看起来毫无问题 ——
     * 这类 bug 只在运行时出现，编译期一点提示都没有。
     */
    private Long categoryId;

    /** 最低折扣率：0.5 = 5 折起（0 &lt; rate &lt; 1） */
    private Double rate;
}
