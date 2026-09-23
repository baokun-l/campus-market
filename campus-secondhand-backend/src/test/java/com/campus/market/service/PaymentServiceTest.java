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
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
