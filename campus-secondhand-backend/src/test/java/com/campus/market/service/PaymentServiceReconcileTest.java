package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.config.PayProperties;
import com.campus.market.entity.Order;
import com.campus.market.entity.Payment;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.PaymentMapper;
import com.campus.market.mapper.UserMapper;
import com.campus.market.service.pay.PayChannel;
import com.campus.market.service.pay.PayChannelRegistry;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 支付**主动对账**（回调丢失兜底）的核心不变量测试。
 * <p>
 * ★★ 这个兜底路径为什么危险，以及这里的用例在守什么 ★★
 * <p>
 * 它是一条**新的、能自动把订单推进到待发货的路**。原有的全部安全性建立在
 * 「只有渠道亲口说收到钱，才能结算」之上；一旦兜底路径把这句话理解宽了一点，
 * 后果就是**不付钱也能拿到货**，而且没有任何界面异常。
 * <p>
 * 所以这里逐条钉死的是「什么情况下**不许**结算」，而不是「能不能结算」：
 * <ol>
 *   <li><b>金额必须逐分相等</b> —— 与回调路径同一条闸门。少了不行（少付钱），
 *       多了也不行（多收的钱没有归属）。金额拿不到时同样**不许**结算，
 *       绝不能退化成「用 0 去比」；</li>
 *   <li><b>「问不到」不等于「没成」</b> —— 网络/网关/验签失败时必须**一个字都不改**，
 *       否则一次抖动就能把一笔真付款判死；</li>
 *   <li><b>「渠道说还没成」也不许标失败</b> —— {@code WAIT_BUYER_PAY} 是用户还站在
 *       收银台前的正常状态，提前标失败会与「用户下一秒付款成功」直接冲突；</li>
 *   <li><b>不支持查单的渠道一次请求都不许发</b> —— 筛选必须靠
 *       {@code queryable()}，而不是「调一下 query 试试」。</li>
 * </ol>
 */
class PaymentServiceReconcileTest {

    private static final String ORDER_ID = "20260923233755355000";
    private static final String PAY_ID = "pay_20260923233755539000";
    private static final long BUYER = 4L;
    private static final String CHANNEL = "alipay_sandbox";

    private PaymentMapper paymentMapper;
    private OrderMapper orderMapper;
    private UserMapper userMapper;
    private PayChannelRegistry registry;
    private PayProperties props;
    private OrderService orderService;
    private PaymentService service;

    /** 单测里没有 Spring 上下文，Lambda 包装器拼列名要靠 MP 的元数据缓存（本项目既有惯例） */
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
        orderService = mock(OrderService.class);
        props = new PayProperties();
        ReflectionTestUtils.setField(props, "orderTimeoutMinutes", 840);
        ReflectionTestUtils.setField(props, "closeBatchSize", 200);
        ReflectionTestUtils.setField(props, "reconcileBatchSize", 100);
        ReflectionTestUtils.setField(props, "reconcileGraceMinutes", 2);

