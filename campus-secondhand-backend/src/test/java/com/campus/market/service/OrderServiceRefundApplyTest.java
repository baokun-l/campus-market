package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Goods;
import com.campus.market.entity.Order;
import com.campus.market.entity.OrderLog;
import com.campus.market.entity.User;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderLogMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 「买家申请退款」闭环的回归测试。
 * <p>
 * ★ 守的是什么 ★
 * <p>
 * 订单状态机里 {@code pending_ship / shipped / received → refunding} 三条边一直都在，
 * 管理端的「同意退款 / 驳回退款」也早就实现了，但**买家一侧从来没有入口** ——
 * 全代码没有一处能把订单置成 {@code refunding}。买家付完款发现货不对版时，
 * 「取消订单」只对未付款开放，于是既退不了、也申请不了，只能线下找管理员。
 * <p>
 * 这个测试同时钉住三件容易在改动中悄悄丢掉的事：
 * <ul>
 *   <li><b>申请阶段不写 {@code refund_time}</b> —— 它是**完成时间**，前端拿它统计
 *       「已退款金额」，申请即写入会把审核中的售后算成已退的钱；</li>
 *   <li><b>审批时不改写买家的申请原因与发起方</b> —— 申请理由是证据，
 *       被覆写成「平台发起 · 双方协商一致退款」后售后统计就彻底失去意义；</li>
 *   <li><b>驳回时必须显式清空 refund_*</b> —— {@code updateById} 默认跳过 null 字段，
 *       靠它清空等于没清，库里的退款单会残留在一张已恢复履约的订单上。</li>
 * </ul>
 */
class OrderServiceRefundApplyTest {

    private static final String ORDER_ID = "2026091700001";
    private static final long BUYER = 4L;
    private static final long SELLER = 5L;
    private static final long GOODS_ID = 7L;

    private OrderMapper orderMapper;
    private GoodsMapper goodsMapper;
    private OrderLogMapper orderLogMapper;
    private UserMapper userMapper;
    private OrderService service;

