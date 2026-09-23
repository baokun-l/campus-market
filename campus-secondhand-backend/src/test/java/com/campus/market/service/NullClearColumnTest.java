package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.AbstractWrapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.entity.Activity;
import com.campus.market.entity.Goods;
import com.campus.market.entity.Order;
import com.campus.market.entity.OrderLog;
import com.campus.market.entity.User;
import com.campus.market.mapper.ActivityMapper;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ★ 「清空列」缺陷族的回归测试 ★
 * <p>
 * <b>守的是什么</b>：MyBatis-Plus 默认 {@code FieldStrategy.NOT_NULL}，**null 字段不进 SET 子句**
 * （本项目 {@code application.yml} 未覆盖 {@code update-strategy}，已逐项确认）。
 * 于是下面这种写法在库上**等于什么都没做**：
 * <pre>
 *   entity.setX(null);
 *   mapper.updateById(entity);     // ← SET 子句里根本没有 x
 * </pre>
 * 它不是"数据丢了"，而是"**该删的没删掉**"：操作报成功、结果没变，
 * 而日志/界面却按"已经清空"继续往下走 —— 库与审计互相矛盾。
 * <p>
 * 单线程与单测都很难发现（不报错、不抛异常、不并发也复现），所以这里把三条真实调用钉死：
 * <ul>
 *   <li>{@code OrderService.saveOrderNote} —— 清空后台备注；</li>
 *   <li>{@code ActivityService.restartFeatured / setEnabled / update} —— 清空取消标记
 *       （前端 {@code ActivityPanel.vue} 的 {@code v-if="cancelledAt"} 会把重开的活动渲染成「已下架」）；</li>
 *   <li>{@code OrderService.applyRefund} —— 保证 {@code refund_time} 在申请阶段为 NULL
 *       （前端拿它统计「已退款金额」）。</li>
 * </ul>
 * <b>判别式</b>：断言「写进 SET 子句的确实是这几列、且参数为 null」，
 * 同时断言「没有走 {@code updateById}」—— 后者能防止有人把实现改回旧写法而不自知。
 */
class NullClearColumnTest {

    private static final String ORDER_ID = "2026091700001";
    private static final long BUYER = 4L;
    private static final long SELLER = 5L;
    private static final long GOODS_ID = 7L;
    private static final String ACTIVITY_ID = "act-2026-09";

    private OrderMapper orderMapper;
    private GoodsMapper goodsMapper;
    private OrderLogMapper orderLogMapper;
    private UserMapper userMapper;
    private ActivityMapper activityMapper;
    private OrderService orderService;
    private ActivityService activityService;

