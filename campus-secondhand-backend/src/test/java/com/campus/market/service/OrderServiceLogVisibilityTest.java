package com.campus.market.service;

import com.campus.market.entity.Order;
import com.campus.market.entity.OrderLog;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderLogMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 「后台内部信息不下发给买卖双方」的回归测试。
 * <p>
 * ★ 守的是什么 ★
 * <p>
 * 订单接口有两个出口会把数据交给买卖双方：{@code GET /orders}（列表，经 {@code fillLogs}
 * 回填日志与备注）与 {@code GET /orders/{id}/logs}。它们同时承载两类内容：
 * <ul>
 *   <li><b>履约留痕</b> —— 下单 / 付款 / 发货 / 收货 / 退款原因 / 驳回原因，买卖双方都该看到；</li>
 *   <li><b>后台内部备注</b> —— {@code t_order.admin_note} 与 {@code t_order_log} 里
 *       {@code action='note'} 的那一行（其 {@code note} 列就是备注原文），只该管理员看到。</li>
 * </ul>
 * 前端 `types/index.ts` 把 {@code Order.adminNote} 的契约写得很明确
 * ——「只对管理员可见，买家与卖家都看不到」，所以这两种内容一旦混着下发，
 * 就是后端违约；而且**不会报错、界面上也看不出来**，只有打开开发者工具读响应体才会发现。
 * <p>
 * ★ 为什么这个测试必须存在 ★
 * <p>
 * 修之前，前端的订单页恰好没有渲染 {@code logs}、也没渲染 {@code adminNote}，
 * 所以「泄漏」停在响应体里，没有变成屏幕上的事故。这种「靠前端不渲染兜底」的防线
 * 一旦被前端补功能（渲染订单时间线）踩掉，缺陷会立刻浮现。因此这里把断言钉在后端出口上：
 * 无论前端怎么改，非管理员拿到的数据里都不该有内部备注。
 */
class OrderServiceLogVisibilityTest {

    private static final String ORDER_ID = "2026091700001";
    private static final long BUYER = 4L;
    private static final long SELLER = 5L;
    private static final long OUTSIDER = 9L;

