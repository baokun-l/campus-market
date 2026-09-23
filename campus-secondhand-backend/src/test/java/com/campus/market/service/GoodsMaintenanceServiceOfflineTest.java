package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.AbstractWrapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.Goods;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
 * ★ 「自动下架」的写库方式回归测试 ★
 * <p>
 * <b>守的是什么</b>：这个功能要把一批商品从 {@code on_sale} 改成 {@code off_shelf}。
 * 有两种写法，只有一种是对的：
 * <pre>
 *   // ✗ 错：查出整行 → 改 status → 整行写回（快照回写 / lost update）
 *   Goods g = goodsMapper.selectById(id); g.setStatus("off_shelf"); goodsMapper.updateById(g);
 *   // ✓ 对：单列 UPDATE，SET 里只出现 status
 *   goodsMapper.update(null, new LambdaUpdateWrapper&lt;Goods&gt;()
 *           .set(Goods::getStatus, "off_shelf").eq(Goods::getStatus, "on_sale").lt(Goods::getCreateTime, deadline));
 * </pre>
 * 错的那种会把 {@code stock / view_count / favorite_count} 三列**盖回旧值** ——
 * 这三列别处也在写（下单扣库存、浏览 +1、收藏增减）。商户看见的是「刚才那单的库存又回来了」，
 * 而且不报错、不并发也能发生（「读」到「写」之间有人改过就够了）。
 * <p>
 * <b>判别式</b>：断言「SET 段里只有 status」「写的是 off_shelf、筛的是 on_sale」
 * 「时间边界确实是 now - N 天」，并断言「没有走 updateById」——
 * 最后一条能防止有人把实现改回旧写法而不自知。
 * <p>
 * ★ 单测只能证明「调了哪个方法、传了什么」，证明不了 SQL 在 MySQL 上真的按预期筛行 ★
 * 那是真机探针 {@code .workbuddy/e2e-auto-offline.mjs} 的职责（它会造一件 45 天前的商品，
 * 断言只有它被下架、其余 15 件一动不动）。三层缺一不可。
 */
class GoodsMaintenanceServiceOfflineTest {

    private static final int DAYS = 30;

    private AnalyticsService analyticsService;
    private GoodsMapper goodsMapper;
    private AuditLogMapper auditLogMapper;
    private GoodsMaintenanceService service;

