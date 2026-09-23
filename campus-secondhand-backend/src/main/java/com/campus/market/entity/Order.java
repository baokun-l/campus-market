package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 订单实体（订单表：买家-卖家-商品-价格快照-售后）
 * <p>
 * 价格快照在下单时固化：listPrice / sellerCut / platformSubsidy / sellerIncome
 * 卖家对账与平台结算的唯一依据 —— 活动结束后卖家改价不影响已成交的这一单。
 * <p>
 * ★ API 契约：库表是**扁平**的（goods_title / refund_amount / cancel_reason_text …），
 * 而前端 `types/index.ts` 的 `Order` 是**嵌套**的
 * （`goods: Pick<Goods,…>` / `refund: OrderRefund` / `cancelReason: {time,text}` / `logs`）。
 * 前端 `api/order.ts` 在非 Mock 分支没有任何适配层，直接把响应当成 `Order` 使用，
 * 于是 `order.goods.title`、`order.refund.amount`、`order.cancelReason.text` 全都会取空。
 * <p>
 * 因此这里保留扁平列（落库用），同时用**只读派生 getter** 组装出嵌套视图给序列化用：
 * 既不动库表、也不需要在每个 Service 里手工拼 Map，前端一行都不用改。
 * <p>
 * traces 在库里是 TEXT（JSON 数组），在 API 层输出为 `[{time, text}]`，
 * 与前端 `Order.traces?: LogisticsTrace[]` 对齐。
 */
@Data
@TableName(value = "t_order", autoResultMap = true)
public class Order {
    @TableId(type = IdType.INPUT)
    private String id;
    /** pending_payment / pending_ship / shipped / received / completed / refunding / cancelled */
    private String status;
    private Long goodsId;
    private String goodsTitle;
    private String goodsCover;
    private BigDecimal goodsPrice;
    private BigDecimal goodsPromoPrice;
    private Long buyerId;
    private String buyerName;
    private Long sellerId;
    private String sellerName;
    /** 买家实付金额 */
    private BigDecimal amount;
    /** 挂牌价（快照） */
    private BigDecimal listPrice;
    /** 卖家让利金额（快照） */
    private BigDecimal sellerCut;
    /** 平台补贴金额（快照） */
    private BigDecimal platformSubsidy;
    /** 卖家应收 = listPrice - sellerCut */
    private BigDecimal sellerIncome;
    /** 让利成本承担方：seller / platform */
    private String fundSource;
    private String activityId;
    private Integer quantity;
    private String remark;
    private String address;
    private String trackingNo;
    private String logisticsCompany;
    /** 物流轨迹（DB 存 JSON 数组，API 输出 [{time, text}]） */
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<Map<String, Object>> traces;
    /**
     * 后台内部备注。
     * <p>
     * ★ 只对管理员可见 —— 而且**不是靠前端不渲染**，是在响应出口按查看者身份清空 ★
     * <p>
     * 这个字段是 {@link Order} 上的普通列（无 {@code @JsonIgnore}），会逐条出现在每一次
     * {@code GET /orders} 的响应体里。买家 / 卖家拉自己的订单时，备注原文就躺在 JSON 中，
     * 打开开发者工具即可读到。因此 {@code OrderService#fillLogs} 在非管理员路径上把它置为
     * null，再由 {@code @JsonInclude(NON_NULL)} 让键彻底消失（而不是留一个 null 值）。
     * <p>
     * 换句话说：**这个字段的可见性由那个裁剪方法守，不在这里守** —— 要不要改映射、
     * 要不要放开给新接口，先去读它。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String adminNote;
    /** 退款金额 */
    private BigDecimal refundAmount;
    private String refundReason;
    private String refundBy;
    private String refundRemark;
    private LocalDateTime refundTime;
    /**
     * 买家**申请**退款的时刻（不落库，只用于组装 {@code refund.time}）。
     * <p>
     * ★ 为什么不能复用 {@code refundTime} ★
     * <p>
     * {@code t_order.refund_time} 的语义是**退款完成时间**，前端 `api/order.ts` 正是拿它
     * 统计「已退款金额」（{@code if (o.refundTime) refundedAmount += …}）。若买家一提交申请
     * 就把它填上，一笔**还在审核中**的售后单会被算进已退金额 —— 后台对账凭空多一笔钱。
     * <p>
     * 而前端 `OrderRefund.time` 的语义是**申请时间**（`types/index.ts` 明确写了
     * 「不是完成时间；完成时间在 Order.refundTime」）。两者在「买家申请 → 平台审批」
     * 这条链路上必然是两个不同的时刻，所以不能共用一列。
     * <p>
     * ★ 不新增库列的取巧之处 ★
     * <p>
     * 申请这一刻本来就已经落在 {@code t_order_log} 里（{@code to_status='refunding'} 那条，
     * 与 {@code OrderService#refundBackTarget} 取「进入售后前的状态」用的是同一行数据），
     * 因此由 {@code OrderService#fillLogs} 在响应出口从日志回填，无需改表、无需迁移脚本。
     */
    @JsonIgnore
    @TableField(exist = false)
    private LocalDateTime refundApplyTime;
    private String cancelReasonText;
    private LocalDateTime cancelReasonTime;
    private LocalDateTime createTime;
    private LocalDateTime payTime;
    /**
     * 支付方式（wallet / demo / alipay_sandbox / offline）。
     * <p>
     * ★ 订单上只留「最终用的是哪条渠道」，凭证类信息一律不在这里再存一份 ★
     * <p>
     * 第三方流水号、回调原文、金额核对都在 {@link Payment}。同一件事有两个存放点时，
     * 两边迟早不一致，而对账时无法判断该以哪个为准 —— 这比字段少更危险。
     * <p>
     * 由 {@code PaymentService} 在「渠道确认收款」的同一个条件 UPDATE 里写入，
     * 与 {@link #payTime} 同生共死：有付款时间必有支付方式（存量数据由
     * {@code db/upgrade-payment.sql} 回填成 {@code offline}）。
     */
    private String payChannel;
    /**
     * 支付截止时间。
     * <p>
     * 下单时按支付时限算出并**落库**，超时关单任务按本列扫描。
     * <p>
     * 为什么不拿 {@link #createTime} 加偏移现场算：那样「改配置」会把**已经存在的**
     * 订单的截止时间一起改掉 —— 判定口径随配置漂移，昨天还差 1 小时的单子
     * 今天可能已经"超时"了。落库等于把「下单那一刻的约定」固定下来。
     */
    private LocalDateTime payExpireAt;
    private LocalDateTime shipTime;
    private LocalDateTime receiveTime;
    private LocalDateTime completeTime;