    private static final String ADMIN_NOTE_TEXT = "疑似黄牛，注意后续下单频率";

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
                // 本测试只覆盖日志 / 备注的可见性，与下单时的价格快照无关，活动服务用空实现
                mock(ActivityService.class));
    }

    /** 一条正常履约日志 */
    private static OrderLog log(long id, String action, String label, String note) {
        OrderLog l = new OrderLog();
        l.setId(id);
        l.setOrderId(ORDER_ID);
        l.setTime(LocalDateTime.now());
        l.setAction(action);
        l.setActionLabel(label);
        l.setOperator("管理员");
        l.setOperatorRole("admin");
        l.setNote(note);
        return l;
    }

    /** 库里的一笔订单：既有履约日志，也有一条后台内部备注日志 */
    private Order givenOrderWithLogs() {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setBuyerId(BUYER);
        o.setSellerId(SELLER);
        o.setStatus("shipped");
        o.setAdminNote(ADMIN_NOTE_TEXT);
        when(orderMapper.selectById(ORDER_ID)).thenReturn(o);
        when(orderLogMapper.selectList(any())).thenReturn(List.of(
                log(3, "note", "更新后台备注", ADMIN_NOTE_TEXT),
                log(2, "ship", "卖家发货", "运单号 SF12345678"),
                log(1, "create", "买家下单", null)));
        return o;
    }

    private static List<String> actions(List<OrderLog> logs) {
        assertNotNull(logs, "日志列表不应为 null —— 前端会对它做 .filter / v-for");
        return logs.stream().map(OrderLog::getAction).toList();
    }

    // ==================== visibleLogs：纯函数，过滤规则本身 ====================

    @Test
    @DisplayName("非管理员：丢掉 note 行，其余履约日志原样保留（不是整段不给）")
    void visibleLogsHidesAdminNoteOnly() {
        List<OrderLog> raw = List.of(
                log(3, "note", "更新后台备注", ADMIN_NOTE_TEXT),
                log(2, "ship", "卖家发货", "运单号 SF12345678"),
                log(1, "create", "买家下单", null));

        List<OrderLog> visible = service.visibleLogs(raw, false);

        assertEquals(List.of("ship", "create"), actions(visible));
        assertTrue(visible.stream().noneMatch(l -> ADMIN_NOTE_TEXT.equals(l.getNote())),
                "备注原文绝不能出现在非管理员可见的日志里");
        // 履约信息不能被误伤：运单号是买家最关心的那一项
        assertTrue(visible.stream().anyMatch(l -> "运单号 SF12345678".equals(l.getNote())),
                "运单号属于履约留痕，买卖双方都该看到");
    }

    @Test
    @DisplayName("管理员：note 行保留 —— 后台时间线要能看到「谁在什么时候改过备注」")
    void visibleLogsKeepsNoteForAdmin() {
        List<OrderLog> raw = List.of(log(3, "note", "更新后台备注", ADMIN_NOTE_TEXT));
        assertEquals(List.of("note"), actions(service.visibleLogs(raw, true)));
    }

    @Test
    @DisplayName("没有日志的订单返回空列表，且不抛异常")
    void visibleLogsHandlesEmpty() {
        assertEquals(List.of(), service.visibleLogs(List.of(), false));
        assertEquals(List.of(), service.visibleLogs(List.of(), true));
    }

    @Test
    @DisplayName("入参为 null 时原样返回 null，不 NPE —— fillLogs 对无日志订单会传 null 语义")
    void visibleLogsToleratesNull() {
        assertNull(service.visibleLogs(null, false));
        assertNull(service.visibleLogs(null, true));
    }

    // ==================== GET /orders/{id}/logs ====================

    @Test
    @DisplayName("买家 / 卖家读自己的订单日志：拿不到后台备注")
    void partiesCannotSeeAdminNoteInLogs() {
        givenOrderWithLogs();

        for (Long viewer : List.of(BUYER, SELLER)) {
            List<OrderLog> logs = service.fetchOrderLogs(ORDER_ID, viewer, "user");
            assertEquals(List.of("ship", "create"), actions(logs),
                    "查看者 " + viewer + " 是买卖双方之一，只能看到履约留痕");
        }
    }

    @Test
    @DisplayName("全能 admin 读任意订单日志：拿得到后台备注（后台详情抽屉要用）")
    void adminSeesAdminNoteInLogs() {
        givenOrderWithLogs();
        List<OrderLog> logs = service.fetchOrderLogs(ORDER_ID, OUTSIDER, "admin");
        assertEquals(List.of("note", "ship", "create"), actions(logs));
    }

    // ==================== GET /orders（fillLogs） ====================

    @Test
    @DisplayName("买家拉订单列表：adminNote 被清空（响应体里连键都不该有），内部备注日志被滤掉")
    void buyerOrderListHasNoInternalFields() {
        Order o = givenOrderWithLogs();

        service.fillLogs(List.of(o), false);

        assertNull(o.getAdminNote(), "adminNote 必须在出口被清空，否则买家读响应体就能看到备注原文");
        assertEquals(List.of("ship", "create"), actions(o.getLogs()));
    }

    @Test
    @DisplayName("卖家拉订单列表：同样看不到后台内部备注（卖家不是后台）")
    void sellerOrderListHasNoInternalFields() {
        Order o = givenOrderWithLogs();

        service.fillLogs(List.of(o), false);

        assertNull(o.getAdminNote());
        assertTrue(actions(o.getLogs()).stream().noneMatch("note"::equals));
    }

    @Test
    @DisplayName("管理端订单列表 / 导出：adminNote 与 note 日志都保留 —— 不能把后台自己的功能修坏")
    void adminOrderListKeepsInternalFields() {
        Order o = givenOrderWithLogs();

        service.fillLogs(List.of(o), true);

        assertEquals(ADMIN_NOTE_TEXT, o.getAdminNote(),
                "后台备注是管理端列表（OrdersPanel）与详情抽屉（OrderDetailDrawer）的显示数据");
        assertEquals(List.of("note", "ship", "create"), actions(o.getLogs()));
    }

    @Test
    @DisplayName("空集合直接返回，不打库（避免无意义的 IN 查询）")
    void fillLogsSkipsEmptyInput() {
        service.fillLogs(List.of(), false);
        service.fillLogs(null, true);
    }
}
