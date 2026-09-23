package com.campus.market.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ★ L5 的回归测试：订单号生成器 ★
 * <p>
 * <b>守的是什么</b>：订单号是 {@code t_order} 的主键，撞号 = 下单直接失败。
 * 旧实现是 {@code yyyyMMddHHmmssSSS + (全局 AtomicInteger % 1000)}，两个毛病：
 * <ol>
 *   <li><b>静默回绕</b>：第 1000 次调用把序号绕回 0。第 N 次与第 N+1000 次若落在同一毫秒
 *       （并发压测下并不罕见）就生成出**完全相同的订单号**；</li>
 *   <li><b>纯进程内状态</b>：两个 JVM 各自从 0 开始，多实例部署必然撞号。</li>
 * </ol>
 * <p>
 * <b>判据</b>：同一毫秒内连发 N 个号必须两两不同；序号要按毫秒归零；
 * 不同 {@code app.instance-id} 的号段必须零交集；越界配置要**报错**而不是静默夹紧。
 * <p>
 * <b>为什么能确定性断言</b>：生成器抽出了收毫秒的包级重载
 * {@code generateOrderId(long)}，测试传固定毫秒即可复现「同一毫秒内连发 1000 次」——
 * 换成真实时钟得靠压测撞运气，测不稳等于没测。
 */
class OrderIdUniquenessTest {

    /** 固定基准毫秒（2025-08-24T05:46:40Z），只影响时间戳前缀，不影响唯一性断言 */
    private static final long T0 = 1_756_000_000_000L;

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");
    private static final Pattern TWENTY_DIGITS = Pattern.compile("^\\d{20}$");

