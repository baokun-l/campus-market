package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 支付单实体（支付单表：一次「支付尝试」的全部痕迹）
 * <p>
 * ★★ 为什么订单表旁边必须再有一张支付单表 ★★
 * <p>
 * 改造前「付款」全靠 {@code t_order.pay_time} 一列承载：前端点一下「确定」，
 * 后端就把订单从 {@code pending_payment} 改成 {@code pending_ship}。这在真实支付里
 * 是不成立的 —— 它连「这笔钱是谁收的」都回答不了，更别说举证与对账：
 * <ul>
 *   <li><b>没有凭证</b>：谁付的、付了多少、走的哪条通道、通道那边的流水号是什么，
 *       一个字都没留下。真出了纠纷，平台拿不出任何第三方证据；</li>
 *   <li><b>一次尝试 ≠ 一笔订单</b>：用户先试余额（失败）再试支付宝（成功），
 *       这两次尝试在库里没有任何痕迹 —— 而它们恰恰是排查支付问题最需要的东西；</li>
 *   <li><b>中间态无处表达</b>：支付可能「已提交、结果未知」（网络断了、回调丢了），
 *       而订单状态只有「待付款 / 待发货」两个格子，装不下 {@code paying} 这种状态。</li>
 * </ul>
 * 所以支付单独建模，并确立一条不变式：
 * <pre>
 *   一笔订单 →（0..N）张支付单，至多一张 success；
 *   订单状态由「支付成功」驱动，而支付成功只由渠道回调（或渠道同步返回）确认。
 * </pre>
 *
 * ★ 状态机（与 {@link com.campus.market.service.PaymentService} 的流转判断一一对应）★
 * <pre>
 *   created  → paying            已建单，尚未把用户送去收银台
 *   paying   → success / failed / closed
 *   created  → success / failed / closed
 *   success  → refunded          原路退回后
 *   failed / closed / refunded 均为终态
 * </pre>
 * <p>
 * ★ 「允许同一订单有多张支付单」是刻意的 ★
 * 余额不足、用户中途放弃、二维码过期，都会产生一次失败的支付尝试。
 * 若强行只允许一张，这些尝试要么无处记录、要么只能改写历史 —— 两者都更糟。
 * 「至多一张成功」这条约束不靠唯一索引，而靠 {@link #status} 上的**条件更新**：
 * 只有当前不是 success 的行才能被改成 success（见 {@code PaymentService#settle}）。
 */
@Data
@TableName("t_payment")
public class Payment {

    /* ------------------------- 状态常量 ------------------------- */

    /** 刚建单，尚未把用户送去收银台 */
    public static final String STATUS_CREATED = "created";
    /** 已把用户送去收银台（跳转 / 出二维码），结果未知 */
    public static final String STATUS_PAYING = "paying";
    /** 渠道确认收款（终态之一） */
    public static final String STATUS_SUCCESS = "success";
    /** 渠道明确拒绝（余额不足 / 用户取消），可另建一张重试 */
    public static final String STATUS_FAILED = "failed";
    /** 超时未付 / 被新支付单取代 / 订单已取消（终态） */
    public static final String STATUS_CLOSED = "closed";
    /** 已原路退回（只能从 success 进入） */
    public static final String STATUS_REFUNDED = "refunded";

    /** 非终态：这些状态下的支付单才算「还活着」，可以被超时任务关掉 */
    public static final java.util.List<String> ACTIVE_STATUSES = java.util.List.of(STATUS_CREATED, STATUS_PAYING);

    /* ------------------------- 字段 ------------------------- */

    /** 支付单号：{@code pay_} + 20 位（与订单号共用 InstanceSeqGenerator） */
    @TableId(type = IdType.INPUT)
    private String id;

    private String orderId;
    private Long buyerId;
    /** wallet / demo / alipay_sandbox */
    private String channel;
    /** 应付金额（下单时快照）。回调金额必须与它**逐分相等**，不等一律拒绝 */
    private BigDecimal amount;
    /** 见上面的状态常量 */
    private String status;

    /**
     * 商户订单号：提交给渠道的那个唯一号。
     * <p>
     * 本项目直接复用支付单号，但**单独存一列**而不是每次现取 {@link #id}：
     * 将来渠道对字符集 / 长度有额外要求、需要换成独立编号时，只改这一列的值即可，
     * 而不必把「支付单号」这个对外标识一起改掉（改了就是历史数据断链，
     * 而回调是拿 out_trade_no 回来找单子的 —— 断链意味着回调永远匹配不上）。
     */
    private String outTradeNo;

    /** 渠道流水号（回调时回填）。这是**与渠道对账的唯一钥匙**，不允许丢 */
    private String tradeNo;

    /**
     * 渠道回调原始报文。
     * <p>
     * ★ 验签只证明「这段报文是渠道发的」，证明不了「我们当时是怎么解读它的」★
     * 事后对账时，唯一能复现当时判断过程的就是这段原文。只增不改。
     */
    private String notifyPayload;

    /** 已退金额（原路退回成功后写入） */
    private BigDecimal refundAmount;
    private LocalDateTime refundTime;

    /** 失败 / 关闭原因（给用户看的文案，不是给机器看的错误码） */
    private String failReason;

    /** 支付单过期时间（与订单的 pay_expire_at 同源，建单时一起算） */
    private LocalDateTime expireAt;
    /** 渠道确认收款的时刻（与 order.pay_time 同值，但各自独立记录：订单可能先被关掉） */
    private LocalDateTime paidAt;

    private LocalDateTime createTime;
    private LocalDateTime updateTime;

    /** 是否还在活跃（非终态）—— 只有活跃的支付单才需要被关单任务处理 */
    public boolean isActive() {
        return status != null && ACTIVE_STATUSES.contains(status);
    }

    /** 是否已成功收款 */
    public boolean isSuccess() {
        return STATUS_SUCCESS.equals(status);
    }

    public boolean isRefunded() {
        return STATUS_REFUNDED.equals(status);
    }
}