    @BeforeEach
    void setUp() {
        orderMapper = mock(OrderMapper.class);
        goodsMapper = mock(GoodsMapper.class);
        orderLogMapper = mock(OrderLogMapper.class);
        userMapper = mock(UserMapper.class);
        activityMapper = mock(ActivityMapper.class);

        orderService = new OrderService(
                orderMapper,
                goodsMapper,
                orderLogMapper,
                userMapper,
                mock(AuditLogMapper.class),
                mock(ActivityService.class));
        activityService = new ActivityService(activityMapper, mock(AuditLogMapper.class));

        /*
         * LambdaUpdateWrapper 要把 Order::getAdminNote 解析成列名 admin_note，靠的是实体元数据；
         * 纯单测没有 MyBatis 启动流程，手动注册一次（等价于容器扫描实体的那一步）。
         */
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Order.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Activity.class);
    }

    // ==================== 工具 ====================

    private Order givenOrder(String status) {
        return givenOrder(status, null);
    }

    private Order givenOrder(String status, String adminNote) {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setBuyerId(BUYER);
        o.setSellerId(SELLER);
        o.setStatus(status);
        o.setGoodsId(GOODS_ID);
        o.setQuantity(2);
        o.setAmount(new BigDecimal("50.00"));
        o.setAdminNote(adminNote);
        when(orderMapper.selectById(ORDER_ID)).thenReturn(o);
        return o;
    }

    /** 捕获本次写库用的单列 UPDATE，并断言「没有走 updateById 整实体回写」 */
    private Wrapper<Order> capturedOrderClear(OrderMapper mapper) {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Wrapper<Order>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(mapper).update(isNull(), captor.capture());
        return captor.getValue();
    }

    private Wrapper<Activity> capturedActivityClear(ActivityMapper mapper) {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Wrapper<Activity>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(mapper).update(isNull(), captor.capture());
        return captor.getValue();
    }

    private static String sqlSet(Wrapper<?> wrapper) {
        return ((LambdaUpdateWrapper<?>) wrapper).getSqlSet();
    }

    /**
     * WHERE 段。<b>它会触发惰性求值</b>：{@code eq(...)} 的取值包在 {@code ISqlSegment}
     * lambda 里，只有真的求 WHERE 段时才会把参数放进 {@code paramNameValuePairs}
     * （{@code getSqlSet()} 只求 SET 段，所以先前的 params 里看不到 WHERE 的值）。
     */
    private static String whereSegment(Wrapper<?> wrapper) {
        return ((AbstractWrapper<?, ?, ?>) wrapper).getSqlSegment();
    }

    /**
     * 只含 SET 段的值（不含 WHERE 参数）不足以判断清空是否成立，
     * 这里取全部具名参数：SET 的赋值与 WHERE 的条件值都在里面
     * （{@code getParamNameValuePairs} 定义在 {@link AbstractWrapper} 上，不在 {@code Wrapper} 接口上）。
     */
    private static Map<String, Object> params(Wrapper<?> wrapper) {
        return ((AbstractWrapper<?, ?, ?>) wrapper).getParamNameValuePairs();
    }

    /** SET 段里是否真的有「某一列被赋成 null」 */
    private static boolean hasNullAssignment(Wrapper<?> wrapper) {
        return params(wrapper).values().stream().anyMatch(v -> v == null);
    }

    private Activity givenActivity(boolean enabled, Long cancelledAt, String cancelledBy) {
        Activity a = new Activity();
        a.setId(ACTIVITY_ID);
        a.setTitle("开学季");
        a.setEnabled(enabled);
        a.setStartAt(System.currentTimeMillis() - 86_400_000L);
        a.setDurationDays(30);
        a.setPriority(1);
        a.setCancelledAt(cancelledAt);
        a.setCancelledBy(cancelledBy);
        when(activityMapper.selectById(ACTIVITY_ID)).thenReturn(a);
        // seedIfEmpty 会先 selectCount；mock 返回 1 表示"表里有数据"，避免它去灌出厂活动
        when(activityMapper.selectCount(any())).thenReturn(1L);
        when(activityMapper.selectList(any())).thenReturn(new ArrayList<>(List.of(a)));
        return a;
    }

    // ==================== N1 · 清空后台备注 ====================

    @Test
    @DisplayName("清空后台备注：必须显式 SET admin_note = NULL，不能靠 updateById")
    void saveOrderNoteClearsAdminNoteExplicitly() {
        givenOrder("pending_ship", "已电话联系卖家");

        orderService.saveOrderNote(ORDER_ID, "");

        Wrapper<Order> wrapper = capturedOrderClear(orderMapper);
        assertTrue(sqlSet(wrapper).contains("admin_note"),
                "清空备注必须把 admin_note 拼进 SET 子句，实际 SET = " + sqlSet(wrapper));
        assertTrue(hasNullAssignment(wrapper),
                "admin_note 要真的被赋成 null（updateById 做不到这件事）");
        verify(orderMapper, never()).updateById(any(Order.class));
    }

    @Test
    @DisplayName("清空后台备注：日志写「清空后台备注」，与库里结果一致")
    void saveOrderNoteLogsClearWithNullNote() {
        givenOrder("pending_ship", "旧备注");

        orderService.saveOrderNote(ORDER_ID, "   ");

        ArgumentCaptor<OrderLog> captor = ArgumentCaptor.forClass(OrderLog.class);
        verify(orderLogMapper).insert(captor.capture());
        assertEquals("note", captor.getValue().getAction());
        assertEquals("清空后台备注", captor.getValue().getActionLabel());
        assertEquals(null, captor.getValue().getNote(), "日志里的备注也应是 null，别与库不一致");
    }

    @Test
    @DisplayName("备注没变化时不写库、不记日志（D17 的降噪语义不能回退）")
    void saveOrderNoteNoOpWhenUnchanged() {
        givenOrder("pending_ship", null);

        orderService.saveOrderNote(ORDER_ID, "");

        verify(orderMapper, never()).update(any(), any());
        verify(orderMapper, never()).updateById(any(Order.class));
        verify(orderLogMapper, never()).insert(any(OrderLog.class));
    }

    @Test
    @DisplayName("写正文备注：仍然只 SET admin_note 一列")
    void saveOrderNoteUpdatesAdminNote() {
        givenOrder("pending_ship", "旧备注");

        orderService.saveOrderNote(ORDER_ID, "已退款，无需再联系");

        Wrapper<Order> wrapper = capturedOrderClear(orderMapper);
        assertTrue(sqlSet(wrapper).contains("admin_note"));
        assertTrue(params(wrapper).containsValue("已退款，无需再联系"));
        verify(orderMapper, never()).updateById(any(Order.class));
    }

    // ==================== N2 · 清空活动取消标记 ====================

    @Test
    @DisplayName("重开主推活动：cancelled_at / cancelled_by 必须被显式清空")
    void restartFeaturedClearsCancelledMark() {
        givenActivity(false, 1_700_000_000_000L, "admin");

        activityService.restartFeatured(14, "admin");

        Wrapper<Activity> wrapper = capturedActivityClear(activityMapper);
        String set = sqlSet(wrapper);
        assertTrue(set.contains("cancelled_at"), "SET 里必须有 cancelled_at，实际 " + set);
        assertTrue(set.contains("cancelled_by"), "SET 里必须有 cancelled_by，实际 " + set);
        assertTrue(hasNullAssignment(wrapper), "两列要真的被赋成 null");
    }

    @Test
    @DisplayName("上架活动（setEnabled true）：同样要清掉取消标记")
    void setEnabledTrueClearsCancelledMark() {
        givenActivity(false, 1_700_000_000_000L, "admin");

        activityService.setEnabled(ACTIVITY_ID, true, "admin");

        Wrapper<Activity> wrapper = capturedActivityClear(activityMapper);
        String set = sqlSet(wrapper);
        assertTrue(set.contains("cancelled_at") && set.contains("cancelled_by"), "实际 " + set);
        assertTrue(hasNullAssignment(wrapper));
    }

    @Test
    @DisplayName("★ 下架活动时绝不能顺手清空：否则刚写的取消记录会被自己抹掉")
    void setEnabledFalseKeepsCancelledMark() {
        givenActivity(true, null, null);

        activityService.setEnabled(ACTIVITY_ID, false, "admin");

        verify(activityMapper, never()).update(isNull(), any());
        ArgumentCaptor<Activity> captor = ArgumentCaptor.forClass(Activity.class);
        verify(activityMapper).updateById(captor.capture());
        assertNotNull(captor.getValue().getCancelledAt(), "下架必须留下取消时间");
        assertEquals("admin", captor.getValue().getCancelledBy());
    }

    @Test
    @DisplayName("编辑活动把 cancelledAt 置空：patch 的清空意图也要落到库上")
    void updateWithNullCancelledAtClearsMark() {
        givenActivity(false, 1_700_000_000_000L, "admin");

        activityService.update(ACTIVITY_ID, Map.of("cancelledAt", ""), "admin");

        Wrapper<Activity> wrapper = capturedActivityClear(activityMapper);
        assertTrue(sqlSet(wrapper).contains("cancelled_by"), "实际 " + sqlSet(wrapper));
        assertTrue(hasNullAssignment(wrapper));
    }

    // ==================== N3 · 申请退款时保证 refund_* 干净 ====================

    @Test
    @DisplayName("买家申请退款：refund_time / refund_remark 必须显式置 NULL（不能只靠实体 set null）")
    void applyRefundClearsRefundCompletionColumns() {
        givenOrder("pending_ship");
        User buyer = new User();
        buyer.setId(BUYER);
        buyer.setNickname("小明");
        when(userMapper.selectById(BUYER)).thenReturn(buyer);

        orderService.applyRefund(ORDER_ID, BUYER, "商品存在质量问题");

        Wrapper<Order> wrapper = capturedOrderClear(orderMapper);
        String set = sqlSet(wrapper);
        assertTrue(set.contains("refund_time"),
                "refund_time 是完成时间，申请阶段必须为 NULL，实际 SET = " + set);
        assertTrue(set.contains("refund_remark"), "新申请不该继承上一轮的平台备注，实际 " + set);
        assertTrue(hasNullAssignment(wrapper));
        // status='refunding' 是 WHERE 守卫而不是 SET 赋值，所以查 WHERE 段 + 它的取值
        String where = whereSegment(wrapper);
        assertTrue(where.contains("status"),
                "幂等兜底要带乐观守卫 status='refunding'，实际 WHERE = " + where);
        assertTrue(params(wrapper).containsValue("refunding"),
                "守卫值应为 refunding，实际 params = " + params(wrapper));
    }
}