    private static String tsOf(long millis) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneId.systemDefault()).format(TS);
    }

    /** 造一个只用于发号的实例：mapper / service 都不参与发号，传 null 即可 */
    private static OrderService serviceWithInstanceId(int instanceId) {
        OrderService s = new OrderService(null, null, null, null, null, null);
        try {
            Field f = OrderService.class.getDeclaredField("instanceId");
            f.setAccessible(true);
            f.setInt(s, instanceId);
        } catch (ReflectiveOperationException e) {
            // 字段改名 = 测试失效，必须**响亮地**失败，不能悄悄放行
            throw new IllegalStateException(
                    "反射设置 OrderService.instanceId 失败 —— 字段可能被重命名，"
                            + "请同步更新本测试（它守的是多实例撞号这条线）", e);
        }
        return s;
    }

    private static List<String> generate(OrderService s, long millis, int count) {
        List<String> out = new ArrayList<>(count);
        for (int i = 0; i < count; i++) out.add(s.generateOrderId(millis));
        return out;
    }

    private static Set<String> dups(List<String> ids) {
        Set<String> seen = new HashSet<>();
        Set<String> dup = new HashSet<>();
        for (String id : ids) if (!seen.add(id)) dup.add(id);
        return dup;
    }

    // ==================== 唯一性（红绿的核心断言） ====================

    @Nested
    @DisplayName("唯一性")
    class Uniqueness {

        @Test
        @DisplayName("★ 同一毫秒连发 1001 个号：两两不同（旧实现会在第 1000 次回绕撞号）")
        void sameMillisecondNeverCollides() {
            OrderService s = serviceWithInstanceId(0);
            List<String> ids = generate(s, T0, 1001);

            Set<String> dup = dups(ids);
            assertTrue(dup.isEmpty(),
                    "同一毫秒内发 1001 个号出现了撞号：" + dup
                            + "（旧实现 % 1000 回绕的典型症状）");
            assertEquals(1001, new HashSet<>(ids).size(), "去重后数量应等于发号次数");
        }

        @Test
        @DisplayName("连发 5000 个号（跨多毫秒）：仍然两两不同")
        void longRunNeverCollides() {
            OrderService s = serviceWithInstanceId(0);
            // 真实场景：每 7 次调用前进 1 毫秒
            List<String> ids = new ArrayList<>();
            long t = T0;
            for (int i = 0; i < 5000; i++) {
                if (i % 7 == 0) t++;
                ids.add(s.generateOrderId(t));
            }
            Set<String> dup = dups(ids);
            assertTrue(dup.isEmpty(), "5000 次发号出现撞号：" + dup);
        }

        @Test
        @DisplayName("★ 不同 app.instance-id 的号段零交集（这条直接对应「多实例会撞号」）")
        void differentInstancesDoNotOverlap() {
            OrderService a = serviceWithInstanceId(0);
            OrderService b = serviceWithInstanceId(1);

            Set<String> idsA = new HashSet<>(generate(a, T0, 200));
            Set<String> idsB = new HashSet<>(generate(b, T0, 200));

            Set<String> overlap = new HashSet<>(idsA);
            overlap.retainAll(idsB);
            assertTrue(overlap.isEmpty(),
                    "实例 0 与实例 1 在同一毫秒发出了相同的订单号：" + overlap
                            + "（说明实例号没有参与号段划分）");
            assertEquals(200, idsA.size(), "同一实例内也不该重复");
            assertEquals(200, idsB.size(), "同一实例内也不该重复");
        }
    }

    // ==================== 序号语义 ====================

    @Nested
    @DisplayName("序号按毫秒归零")
    class SequenceSemantics {

        @Test
        @DisplayName("新毫秒的第一号序号归零；同一毫秒内递增")
        void seqResetsEveryMillisecond() {
            OrderService s = serviceWithInstanceId(0);

            String first = s.generateOrderId(T0);
            String second = s.generateOrderId(T0);
            String nextMsFirst = s.generateOrderId(T0 + 1);

            assertEquals("0" + "00", first.substring(17), "实例 0 在新毫秒的首号应是实例号 0 + 序号 00");
            assertEquals("0" + "01", second.substring(17), "同一毫秒内应递增到 01");
            assertEquals("0" + "00", nextMsFirst.substring(17), "跨毫秒必须重新归零");
            assertEquals(tsOf(T0 + 1), nextMsFirst.substring(0, 17), "时间戳前缀应换成新毫秒");
        }

        @Test
        @DisplayName("发号在时间上单调不倒退：字典序 = 时间序")
        void idsAreLexicographicallyIncreasing() {
            OrderService s = serviceWithInstanceId(0);
            List<String> ids = generate(s, T0, 300);
            for (int i = 1; i < ids.size(); i++) {
                assertTrue(ids.get(i - 1).compareTo(ids.get(i)) < 0,
                        "第 " + i + " 个号未严格递增：" + ids.get(i - 1) + " -> " + ids.get(i));
            }
        }

        @Test
        @DisplayName("时钟回拨也不撞号、不倒退（NTP 校时是常态）")
        void clockRollbackIsSafe() {
            OrderService s = serviceWithInstanceId(0);
            String before = s.generateOrderId(T0);
            generate(s, T0, 5);

            String afterRollback = s.generateOrderId(T0 - 5000);

            assertFalse(afterRollback.equals(before), "时钟回拨后重发了同一个号");
            assertTrue(afterRollback.compareTo(before) > 0,
                    "时钟回拨后订单号倒退了：" + before + " -> " + afterRollback);
        }
    }

    // ==================== 格式契约 ====================

    @Nested
    @DisplayName("格式与历史数据同形")
    class Format {

        @Test
        @DisplayName("20 位纯数字，前 17 位是该毫秒的时间戳（历史数据同形，VARCHAR(30) 装得下）")
        void formatStaysTwentyDigits() {
            OrderService s = serviceWithInstanceId(0);
            String id = s.generateOrderId(T0);

            assertTrue(TWENTY_DIGITS.matcher(id).matches(),
                    "订单号应仍是 20 位纯数字，实际 = " + id + "（长度 " + id.length() + "）");
            assertEquals(tsOf(T0), id.substring(0, 17), "前 17 位应是 yyyyMMddHHmmssSSS");
            assertEquals("0", id.substring(17, 18), "第 18 位是实例号");
        }

        @Test
        @DisplayName("越界实例号必须报错，不能静默夹紧（夹紧会与真的 9 号撞号）")
        void outOfRangeInstanceIdFailsLoudly() {
            OrderService tooBig = serviceWithInstanceId(10);
            IllegalStateException e1 = assertThrows(IllegalStateException.class,
                    () -> tooBig.generateOrderId(T0));
            assertTrue(e1.getMessage().contains("instance-id"),
                    "报错要指出是哪个配置，实际：" + e1.getMessage());

            OrderService negative = serviceWithInstanceId(-1);
            assertThrows(IllegalStateException.class, () -> negative.generateOrderId(T0));
        }
    }
}