    @BeforeEach
    void setUp() {
        analyticsService = mock(AnalyticsService.class);
        goodsMapper = mock(GoodsMapper.class);
        auditLogMapper = mock(AuditLogMapper.class);
        service = new GoodsMaintenanceService(analyticsService, goodsMapper, auditLogMapper);

        /*
         * LambdaUpdateWrapper 要把 Goods::getStatus 解析成列名 status，靠的是实体元数据；
         * 纯单测没有 MyBatis 启动流程，手动注册一次（等价于容器扫描实体的那一步）。
         * 别指望别的测试类替它注册 —— 每个测试类各注册各的。
         */
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Goods.class);
    }

    private void givenConfiguredDays(Integer days) {
        int normalized = (days == null || days <= 0) ? 0 : days;
        when(analyticsService.autoOfflineDays()).thenReturn(normalized);
    }

    /** SET 段（会顺带把 SET 的取值放进 paramNameValuePairs） */
    private static String sqlSet(Wrapper<?> wrapper) {
        return ((LambdaUpdateWrapper<?>) wrapper).getSqlSet();
    }

    /** WHERE 段。会触发惰性求值：eq/lt 的取值只有真的拼 WHERE 时才进 paramNameValuePairs */
    private static String sqlWhere(Wrapper<?> wrapper) {
        return ((AbstractWrapper<?, ?, ?>) wrapper).getSqlSegment();
    }

    /**
     * 按**出现顺序**取出某个 SQL 片段里各个 {@code #{...}} 占位符对应的实参。
     * <p>
     * ★ 为什么不能只断言「参数里同时有 off_shelf 和 on_sale」★
     * 那样写的话，把 SET 与 WHERE 的值**对调**（变成「把已下架的商品重新上架」或「一件都不动」）
     * 断言照样成立 —— 这个用例就成了「永远为真」。本方法把「哪一段、第几个参数、值是什么」
     * 一起钉住，方向写反时立刻变红（已用 RED-A 变体验证过）。
     */
    private static List<Object> argsInOrder(Wrapper<?> wrapper, String segment) {
        Map<String, Object> named = ((AbstractWrapper<?, ?, ?>) wrapper).getParamNameValuePairs();
        List<Object> out = new ArrayList<>();
        Matcher m = PLACEHOLDER.matcher(segment);
        while (m.find()) {
            out.add(named.get(m.group(1)));
        }
        return out;
    }

    /** MP 拼出来的占位符形如 {@code #{ew.paramNameValuePairs.MPGENVAL1}}，末段即 map 的 key */
    private static final Pattern PLACEHOLDER =
            Pattern.compile("#\\{ew\\.paramNameValuePairs\\.([A-Za-z0-9_]+)}");

    private Wrapper<Goods> capturedUpdate() {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Wrapper<Goods>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(goodsMapper).update(isNull(), captor.capture());
        return captor.getValue();
    }

    // ==================== 取值口径：0 / NULL = 不自动下架 ====================

    @Test
    @DisplayName("★ 配置为 0（不限/关闭）→ 一条都不改，连 UPDATE 都不发 ★")
    void zeroDaysMeansDisabled() {
        givenConfiguredDays(0);

        assertEquals(0, service.offlineStaleGoods());

        verify(goodsMapper, never()).update(any(), any());
        verify(goodsMapper, never()).updateById(any(Goods.class));
        verify(auditLogMapper, never()).insert(any(AuditLog.class));
    }

    @Test
    @DisplayName("配置为 0 时预览也返回 0，且不做任何写操作")
    void zeroDaysPreviewIsZero() {
        givenConfiguredDays(0);

        assertEquals(0, service.countStaleGoods());

        verify(goodsMapper, never()).selectCount(any());
        verify(goodsMapper, never()).update(any(), any());
    }

    // ==================== 写库方式：单列 UPDATE ====================

    @Test
    @DisplayName("★ 必须是单列 UPDATE：SET 段只有 status 一个占位符，绝不整实体回写 ★")
    void usesSingleColumnUpdate() {
        givenConfiguredDays(DAYS);
        when(goodsMapper.update(isNull(), any())).thenReturn(4);

        assertEquals(4, service.offlineStaleGoods());

        Wrapper<Goods> w = capturedUpdate();
        String set = sqlSet(w);
        assertTrue(set.contains("status"),
                "SET 段必须把 status 拼进去，实际 SET = " + set);
        assertTrue(!set.contains("stock") && !set.contains("view_count") && !set.contains("favorite_count"),
                "SET 段绝不能出现 stock/view_count/favorite_count —— 那三列别处也在写，" +
                        "一起写回就会盖掉别人的更新，实际 SET = " + set);
        assertEquals(1, argsInOrder(w, set).size(),
                "SET 段应当**只有一个**赋值（status），实际 = " + argsInOrder(w, set));
        verify(goodsMapper, never()).updateById(any(Goods.class));
    }

    @Test
    @DisplayName("★ 方向不能反：SET 里写 off_shelf，WHERE 里筛 on_sale、边界是 now - N 天")
    void statusDirectionIsCorrect() {
        givenConfiguredDays(DAYS);
        when(goodsMapper.update(isNull(), any())).thenReturn(1);

        service.offlineStaleGoods();

        Wrapper<Goods> w = capturedUpdate();
        // 先求两段（会顺带把各自的取值放进 paramNameValuePairs），再按出现顺序取实参
        List<Object> setArgs = argsInOrder(w, sqlSet(w));
        List<Object> whereArgs = argsInOrder(w, sqlWhere(w));

        assertEquals(List.of("off_shelf"), setArgs,
                "SET 段只应把 status 写成 off_shelf；若与 WHERE 的取值对调，" +
                        "这条动作就变成「把已下架的商品重新上架」，且库里看不出任何异常");
        assertEquals(2, whereArgs.size(),
                "WHERE 段应有两个条件参数（status 与 create_time 边界），实际 " + whereArgs);
        assertEquals("on_sale", whereArgs.get(0),
                "WHERE 第一个条件必须是 status='on_sale'（只碰在售），实际 " + whereArgs);
        assertTrue(whereArgs.get(1) instanceof LocalDateTime,
                "WHERE 第二个条件应是 create_time 边界，实际 " + whereArgs.get(1));
        String where = sqlWhere(w);
        assertTrue(where.contains("create_time"),
                "WHERE 里要出现 create_time 边界（命中 idx_goods_status 的前缀列），实际 " + where);
    }

    @Test
    @DisplayName("★ 时间边界必须是 now - N 天，符号/单位写反会立刻在这里变红")
    void deadlineIsNowMinusDays() {
        givenConfiguredDays(10);
        when(goodsMapper.update(isNull(), any())).thenReturn(1);

        service.offlineStaleGoods();

        Wrapper<Goods> w = capturedUpdate();
        List<Object> whereArgs = argsInOrder(w, sqlWhere(w));
        LocalDateTime captured = whereArgs.stream()
                .filter(v -> v instanceof LocalDateTime)
                .map(v -> (LocalDateTime) v)
                .findFirst()
                .orElseThrow(() -> new AssertionError("WHERE 里应当带一个 LocalDateTime 边界参数"));

        long offMinutes = Math.abs(Duration.between(LocalDateTime.now().minusDays(10), captured).toMinutes());
        assertTrue(offMinutes <= 1,
                "边界应为「当前时间 - 10 天」，实际偏差 " + offMinutes + " 分钟（捕获值 " + captured + "）");
    }

    // ==================== 审计留痕 ====================

    @Test
    @DisplayName("没有超期商品时不写操作日志（否则日志会被每天的 0 件记录淹没）")
    void noAuditWhenNothingOfflined() {
        givenConfiguredDays(DAYS);
        when(goodsMapper.update(isNull(), any())).thenReturn(0);

        assertEquals(0, service.offlineStaleGoods());

        verify(auditLogMapper, never()).insert(any(AuditLog.class));
    }

    @Test
    @DisplayName("真的下架了商品 → 记一条带件数与天数的操作日志")
    void writesAuditWhenOfflined() {
        givenConfiguredDays(DAYS);
        when(goodsMapper.update(isNull(), any())).thenReturn(7);

        service.offlineStaleGoods();

        ArgumentCaptor<AuditLog> captor = ArgumentCaptor.forClass(AuditLog.class);
        verify(auditLogMapper).insert(captor.capture());
        AuditLog log = captor.getValue();
        assertEquals("goods.auto_offline", log.getAction());
        assertEquals("自动下架超期商品", log.getActionLabel());
        assertEquals("7 件在售商品", log.getTarget());
        assertNotNull(log.getDetail());
        assertTrue(log.getDetail().contains("30"),
                "详情里要能看出「当时按几天算的」，事后追查才有依据，实际 = " + log.getDetail());
        assertNotNull(log.getOperator(), "无请求上下文时应落 system，不能是 null");
        assertNotNull(log.getCreateTime());
    }

    // ==================== 预览 ====================

    @Test
    @DisplayName("预览：只数不改，走 selectCount")
    void previewCountsWithoutWriting() {
        givenConfiguredDays(DAYS);
        when(goodsMapper.selectCount(any())).thenReturn(3L);

        assertEquals(3, service.countStaleGoods());

        verify(goodsMapper).selectCount(any());
        verify(goodsMapper, never()).update(any(), any());
        verify(goodsMapper, never()).updateById(any(Goods.class));
        verify(auditLogMapper, never()).insert(any(AuditLog.class));
    }
}
