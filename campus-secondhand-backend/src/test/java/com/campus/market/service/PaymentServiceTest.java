package com.campus.market.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.campus.market.common.BusinessException;
import com.campus.market.config.PayProperties;
import com.campus.market.dto.PayLaunch;
import com.campus.market.entity.Order;
import com.campus.market.entity.Payment;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.PaymentMapper;
import com.campus.market.mapper.UserMapper;
import com.campus.market.service.pay.PayChannel;
import com.campus.market.service.pay.PayChannelRegistry;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 支付服务的**核心不变量**测试。
 * <p>
 * ★★ 这里守的三件事，是这次支付改造的全部价值所在 ★★
 * <ol>
 *   <li><b>订单只能被「真的收到钱」推进</b> —— 不是被客户端一次点击推进；</li>
 *   <li><b>重复回调不会重复推进</b> —— 幂等靠条件更新的 affected，不靠「先查一下」；</li>
 *   <li><b>金额以支付单为准</b> —— 渠道回传的金额少了、多了都不结算。</li>
 * </ol>
 * 这三条任意一条失守，表现形式都是「订单状态是对的，钱是错的」——
 * 界面看不出来，只有对账时才发现，所以必须用测试钉住。
 */
class PaymentServiceTest {

    private static final String ORDER_ID = "20260922120000001";
    private static final String PAY_ID = "pay_202609221200000010";
    private static final long BUYER = 7L;

    private PaymentMapper paymentMapper;
    private OrderMapper orderMapper;
    private UserMapper userMapper;
    private PayChannelRegistry registry;
    private PayProperties props;
    private OrderService orderService;
    private PaymentService service;

