package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 钱包流水实体（钱包流水表：每一次余额变动的账）
 * <p>
 * ★★ 为什么「余额」和「流水」必须同时存在 ★★
 * <p>
 * 只有 {@code t_user.balance} 时，「余额为什么是 37.50」这个问题无法回答 ——
 * 用户来问钱去哪了，平台只能看到终点、看不到过程。
 * 只有流水时，每次查余额都要把所有记录求和，一旦中间漏记一条就永久错账。
 * <p>
 * 所以两者分工明确，并由**同一事务**保证同步：
 * <ul>
 *   <li>{@code t_user.balance} —— 现状。由**条件 UPDATE** 原子维护
 *       （{@code SET balance = balance - ? WHERE id = ? AND balance >= ?}），
 *       并发安全，且「扣不动」这件事本身就能被用来判定余额不足；</li>
 *   <li>{@code t_wallet_log} —— 过程。每次改动插一条，金额带正负号。</li>
 * </ul>
 *
 * ★ {@link #balanceAfter} 是刻意冗余的一列 ★
 * <p>
 * 它让「账对不对」变成一次逐行比对：**每条流水的 balance_after 应当等于
 * 上一条的 balance_after 加本条 amount**（同用户、按 id 升序）。
 * 只存 amount 的话，对账得自己从头累加，且一旦中间有一条被误删，
 * 后面的记录全都对不上，却看不出是从哪里断的。
 * <p>
 * 注意它不是「余额快照」意义上的冗余 —— 它记录的是**那一刻**的余额，
 * 与当前余额不同，两者都不能少。
 */
@Data
@TableName("t_wallet_log")
public class WalletLog {

    /** 入账（充值 / 退款） */
    public static final String TYPE_RECHARGE = "recharge";
    public static final String TYPE_REFUND = "refund";
    /** 出账（支付） */
    public static final String TYPE_PAY = "pay";

    /**
     * 类型 → 中文名。
     * <p>
     * ★ 映射表放在这里，而不是前端再维护一份 ★
     * 前端各写一份枚举映射的后果是：后端将来加一种类型（如 {@code adjust} 人工调账），
     * 前端那一份不会跟着改，流水列表里就会出现一行字面量 {@code adjust}。
     * 放在常量旁边，加类型时改一处即可；未识别的类型**原样返回**而不是显示"未知"，
     * 这样新增类型即使忘了补映射，页面上也还能看出是什么。
     */
    public static String labelOf(String type) {
        if (TYPE_RECHARGE.equals(type)) return "充值";
        if (TYPE_REFUND.equals(type)) return "退款";
        if (TYPE_PAY.equals(type)) return "支付";
        return type;
    }

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** 变动金额：正 = 入账，负 = 出账 */
    private BigDecimal amount;

    /** 变动后余额（对账用，见类注释） */
    private BigDecimal balanceAfter;

    /** recharge / pay / refund */
    private String type;

    /** 关联业务号（支付单号或订单号）—— 从一条流水能追到具体是哪笔交易 */
    private String bizId;

    private String remark;
    private LocalDateTime createTime;
}