        service = new PaymentService(paymentMapper, orderMapper, userMapper, registry, props, orderService);
        ReflectionTestUtils.setField(service, "instanceId", 0);
    }

    /** 一张卡在 paying 的支付单：12.00 元，还没过期 */
    private Payment payingPayment() {
        Payment p = new Payment();
        p.setId(PAY_ID);
        p.setOrderId(ORDER_ID);
        p.setBuyerId(BUYER);
        p.setChannel(CHANNEL);
        p.setAmount(new BigDecimal("12.00"));
        p.setStatus(Payment.STATUS_PAYING);
        p.setOutTradeNo(PAY_ID);
        p.setCreateTime(LocalDateTime.now().minusMinutes(10));
        p.setExpireAt(LocalDateTime.now().plusHours(13));
        return p;
    }

    /** 可查单的渠道：query() 返回给定结论 */
    private PayChannel queryableChannel(PayChannel.QueryResult result) {
        PayChannel ch = mock(PayChannel.class);
        when(ch.code()).thenReturn(CHANNEL);
        when(ch.queryable()).thenReturn(true);
        when(ch.query(anyString())).thenReturn(result);
        when(registry.find(CHANNEL)).thenReturn(ch);
        return ch;
    }

    private static PayChannel.QueryResult paid(String amount) {
        return new PayChannel.QueryResult(PayChannel.QueryOutcome.PAID, PAY_ID,
                "2026092322001453090509431001",
                amount == null ? null : new BigDecimal(amount), "TRADE_SUCCESS", null);
    }

    /* ============================================================
     * 正向：确认收款 + 金额相符 → 结算（走的是回调那条同一条路径）
     * ============================================================ */

    @Test
    @DisplayName("★ 渠道确认收款、金额逐分相等 → 结算，订单被推进一次")
    void paidWithMatchingAmountSettles() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(orderService.markPaid(ORDER_ID, CHANNEL)).thenReturn(true);
        queryableChannel(paid("12.00"));

        assertEquals(PaymentService.ReconcileOutcome.SETTLED, service.reconcileOne(PAY_ID));
        verify(orderService, times(1)).markPaid(ORDER_ID, CHANNEL);
    }

    @Test
    @DisplayName("★ 金额大小相同但写法不同（12.0 vs 12.00）→ 仍算相符（比数值，不比字符串）")
    void amountComparedNumericallyNotTextually() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        when(paymentMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(orderService.markPaid(ORDER_ID, CHANNEL)).thenReturn(true);
        queryableChannel(paid("12.0"));

        assertEquals(PaymentService.ReconcileOutcome.SETTLED, service.reconcileOne(PAY_ID));
    }

    /* ============================================================
     * ★★ 反向：金额闸门。这几条是「1 分钱买 iPhone」的防线
     * ============================================================ */

    @Test
    @DisplayName("★★ 渠道说付款了、但金额不符 → **绝不结算**（与回调路径同一条闸门）")
    void paidWithMismatchedAmountNeverSettles() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        queryableChannel(paid("0.01"));

        assertEquals(PaymentService.ReconcileOutcome.AMOUNT_MISMATCH,
                service.reconcileOne(PAY_ID));
        verify(orderService, never()).markPaid(anyString(), anyString());
        verify(paymentMapper, never()).update(any(), any(LambdaUpdateWrapper.class));
    }

    @Test
    @DisplayName("★★ 查单拿不到金额 → 同样**绝不结算**（不许退化成「用 0 去比 0」）")
    void paidWithUnknownAmountNeverSettles() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        queryableChannel(paid(null));

        assertEquals(PaymentService.ReconcileOutcome.AMOUNT_MISMATCH,
                service.reconcileOne(PAY_ID));
        verify(orderService, never()).markPaid(anyString(), anyString());
    }

    /* ============================================================
     * ★★ 反向：「问不到」与「还没成」都必须什么都不改
     * ============================================================ */

    @Test
    @DisplayName("★★ 查单请求没问成（网络/网关/验签）→ 一个字都不改，下一轮再问")
    void unavailableLeavesEverythingUntouched() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        queryableChannel(PayChannel.QueryResult.unavailable("connect timed out"));

        assertEquals(PaymentService.ReconcileOutcome.UNAVAILABLE, service.reconcileOne(PAY_ID));
        verify(paymentMapper, never()).update(any(), any(LambdaUpdateWrapper.class));
        verify(orderService, never()).markPaid(anyString(), anyString());
    }

    @Test
    @DisplayName("★★ 渠道确认这笔还没成（WAIT_BUYER_PAY）→ 什么都不改，**尤其不标失败**")
    void notPaidChangesNothing() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        queryableChannel(new PayChannel.QueryResult(PayChannel.QueryOutcome.NOT_PAID, PAY_ID,
                null, null, "WAIT_BUYER_PAY", "支付宝交易状态：WAIT_BUYER_PAY"));

        assertEquals(PaymentService.ReconcileOutcome.NOT_PAID, service.reconcileOne(PAY_ID));
        verify(paymentMapper, never()).update(any(), any(LambdaUpdateWrapper.class));
        verify(orderService, never()).markPaid(anyString(), anyString());
    }

    /* ============================================================
     * 跳过：不该问的不要问
     * ============================================================ */

    @Test
    @DisplayName("★★ 渠道不支持查单 → 跳过，且**一次渠道请求都不许发**")
    void nonQueryableChannelIsSkippedWithoutCalling() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(payingPayment());
        PayChannel ch = mock(PayChannel.class);
        when(ch.queryable()).thenReturn(false);
        when(registry.find(CHANNEL)).thenReturn(ch);

        assertEquals(PaymentService.ReconcileOutcome.SKIPPED, service.reconcileOne(PAY_ID));
        verify(ch, never()).query(anyString());
    }

    @Test
    @DisplayName("★ 支付单已不是 paying（已被回调/关单处理）→ 跳过，不再问渠道（对账天生要容忍这个）")
    void terminalPaymentIsSkipped() {
        Payment settled = payingPayment();
        settled.setStatus(Payment.STATUS_SUCCESS);
        when(paymentMapper.selectById(PAY_ID)).thenReturn(settled);

        assertEquals(PaymentService.ReconcileOutcome.SKIPPED, service.reconcileOne(PAY_ID));
        verify(registry, never()).find(anyString());
    }

    @Test
    @DisplayName("★ 支付单不存在 → 跳过（不抛异常：一轮里少一笔不该中断整批）")
    void missingPaymentIsSkipped() {
        when(paymentMapper.selectById(PAY_ID)).thenReturn(null);
        assertEquals(PaymentService.ReconcileOutcome.SKIPPED, service.reconcileOne(PAY_ID));
    }

    /* ============================================================
     * 候选筛选：谁值得被问
     * ============================================================ */

    @Test
    @DisplayName("★ 候选查询必须带「未过期」与「已过宽限期」两个条件（否则会与关单任务抢单、或追问刚发起的支付）")
    void candidateQueryCarriesBothTimeConditions() {
        when(paymentMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of());

        service.findReconcileCandidates();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<LambdaQueryWrapper<Payment>> captor =
                ArgumentCaptor.forClass(LambdaQueryWrapper.class);
        verify(paymentMapper).selectList(captor.capture());
        String sql = captor.getValue().getSqlSegment();

        /*
         * ★ 断言的是**生成出来的 SQL 片段**，不是「我们调用了 selectList」★
         * 后者在条件被整段删掉时照样通过 —— 而这正是最危险的改法：
         * 少了 expire_at 就会去问已过期的单子（与关单任务抢），
         * 少了 create_time 宽限就会把「用户正在付款」误判成「回调可能丢了」。
         */
        assertTrue(sql.contains("status"), "必须只看 paying：" + sql);
        assertTrue(sql.contains("expire_at"), "必须限定未过期，已过期的归超时关单任务：" + sql);
        assertTrue(sql.contains("create_time"), "必须有宽限期，别追问刚发起的支付：" + sql);
    }

    @Test
    @DisplayName("★★ 候选筛选按渠道能力过滤：不支持查单的渠道不进候选（避免无意义的真实请求）")
    void candidatesFilterByChannelCapability() {
        Payment a = payingPayment();
        Payment b = payingPayment();
        b.setId("pay_20260923233755539001");
        b.setChannel("wallet");
        when(paymentMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(a, b));

        PayChannel alipay = mock(PayChannel.class);
        when(alipay.queryable()).thenReturn(true);
        PayChannel wallet = mock(PayChannel.class);
        when(wallet.queryable()).thenReturn(false);
        when(registry.find("alipay_sandbox")).thenReturn(alipay);
        when(registry.find("wallet")).thenReturn(wallet);

        List<String> candidates = service.findReconcileCandidates();

        assertEquals(List.of(PAY_ID), candidates);
        assertFalse(candidates.contains("pay_20260923233755539001"));
    }

    @Test
    @DisplayName("★ 渠道已经找不到（被下线/摘掉）→ 不进候选，不抛异常")
    void unknownChannelIsSkipped() {
        when(paymentMapper.selectList(any(LambdaQueryWrapper.class)))
                .thenReturn(List.of(payingPayment()));
        when(registry.find(CHANNEL)).thenReturn(null);

        assertTrue(service.findReconcileCandidates().isEmpty());
    }
}