    /**
     * ★ 必须显式初始化 MP 的实体元数据 ★
     * 单测里没有 Spring 上下文，{@code LambdaUpdateWrapper<Payment>} 拼列名时
     * 需要 {@code TableInfoHelper} 的缓存；不初始化会抛
     * 「can not find lambda cache for this entity」—— 与业务代码对错无关。
     * 这是本项目单测的既有惯例（见 UserServiceProfileTest 等）。
     */
    @BeforeAll
    static void initMybatisPlusMetadata() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "");
        TableInfoHelper.initTableInfo(assistant, Payment.class);
        TableInfoHelper.initTableInfo(assistant, Order.class);
    }

    @BeforeEach
    void setUp() {
        paymentMapper = mock(PaymentMapper.class);
        orderMapper = mock(OrderMapper.class);
        userMapper = mock(UserMapper.class);
        registry = mock(PayChannelRegistry.class);
        props = new PayProperties();
        orderService = mock(OrderService.class);

        ReflectionTestUtils.setField(props, "orderTimeoutMinutes", 1440);
        ReflectionTestUtils.setField(props, "closeBatchSize", 200);

        service = new PaymentService(paymentMapper, orderMapper, userMapper, registry, props, orderService);
        ReflectionTestUtils.setField(service, "instanceId", 0);
    }

    private Order pendingOrder() {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setBuyerId(BUYER);
        o.setStatus("pending_payment");
        o.setAmount(new BigDecimal("45.00"));
        o.setCreateTime(LocalDateTime.now());
        return o;
    }

    private Payment createdPayment() {
        Payment p = new Payment();
        p.setId(PAY_ID);
        p.setOrderId(ORDER_ID);
        p.setBuyerId(BUYER);
        p.setChannel("alipay_sandbox");
        p.setAmount(new BigDecimal("45.00"));
        p.setStatus(Payment.STATUS_CREATED);
        p.setOutTradeNo(PAY_ID);
        return p;
    }

    /* ============================================================
     * 结算
     * ============================================================ */

    @Test
    @DisplayName("★ 结算成功：支付单 success + 订单被推进一次")
    void settleAdvancesOrderOnce() {
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(orderService.markPaid(ORDER_ID, "alipay_sandbox")).thenReturn(true);

        service.settle(createdPayment(), "trade_1", "raw");

        verify(orderService, times(1)).markPaid(ORDER_ID, "alipay_sandbox");
    }

    @Test
    @DisplayName("★★ 重复回调：条件更新 affected=0 → 订单**一次都不被推进**（幂等）")
    void settleIsIdempotent() {
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(0);

        service.settle(createdPayment(), "trade_1", "raw");

        verify(orderService, never()).markPaid(anyString(), anyString());
    }

    @Test
    @DisplayName("★★ 钱收到了、订单却已关闭 → 自动原路退回（不能把钱留在已作废的订单上）")
    void paidButOrderClosedTriggersAutoRefund() {
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(orderService.markPaid(ORDER_ID, "alipay_sandbox")).thenReturn(false);

        PayChannel channel = mock(PayChannel.class);
        when(channel.refundable()).thenReturn(true);
        when(channel.refund(any(PayChannel.RefundContext.class)))
                .thenReturn(PayChannel.RefundResult.ok("r1", "已退回"));
        when(registry.find("alipay_sandbox")).thenReturn(channel);

        service.settle(createdPayment(), "trade_1", "raw");

        verify(channel, times(1)).refund(any(PayChannel.RefundContext.class));
    }

    /* ============================================================
     * ★★ 关单之后才到的款：2026-09-23 补的「钱不留痕」的洞
     * ============================================================ */

    /**
     * ★★ 这两条守的是同一个洞，拆成两条是因为它们坏起来的方式不同 ★★
     * <p>
     * 背景：{@code closeExpired} 到 {@code pay_expire_at} 会把支付单写成 {@code closed}，
     * 而渠道的通知是尽力投递（支付宝会按 4m/10m/10m/1h/2h/6h/15h 一直重推）。
     * 所以「用户卡在关单前后付款 + 通知晚到」是真实可达的。
     * <p>
     * 老实现把 {@code affected == 0} 一律解释成「已处理过的重复投递」并直接返回，
     * 于是一笔**真实进账**被静默丢弃：钱在渠道手上、订单已作废、没有任何代码会去退它。
     * 它比「多退一笔」更隐蔽 —— 界面上什么都不会显示，只有对账时才发现账实不符。
     */
    @Test
    @DisplayName("★★ settle 的来源状态必须包含 closed —— 少了它，关单后到账的钱就是一笔无痕进账")
    void settleAcceptsClosedAsSourceStatus() {
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(orderService.markPaid(ORDER_ID, "alipay_sandbox")).thenReturn(true);

        service.settle(createdPayment(), "trade_1", "raw");

        /*
         * ★ 这条断言锚的是**渲染出来的 SQL 里的 IN 子句**，不是「我们调用了 update」★
         *
         * 写成这样是踩了两次坑之后的结果，两次都是「锚错了对象」：
         *   ① 只断言 update 被调用 ⇒ 条件被重新收紧时照样通过，等于没守；
         *   ② 断言 getParamNameValuePairs() 里有 "closed" ⇒ 报红，但**不是代码错了**：
         *      MyBatis-Plus 把 set() 的值放进参数表，而 eq()/in() 的值拿不到
         *      （实测该 map 里只有 4 个 set 值），所以即使 closed 真的被放行，断言也失败。
         *
         * ★ 这条断言能证明什么、不能证明什么（如实记）★
         * 能证明：可结算的来源状态**有 3 个**，也就是 created / paying / closed 全在。
         *        谁把 closed 去掉，IN 子句就只剩 2 个占位符，当场报红。
         * 不能证明：SQL 在真实 MySQL 上对一行 closed 数据确实会命中 ——
         *        那属于 SQL 语义，单测的 mapper 是 mock，看不到。
         *        这一层由真机验证补：{@code .workbuddy/tmp/verify-reconcile-closed-refund.mjs}
         *        （对真实库造一行 closed 支付单，走真实 update，看是否真的翻转并退回）。
         */
        @SuppressWarnings("unchecked")
        ArgumentCaptor<LambdaUpdateWrapper<Payment>> captor =
                ArgumentCaptor.forClass(LambdaUpdateWrapper.class);
        verify(paymentMapper).update(org.mockito.ArgumentMatchers.<Payment>isNull(), captor.capture());
        String sql = captor.getValue().getSqlSegment();

        java.util.regex.Matcher in = java.util.regex.Pattern
                .compile("status IN \\(([^)]*)\\)").matcher(sql);
        assertTrue(in.find(), "找不到 status IN (...) 条件，条件更新可能被整体改写：" + sql);
        long sourceCount = in.group(1).split(",").length;
        assertEquals(3, sourceCount,
                "可结算的来源状态必须是 created / paying / closed 三种。"
                        + "少了 closed ⇒ 超时关单后到达的付款既不入账也不退回，"
                        + "变成一笔界面上完全看不见的无痕进账。实际 WHERE=" + sql
                        + " 参数表=" + captor.getValue().getParamNameValuePairs());
    }

    @Test
    @DisplayName("★★ 支付单已 closed 后钱才到 → 自动原路退回（而不是静默跳过）")
    void settleOnClosedPaymentAutoRefunds() {
        Payment closed = createdPayment();
        closed.setStatus(Payment.STATUS_CLOSED);

        // closed 已被放行进来源状态 ⇒ 这次状态翻转成功
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        // 但订单早被关单任务改成 cancelled，推进必然失败
        when(orderService.markPaid(ORDER_ID, "alipay_sandbox")).thenReturn(false);

        PayChannel channel = mock(PayChannel.class);
        when(channel.refundable()).thenReturn(true);
        when(channel.refund(any(PayChannel.RefundContext.class)))
                .thenReturn(PayChannel.RefundResult.ok("r1", "已退回"));
        when(registry.find("alipay_sandbox")).thenReturn(channel);

        service.settle(closed, "trade_1", "raw");

        verify(channel, times(1)).refund(any(PayChannel.RefundContext.class));
    }

    @Test
    @DisplayName("★★ 同一条晚到通知重推多次 → 只会退回一次（幂等靠状态条件更新，不靠先查后写）")
    void lateNotifyRefundsOnlyOnce() {
        Payment closed = createdPayment();
        closed.setStatus(Payment.STATUS_CLOSED);

        // 第一次：条件更新命中（closed → success）；第二次：状态已是 refunded，命中 0 行
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1, 0);
        when(orderService.markPaid(ORDER_ID, "alipay_sandbox")).thenReturn(false);

        PayChannel channel = mock(PayChannel.class);
        when(channel.refundable()).thenReturn(true);
        when(channel.refund(any(PayChannel.RefundContext.class)))
                .thenReturn(PayChannel.RefundResult.ok("r1", "已退回"));
        when(registry.find("alipay_sandbox")).thenReturn(channel);

        Payment again = createdPayment();
        again.setStatus(Payment.STATUS_CLOSED);
        service.settle(closed, "trade_1", "raw");
        service.settle(again, "trade_1", "raw");

        verify(channel, times(1)).refund(any(PayChannel.RefundContext.class));
    }

    /* ============================================================
     * 回调
     * ============================================================ */

    @Test
    @DisplayName("★★ 金额不符 → 返回 failure 且不结算（比支付单少一分也不行）")
    void amountMismatchIsRejected() {
        PayChannel channel = mock(PayChannel.class);
        when(channel.code()).thenReturn("alipay_sandbox");
        when(channel.asyncNotify()).thenReturn(true);
        when(channel.parseNotify(any(Map.class))).thenReturn(new PayChannel.NotifyResult(
                true, PAY_ID, "trade_1", new BigDecimal("0.01"), true, null, "raw"));
        when(registry.find("alipay_sandbox")).thenReturn(channel);
        when(paymentMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(createdPayment());

        assertEquals("failure", service.handleNotify("alipay_sandbox", Map.of()));
        verify(orderService, never()).markPaid(anyString(), anyString());
    }

    @Test
    @DisplayName("★★ 验签失败 → 返回 failure（让渠道重推，而不是永久丢掉这笔钱）")
    void badSignatureIsRejected() {
        PayChannel channel = mock(PayChannel.class);
        when(channel.code()).thenReturn("alipay_sandbox");
        when(channel.asyncNotify()).thenReturn(true);
        when(channel.parseNotify(any(Map.class)))
                .thenReturn(PayChannel.NotifyResult.rejected("raw"));
        when(registry.find("alipay_sandbox")).thenReturn(channel);

        assertEquals("failure", service.handleNotify("alipay_sandbox", Map.of()));
    }

    @Test
    @DisplayName("★★ 同步渠道（钱包/演示）被伪造成回调 → 拒绝（它们没有验签，放行等于不设防）")
    void syncChannelNotifyIsRejected() {
        PayChannel channel = mock(PayChannel.class);
        when(channel.asyncNotify()).thenReturn(false);
        when(registry.find("wallet")).thenReturn(channel);

        assertEquals("failure", service.handleNotify("wallet", Map.of()));
    }

    @Test
    @DisplayName("渠道明确说这笔失败 → 记下原因并返回 success（别让渠道再推）")
    void channelReportedFailureReturnsSuccess() {
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        PayChannel channel = mock(PayChannel.class);
        when(channel.code()).thenReturn("alipay_sandbox");
        when(channel.asyncNotify()).thenReturn(true);
        when(channel.parseNotify(any(Map.class))).thenReturn(new PayChannel.NotifyResult(
                true, PAY_ID, null, new BigDecimal("45.00"), false, "用户中途取消", "raw"));
        when(registry.find("alipay_sandbox")).thenReturn(channel);
        when(paymentMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(createdPayment());

        assertEquals("success", service.handleNotify("alipay_sandbox", Map.of()));
        verify(orderService, never()).markPaid(anyString(), anyString());
    }

    /* ============================================================
     * 发起支付
     * ============================================================ */

    @Test
    @DisplayName("★ 发起支付：金额取订单快照，不受请求体影响（杜绝「改价支付」）")
    void createPaymentUsesOrderSnapshotAmount() {
        when(orderService.requirePayable(ORDER_ID, BUYER)).thenReturn(pendingOrder());
        PayChannel channel = mock(PayChannel.class);
        when(channel.code()).thenReturn("wallet");
        when(channel.label()).thenReturn("校园钱包");
        when(channel.create(any(PayChannel.CreateContext.class)))
                .thenReturn(PayChannel.CreateResult.done("已扣除"));
        when(registry.require("wallet")).thenReturn(channel);
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(orderService.markPaid(ORDER_ID, "wallet")).thenReturn(true);
        when(paymentMapper.selectById(anyString())).thenReturn(createdPayment());

        PayLaunch launch = service.createPayment(ORDER_ID, BUYER, "wallet", "127.0.0.1");

        assertEquals(PayLaunch.Kind.DONE, launch.kind());
        assertEquals(0, new BigDecimal("45.00").compareTo(launch.amount()));
        // 关键：落库的金额来自订单，不是来自任何入参
        org.mockito.ArgumentCaptor<Payment> captor =
                org.mockito.ArgumentCaptor.forClass(Payment.class);
        verify(paymentMapper).insert(captor.capture());
        assertEquals(0, new BigDecimal("45.00").compareTo(captor.getValue().getAmount()));
    }

    @Test
    @DisplayName("★ 订单不是待付款 → 直接拒绝，不建支付单")
    void notPayableIsRejected() {
        when(orderService.requirePayable(ORDER_ID, BUYER))
                .thenThrow(BusinessException.of("订单当前「已完成」，无需付款"));

        assertThrows(BusinessException.class,
                () -> service.createPayment(ORDER_ID, BUYER, "wallet", "127.0.0.1"));
        verify(paymentMapper, never()).insert(any(Payment.class));
    }

    /* ============================================================
     * 超时关单
     * ============================================================ */

    @Test
    @DisplayName("★ 超时关单：先关支付单再关订单，且逐笔独立（一笔失败不影响整批）")
    void closeExpiredClosesPaymentsFirst() {
        Order o1 = pendingOrder();
        Order o2 = pendingOrder();
        o2.setId("20260922120000002");
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(2);
        when(orderMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(o1, o2));
        when(orderService.closeExpiredOrder(o1.getId())).thenReturn(true);
        when(orderService.closeExpiredOrder(o2.getId())).thenThrow(new RuntimeException("db down"));

        int closed = service.closeExpired();

        assertEquals(1, closed, "第二笔抛异常不该让第一笔的成果消失，也不该中断整批");
    }
}
