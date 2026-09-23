package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Order;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderLogMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 订单归属校验与状态机测试。
 * <p>
 * ★ 守的是「一单交易的状态只能被买卖双方自己推动」★
 * <p>
 * 订单号是对外可见的（出现在消息里、日志里、页面 URL 里）。
 * 只要 {@code requirePayable / shipOrder / confirmReceive} 少做一次归属比对，
 * 任何注册用户拿到一个订单号就能替别人付款、替别人发货、替别人确认收货 ——
 * 交易状态被无关的人推着走，而且**不会报任何错**。
 * <p>
 * ★ 这里断言的是 {@code requirePayable} 而不是旧的 {@code payOrder} ★
 * 支付改造后「付款」不再是「客户端调一下接口就翻状态」：{@code payOrder} 已删除，
 * 能真正推进订单的只有 {@code OrderService#markPaid}，而它由 {@code PaymentService#settle}
 * 在渠道确认收款之后调用。这里守住的是那条链路的**入口校验**：
 * 只有买家本人、且订单确实处于待付款，才有资格发起一次支付。
 * <p>
 * 订单操作日志同理：里面含运单号、退款原因、后台内部备注，
 * 只判「登录了」就放行的话，换个订单号就能读到别人的交易详情。
 */
class OrderServiceAccessTest {

    private static final String ORDER_ID = "2026091700001";
    private static final long BUYER = 4L;
    private static final long SELLER = 5L;
    private static final long OUTSIDER = 9L;

    private OrderMapper orderMapper;
    private OrderLogMapper orderLogMapper;
    private OrderService service;

    @BeforeEach
    void setUp() {
        orderMapper = mock(OrderMapper.class);
        orderLogMapper = mock(OrderLogMapper.class);
        service = new OrderService(
                orderMapper,
                mock(GoodsMapper.class),
                orderLogMapper,
                mock(UserMapper.class),
                mock(AuditLogMapper.class),
                // 本测试覆盖的是状态机与归属校验，不涉及下单时的价格快照，故活动服务用空实现
                mock(ActivityService.class));
        // BaseMapper.selectList 未打桩会返回 null，selectLogs 会 NPE —— 兜住
        when(orderLogMapper.selectList(any())).thenReturn(List.of());
    }

    private Order givenOrder(String status) {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setBuyerId(BUYER);
        o.setSellerId(SELLER);
        o.setStatus(status);
        when(orderMapper.selectById(ORDER_ID)).thenReturn(o);
        return o;
    }

    // ==================== 订单操作日志的可见性 ====================

    @Test
    @DisplayName("买家 / 卖家本人可读订单日志")
    void partiesCanReadLogs() {
        givenOrder("pending_payment");
        assertDoesNotThrow(() -> service.fetchOrderLogs(ORDER_ID, BUYER, "user"));
        assertDoesNotThrow(() -> service.fetchOrderLogs(ORDER_ID, SELLER, "user"));
    }

    @Test
    @DisplayName("无关登录用户读不到 —— 换个订单号就行的话日志等于公开")
    void outsiderCannotReadLogs() {
        givenOrder("pending_payment");
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.fetchOrderLogs(ORDER_ID, OUTSIDER, "user"));
        assertEquals(BusinessCode.FORBIDDEN, ex.getCode());
    }

    @Test
    @DisplayName("匿名（身份为 null）读不到，不能因为判空写漏就放行")
    void anonymousCannotReadLogs() {
        givenOrder("pending_payment");
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.fetchOrderLogs(ORDER_ID, null, null)).getCode());
    }

    @Test
    @DisplayName("只有全能 admin 能读任意订单的日志；审核角色（goods_admin / report_admin）不能")
    void onlyAdminCanReadOthersLogs() {
        givenOrder("pending_payment");
        // 全能 admin 需要订单工作台的完整时间线
        assertDoesNotThrow(() -> service.fetchOrderLogs(ORDER_ID, OUTSIDER, "admin"));
        /*
         * ★ 这条用例原先断言三种后台角色都能读，把越权当成了设计 ★
         * 订单日志里有运单号、退款原因、后台内部备注，本方法自己的 javadoc 写的就是
         * 「仅买卖双方 + 全能 admin」。goods_admin 只管商品审核、report_admin 只管举报，
         * 职能互斥，都不该看到别人的订单日志。
         * 原实现是 `admin || goods_admin || report_admin` 一把梭 —— 同样是「审核角色」，
         * 一个被放进来了、另一个没有，正说明这行是随手写的。
         */
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.fetchOrderLogs(ORDER_ID, OUTSIDER, "goods_admin")).getCode());
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.fetchOrderLogs(ORDER_ID, OUTSIDER, "report_admin")).getCode());
    }

    @Test
    @DisplayName("买卖双方读自己的订单日志不受角色影响")
    void partiesCanReadTheirOwnLogs() {
        givenOrder("pending_payment");
        assertDoesNotThrow(() -> service.fetchOrderLogs(ORDER_ID, BUYER, "user"));
        assertDoesNotThrow(() -> service.fetchOrderLogs(ORDER_ID, SELLER, "user"));
    }

    @Test
    @DisplayName("订单不存在 → 404，而不是静默返回空日志")
    void missingOrderIs404() {
        when(orderMapper.selectById(ORDER_ID)).thenReturn(null);
        assertEquals(BusinessCode.NOT_FOUND,
                assertThrows(BusinessException.class,
                        () -> service.fetchOrderLogs(ORDER_ID, BUYER, "user")).getCode());
    }

    // ==================== 状态流转的当事人才可操作 ====================

    @Test
    @DisplayName("只有买家本人能发起支付 / 确认收货")
    void onlyBuyerCanPayAndReceive() {
        givenOrder("pending_payment");
        assertDoesNotThrow(() -> service.requirePayable(ORDER_ID, BUYER));
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.requirePayable(ORDER_ID, SELLER)).getCode());
        // 匿名（身份为 null）同样不行：判空写漏就会放行
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.requirePayable(ORDER_ID, null)).getCode());

        givenOrder("shipped");
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.confirmReceive(ORDER_ID, SELLER)).getCode());
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.confirmReceive(ORDER_ID, null)).getCode());
    }

    @Test
    @DisplayName("已付款的订单不能再次发起支付 —— 重复发起会建出第二张支付单")
    void paidOrderCannotBePaidAgain() {
        givenOrder("pending_ship");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.requirePayable(ORDER_ID, BUYER)).getCode());

        givenOrder("refunding");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.requirePayable(ORDER_ID, BUYER)).getCode());
    }

    @Test
    @DisplayName("只有卖家本人能发货")
    void onlySellerCanShip() {
        givenOrder("pending_ship");
        assertDoesNotThrow(() -> service.shipOrder(ORDER_ID, "SF12345678", "顺丰速运", SELLER));
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.shipOrder(ORDER_ID, "SF12345678", "顺丰速运", BUYER)).getCode());
    }

    @Test
    @DisplayName("状态机只许顺流：已完成 / 已取消是终态，不能再改回去")
    void terminalStatusesRejectFurtherTransitions() {
        givenOrder("completed");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.requirePayable(ORDER_ID, BUYER)).getCode());

        givenOrder("cancelled");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.shipOrder(ORDER_ID, "SF1", "顺丰速运", SELLER)).getCode());
    }

    @Test
    @DisplayName("非法流转报 1001（业务拒绝）而非 500 —— 否则日志里真假故障分不开")
    void illegalTransitionIsParamError() {
        givenOrder("pending_payment");
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.shipOrder(ORDER_ID, "SF1", "顺丰速运", SELLER));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
        // 文案要带中文状态名，不能把状态码直接抛给用户
        assertTrue(ex.getMessage().contains("待付款"), "实际文案：" + ex.getMessage());
    }

    @Test
    @DisplayName("状态中文标签：未知状态原样返回，不吞掉信息")
    void labelOfKeepsUnknownStatus() {
        assertEquals("待付款", OrderService.labelOf("pending_payment"));
        assertEquals("已完成", OrderService.labelOf("completed"));
        assertEquals("unknown_x", OrderService.labelOf("unknown_x"));
        assertEquals("", OrderService.labelOf(null));
    }
}