    @BeforeEach
    void setUp() {
        orderMapper = mock(OrderMapper.class);
        goodsMapper = mock(GoodsMapper.class);
        orderLogMapper = mock(OrderLogMapper.class);
        userMapper = mock(UserMapper.class);
        service = new OrderService(
                orderMapper,
                goodsMapper,
                orderLogMapper,
                userMapper,
                mock(AuditLogMapper.class),
                mock(ActivityService.class));
        /*
         * LambdaUpdateWrapper 解析列名（Order::getRefundAmount → refund_amount）要靠实体元数据，
         * 纯单测没有 MyBatis 启动流程，手动注册一次（等价于容器扫描实体的那一步）。
         * Goods 也要 —— refundOrder 会走 restoreStock，那里用的是 LambdaUpdateWrapper<Goods>。
         */
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Order.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Goods.class);
    }

    // ==================== 工具 ====================

    private Order givenOrder(String status) {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setBuyerId(BUYER);
        o.setSellerId(SELLER);
        o.setStatus(status);
        o.setGoodsId(GOODS_ID);
        o.setQuantity(2);
        o.setAmount(new BigDecimal("50.00"));
        when(orderMapper.selectById(ORDER_ID)).thenReturn(o);
        return o;
    }

    private void givenBuyer() {
        User u = new User();
        u.setId(BUYER);
        u.setNickname("小明");
        when(userMapper.selectById(BUYER)).thenReturn(u);
    }

    private void givenGoods(int stock, String status) {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setStock(stock);
        g.setStatus(status);
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
    }

    private static OrderLog orderLog(long id, String action, String label,
                                     String from, String to, LocalDateTime time) {
        OrderLog l = new OrderLog();
        l.setId(id);
        l.setOrderId(ORDER_ID);
        l.setTime(time != null ? time : LocalDateTime.now());
        l.setAction(action);
        l.setActionLabel(label);
        l.setFromStatus(from);
        l.setToStatus(to);
        l.setOperator("小明");
        l.setOperatorRole("buyer");
        return l;
    }

    /** 捕获这次操作写进 t_order_log 的所有条目（按插入顺序） */
    private List<OrderLog> capturedLogs() {
        ArgumentCaptor<OrderLog> captor = ArgumentCaptor.forClass(OrderLog.class);
        verify(orderLogMapper, atLeastOnce()).insert(captor.capture());
        return captor.getAllValues();
    }

    private static Order capturedUpdate(OrderMapper mapper) {
        ArgumentCaptor<Order> captor = ArgumentCaptor.forClass(Order.class);
        verify(mapper).updateById(captor.capture());
        return captor.getValue();
    }

    // ==================== ① 申请 ====================

    @Test
    @DisplayName("买家申请退款：订单进入 refunding；退款单只写金额/原因/发起方，完成时间留空")
    void applyRefundMovesOrderIntoRefunding() {
        givenOrder("pending_ship");
        givenBuyer();

        service.applyRefund(ORDER_ID, BUYER, "商品存在质量问题");

        Order saved = capturedUpdate(orderMapper);
        assertEquals("refunding", saved.getStatus());
        assertEquals(0, new BigDecimal("50.00").compareTo(saved.getRefundAmount()),
                "申请时先按全额挂在退款单上，审批人可改小（部分退款）");
        assertEquals("buyer", saved.getRefundBy(), "发起方必须是 buyer，管理端据此显示「买家申请」");
        assertEquals("商品存在质量问题", saved.getRefundReason());
        assertNull(saved.getRefundTime(), "★ 申请阶段不能写退款完成时间：前端拿它统计已退金额 ★");
        assertNull(saved.getRefundRemark(), "备注是审批人写的处理说明，申请阶段不该有值");

        // 申请时间只存在这条日志里（响应出口再由 fillLogs 回填成 refund.time）
        OrderLog applied = capturedLogs().get(0);
        assertEquals("refund", applied.getAction());
        assertEquals("买家申请退款", applied.getActionLabel());
        assertEquals("pending_ship", applied.getFromStatus());
        assertEquals("refunding", applied.getToStatus());
        assertEquals("buyer", applied.getOperatorRole());
        assertEquals("小明", applied.getOperator());
        assertEquals("商品存在质量问题", applied.getNote());
        assertNotNull(applied.getTime());
    }

    @Test
    @DisplayName("已付款的三种状态都能申请 —— 收货后才发现问题是最常见的售后场景")
    void applyRefundAllowedAfterPayment() {
        for (String status : List.of("pending_ship", "shipped", "received")) {
            givenOrder(status);
            givenBuyer();
            assertDoesNotThrow(() -> service.applyRefund(ORDER_ID, BUYER, "不想要了"),
                    status + " 应允许买家申请退款");
        }
    }

    @Test
    @DisplayName("非买家本人不得申请（越权防线）")
    void onlyBuyerCanApplyRefund() {
        givenOrder("pending_ship");
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.applyRefund(ORDER_ID, SELLER, "不想要了")).getCode());
    }

    @Test
    @DisplayName("待付款走取消、终态退不了、售后中不许重复申请")
    void applyRefundRejectsIllegalStatus() {
        // 未付款：直接作废即可，不该走退款线
        givenOrder("pending_payment");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.applyRefund(ORDER_ID, BUYER, "不想要了")).getCode());

        for (String status : List.of("completed", "cancelled")) {
            givenOrder(status);
            assertEquals(BusinessCode.PARAM_ERROR,
                    assertThrows(BusinessException.class,
                            () -> service.applyRefund(ORDER_ID, BUYER, "不想要了")).getCode(),
                    status + " 是终态，没有出口");
        }

        // 已经申请过：给的是「等待处理」而不是「非法流转」，用户才知道该等而不是以为点错了
        givenOrder("refunding");
        BusinessException e = assertThrows(BusinessException.class,
                () -> service.applyRefund(ORDER_ID, BUYER, "不想要了"));
        assertTrue(e.getMessage().contains("等待平台处理"), e.getMessage());
    }

    @Test
    @DisplayName("申请原因必填，且不得超过 refund_reason 的 200 字符")
    void applyRefundRequiresReason() {
        givenOrder("shipped");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.applyRefund(ORDER_ID, BUYER, "   ")).getCode());

        // 超长会在写库那一刻抛 Data too long：整个申请事务回滚，而提示只有一句 500
        String tooLong = "原".repeat(201);
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.applyRefund(ORDER_ID, BUYER, tooLong)).getCode());
    }

    // ==================== ② 审批（同意） ====================

    @Test
    @DisplayName("审批买家申请：保留原申请原因与发起方，只允许改金额与备注")
    void approveKeepsBuyerReasonAndInitiator() {
        Order o = givenOrder("refunding");
        o.setRefundAmount(new BigDecimal("50.00"));
        o.setRefundReason("商品存在质量问题");
        o.setRefundBy("buyer");
        givenGoods(3, "on_sale");

        service.refundOrder(ORDER_ID, new BigDecimal("25.00"), "其他", "同意，协商退一半");

        Order saved = capturedUpdate(orderMapper);
        assertEquals("cancelled", saved.getStatus());
        assertEquals("商品存在质量问题", saved.getRefundReason(),
                "申请理由是证据，审批人不能改写");
        assertEquals("buyer", saved.getRefundBy(), "发起方仍是买家");
        assertEquals(0, new BigDecimal("25.00").compareTo(saved.getRefundAmount()),
                "金额是审批结论，允许部分退");
        assertEquals("同意，协商退一半", saved.getRefundRemark());
        assertNotNull(saved.getRefundTime(), "审批通过才写退款完成时间");

        List<String> labels = capturedLogs().stream().map(OrderLog::getActionLabel).toList();
        assertEquals(List.of("退款完成，订单关闭"), labels,
                "买家已经申请过，不能再补一条「平台发起退款」—— 否则时间线上出现两次申请");
    }

    @Test
    @DisplayName("平台直接退款：发起方记 admin，并补一条「平台发起退款」日志")
    void adminDirectRefundRecordsPlatformInitiation() {
        givenOrder("pending_ship");
        givenGoods(3, "on_sale");

        service.refundOrder(ORDER_ID, null, "卖家缺货", "已电话沟通");

        Order saved = capturedUpdate(orderMapper);
        assertEquals("admin", saved.getRefundBy());
        assertEquals("卖家缺货", saved.getRefundReason());
        assertEquals(0, new BigDecimal("50.00").compareTo(saved.getRefundAmount()),
                "不传金额视为全额退");

        List<String> labels = capturedLogs().stream().map(OrderLog::getActionLabel).toList();
        assertEquals(List.of("平台发起退款", "退款完成，订单关闭"), labels);
    }

    // ==================== ③ 审批（驳回） ====================

    @Test
    @DisplayName("驳回退款：refund_* 必须显式 SET 成 NULL（updateById 会跳过 null，等于没清）")
    void rejectClearsRefundColumnsExplicitly() {
        Order o = givenOrder("refunding");
        o.setRefundAmount(new BigDecimal("50.00"));
        o.setRefundReason("商品存在质量问题");
        o.setRefundBy("buyer");
        // 「退回哪个状态」取自「进入 refunding 的那条日志」的 from_status
        when(orderLogMapper.selectList(any())).thenReturn(List.of(
                orderLog(2, "refund", "买家申请退款", "shipped", "refunding", LocalDateTime.now())));
        when(orderMapper.update(isNull(), any())).thenReturn(1);

        service.rejectRefund(ORDER_ID, "已核实，非质量问题");

        @SuppressWarnings({"unchecked", "rawtypes"})
        ArgumentCaptor<Wrapper<Order>> captor = ArgumentCaptor.forClass((Class) Wrapper.class);
        verify(orderMapper).update(isNull(), captor.capture());
        // ★ 红绿判据：旧实现走 updateById，而它默认 NOT_NULL 策略会把 null 字段整个跳过，
        //   库里 refund_amount / reason / by / remark / time 五列原样残留 ★
        verify(orderMapper, never()).updateById(any(Order.class));

        LambdaUpdateWrapper<Order> wrapper = (LambdaUpdateWrapper<Order>) captor.getValue();
        String sqlSet = wrapper.getSqlSet();
        for (String col : List.of("status", "refund_amount", "refund_reason",
                "refund_by", "refund_remark", "refund_time")) {
            assertTrue(sqlSet.contains(col + "="), "SET 片段缺少 " + col + "：" + sqlSet);
        }
        assertTrue(wrapper.getParamNameValuePairs().containsValue("shipped"),
                "退回目标应是申请前的 shipped（来自日志），不是写死的值");

        OrderLog rejected = capturedLogs().get(0);
        assertEquals("驳回退款申请", rejected.getActionLabel());
        assertEquals("refunding", rejected.getFromStatus());
        assertEquals("shipped", rejected.getToStatus());
    }

    @Test
    @DisplayName("并发下状态已变：驳回不静默成功，而是让调用方刷新重试")
    void rejectFailsWhenStatusChangedUnderneath() {
        Order o = givenOrder("refunding");
        o.setRefundBy("buyer");
        when(orderLogMapper.selectList(any())).thenReturn(List.of(
                orderLog(2, "refund", "买家申请退款", "shipped", "refunding", LocalDateTime.now())));
        // 乐观守卫没命中：0 行受影响
        when(orderMapper.update(isNull(), any())).thenReturn(0);

        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.rejectRefund(ORDER_ID, "不通过")).getCode());
    }

    // ==================== ④ 响应契约：refund.time = 申请时间 ====================

    @Test
    @DisplayName("refund.time 给的是「申请时间」，不是退款完成时间")
    void refundTimeExposesApplyTime() {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setStatus("refunding");
        o.setRefundAmount(new BigDecimal("50.00"));
        o.setRefundReason("商品存在质量问题");
        o.setRefundBy("buyer");
        LocalDateTime appliedAt = LocalDateTime.of(2026, 9, 20, 10, 0, 0);
        when(orderLogMapper.selectList(any())).thenReturn(List.of(
                orderLog(1, "refund", "买家申请退款", "shipped", "refunding", appliedAt)));

        service.fillLogs(List.of(o), true);

        Map<String, Object> refund = o.getRefund();
        assertNotNull(refund, "售后中的订单必须下发 refund 键，否则前端整个退款卡片都不显示");
        assertEquals(appliedAt, refund.get("time"),
                "★ OrderRefund.time 的语义是申请时间，完成时间另有 Order.refundTime ★");
        assertEquals("buyer", refund.get("by"));
        assertEquals("商品存在质量问题", refund.get("reason"));
    }

    @Test
    @DisplayName("没有售后记录的订单不下发 refund 键（前端以 v-if=\"order.refund\" 判定）")
    void noRefundKeyWithoutRefund() {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setStatus("shipped");
        assertNull(o.getRefund());
    }
}