    /**
     * 操作日志（前端 `Order.logs`）。
     * <p>
     * 不落库：由 {@code OrderService#fillLogs} 按本页订单 id 一次 IN 查询回填，
     * 避免逐单查日志造成 N+1。
     */
    @TableField(exist = false)
    private List<OrderLog> logs;

    /* ==================================================================
     * 以下三个是「按前端契约派生」的只读嵌套视图：
     * 只有 getter、没有 setter，不参与 MyBatis 映射（无对应字段），
     * 仅用于 JSON 序列化。前端读到的是它与扁平列并存的结果。
     * ================================================================== */

    /**
     * 前端 `Order.goods: Pick<Goods,'id'|'title'|'cover'|'price'|'promoPrice'>`
     * <p>
     * 永远返回对象（哪怕快照为空）—— 前端列表里有 `o.goods.title` 这样的直接取值，
     * 返回 null 会当场抛 TypeError，而返回空对象只会显示为空字符串。
     */
    public Map<String, Object> getGoods() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", goodsId);
        view.put("title", goodsTitle);
        view.put("cover", goodsCover);
        view.put("price", goodsPrice);
        view.put("promoPrice", goodsPromoPrice);
        return view;
    }

    /**
     * 前端 `Order.refund?: OrderRefund`（金额 / 原因 / 发起方 / 申请时间 / 备注）
     * <p>
     * 只有真的产生过退款单才输出；没有退款时整个键不出现（`@JsonInclude(NON_NULL)`），
     * 与 TS 里的可选字段语义一致 —— 前端用 `v-if="order.refund"` 判定。
     * <p>
     * ★ 判定条件里 {@code refundAmount} 一项是给「买家已申请、平台未处理」用的 ★
     * <p>
     * 买家申请时**只写**金额 / 原因 / 发起方（完成时间 {@code refundTime} 要等审批那一
     * 刻才写，见 {@link #refundApplyTime}），所以那个阶段只有 {@code refundAmount} 非空。
     * 若仍按「refundTime 或 refundAmount 非空」判定，售后中的单子倒是能出卡片，
     * 但一旦有人把这里改成只看 {@code refundTime}，买家就会在等待审核期间
     * 看到「没有售后单」—— 而售后统计（`refunding` 分组）里又明明有一笔。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public Map<String, Object> getRefund() {
        if (refundTime == null && refundAmount == null && refundReason == null) return null;
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("amount", refundAmount);
        view.put("reason", refundReason);
        view.put("by", refundBy == null ? "admin" : refundBy);
        // 优先给「申请时间」；取不到（历史数据 / 平台直接退款）才退回完成时间，
        // 那种情况下申请与完成是同一刻，两者等值。
        view.put("time", refundApplyTime != null ? refundApplyTime : refundTime);
        view.put("remark", refundRemark);
        return view;
    }

    /**
     * 前端 `Order.cancelReason?: { time, text }`
     * <p>
     * 关闭订单必须留下原因：超时未付款是买家责任、卖家缺货是卖家责任，
     * 没有原因，退款与信用扣分的依据就没了。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public Map<String, Object> getCancelReason() {
        if (cancelReasonTime == null && cancelReasonText == null) return null;
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("time", cancelReasonTime);
        view.put("text", cancelReasonText);
        return view;
    }
}
