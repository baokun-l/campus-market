package com.campus.market.service;

import com.campus.market.common.InstanceSeqGenerator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
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
 * ★ L10 的回归测试：限时活动的业务主键 id ★
 * <p>
 * <b>守的是什么</b>：{@code t_activity.id} 是 {@code VARCHAR(64) NOT NULL PRIMARY KEY}
 * —— 不是自增，是**业务字符串主键**。撞号 = 主键冲突 = 管理员点「新建活动」看到 500，
 * 且日志里没有任何线索指向撞号。
 * <p>
 * <b>旧实现（2026-09-22 修）</b>：
 * <pre>
 * private static final AtomicLong ID_SEQ = new AtomicLong();
 * "act_" + Long.toString(System.currentTimeMillis(), 36)
 *        + Long.toString(ID_SEQ.incrementAndGet(), 36)
 * </pre>
 * 三个毛病：
 * <ol>
 *   <li><b>纯进程内状态</b> —— 多实例各从 0 起，同毫秒建活动就撞号（与 L5 完全同族，
 *       L5 修了订单号，这处漏了）；</li>
 *   <li><b>base36 两段无分隔符拼接</b> —— {@code base36(a) + base36(b)} 无法唯一切分，
 *       不同的 (毫秒, 序号) 组合理论上能拼出同一个串；</li>
 *   <li><b>与订单号同族却两份实现</b> —— 典型的「改一处没查另一处」。</li>
 * </ol>
 * <p>
 * <b>判据</b>：同毫秒连发不撞号、换毫秒归零、实例号段零交集、
 * 形态可唯一切分（{@code act_ + 17 位时间戳 + 1 位实例号 + 2 位序号}）、
 * 越界实例号报错，以及④组那条**结构断言**：不许再冒出第二份发号状态。
 */
class ActivityIdUniquenessTest {

    private static final long T0 = 1_756_000_000_000L;
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");
    private static final Pattern ACT_ID = Pattern.compile("^act_\\d{20}$");

    private static String tsOf(long millis) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneId.systemDefault()).format(TS);
    }

    /** 造一个只用于发号的实例：mapper 不参与发号，传 mock 即可 */
    private static ActivityService serviceWithInstanceId(int instanceId) {
        ActivityService s = new ActivityService(
                Mockito.mock(com.campus.market.mapper.ActivityMapper.class),
                Mockito.mock(com.campus.market.mapper.AuditLogMapper.class));
        try {
            Field f = ActivityService.class.getDeclaredField("instanceId");
            f.setAccessible(true);
            f.setInt(s, instanceId);
        } catch (ReflectiveOperationException e) {
            // ★ 字段被改名就响亮失败 ★：否则反射 setInt 静默失效，测试会拿默认 0 继续跑，
            // 看起来"通过了"，实际测的是另一套配置 —— 这正是本项目踩过的最坏失败模式。
            throw new IllegalStateException("ActivityService 缺少 instanceId 字段（被改名了？）", e);
        }
        return s;
    }

    @Nested
    @DisplayName("① 唯一性")
    class Uniqueness {

        @Test
        @DisplayName("★ 同一毫秒内连发 101 个 id，两两不同")
        void neverCollidesWithinOneMillisecond() {
            ActivityService s = serviceWithInstanceId(0);
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 101; i++) {
                String id = s.nextId(T0);
                assertTrue(seen.add(id), "第 " + i + " 个活动 id 撞了：" + id);
            }
            assertEquals(101, seen.size());
        }

        /**
         * ★★ 这个用例的**写法本身就是本轮最重要的教训** ★★
         * <p>
         * 第一版写的是「两个实例各自发 300 个 id，断言两个集合**零交集**」。
         * 红绿探针把它打回去了：**旧实现照样通过** —— 旧实现用
         * {@code static AtomicLong ID_SEQ}，同一个 JVM 里两个 Service 共享同一个计数器，
         * 序号天然错开，于是"零交集"在单 JVM 里**永远成立**。
         * <p>
         * 也就是说：多实例撞号这个缺陷，**单 JVM 的单测在原理上就观察不到**
         * （每个 JVM 各有一份 static，各自从 0 起 —— 差异只在跨进程时才显现）。
         * 真正能抓住它的断言是「**实例号必须真的出现在 id 里**」：
         * 旧实现压根没有实例号这一位，一测就露馅。
         */
        @Test
        @DisplayName("★ 实例号必须真的进到 id 里（旧实现没有实例号 ⇒ 多实例必撞号）")
        void instanceIdIsEmbeddedInTheId() {
            ActivityService s0 = serviceWithInstanceId(0);
            ActivityService s1 = serviceWithInstanceId(1);
            // 发号器是**实例字段**（不是 static），所以两个 Service 在同一毫秒都从序号 00 起 ——
            // 这正是对「两个 JVM 各自从 0 起」的模拟
            String a = s0.nextId(T0);
            String b = s1.nextId(T0);
            assertEquals("act_" + tsOf(T0) + "0" + "00", a);
            assertEquals("act_" + tsOf(T0) + "1" + "00", b);
            assertEquals('0', a.charAt(21), "实例号必须落在第 22 个字符上");
            assertEquals('1', b.charAt(21), "实例号必须落在第 22 个字符上");
            // 差别只在实例号那一位 ⇒ 两个 JVM 在同毫秒各发 00 号也不会撞
            assertFalse(a.equals(b));
        }

        @Test
        @DisplayName("连续 600 个 id（两个 Service 各 300）两两不同")
        void neverCollidesAcrossServicesAndMilliseconds() {
            ActivityService s0 = serviceWithInstanceId(0);
            ActivityService s1 = serviceWithInstanceId(1);
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 300; i++) {
                assertTrue(seen.add(s0.nextId(T0 + i / 10)));
                assertTrue(seen.add(s1.nextId(T0 + i / 10)));
            }
            assertEquals(600, seen.size());
        }
    }

    @Nested
    @DisplayName("② 序号语义")
    class SequenceSemantics {

        @Test
        @DisplayName("序号按毫秒归零，且第 101 个把毫秒推进一格而不是回绕")
        void seqResetsAndRollsForward() {
            ActivityService s = serviceWithInstanceId(0);
            assertEquals("act_" + tsOf(T0) + "0" + "00", s.nextId(T0));
            assertEquals("act_" + tsOf(T0) + "0" + "01", s.nextId(T0));
            assertEquals("act_" + tsOf(T0 + 1) + "0" + "00", s.nextId(T0 + 1));

            ActivityService s2 = serviceWithInstanceId(0);
            for (int i = 0; i < 99; i++) s2.nextId(T0);
            assertEquals("act_" + tsOf(T0) + "0" + "99", s2.nextId(T0));
            assertEquals("act_" + tsOf(T0 + 1) + "0" + "00", s2.nextId(T0));
        }

        @Test
        @DisplayName("时钟回拨安全")
        void clockRollbackIsSafe() {
            ActivityService s = serviceWithInstanceId(0);
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 10; i++) seen.add(s.nextId(T0 + 500));
            for (int i = 0; i < 50; i++) {
                assertTrue(seen.add(s.nextId(T0 - 1000)), "时钟回拨导致撞号");
            }
        }
    }

    @Nested
    @DisplayName("③ 形态")
    class Format {

        @Test
        @DisplayName("★ act_ + 17 位时间戳 + 1 位实例号 + 2 位序号 = 24 字符，可唯一切分")
        void shapeIsUnambiguous() {
            ActivityService s = serviceWithInstanceId(4);
            String id = s.nextId(T0);
            assertTrue(ACT_ID.matcher(id).matches(), "活动 id 形态不对：" + id);
            assertEquals(24, id.length());
            assertEquals(tsOf(T0), id.substring(4, 21), "时间戳段可唯一定位");
            assertEquals('4', id.charAt(21), "实例号段可唯一定位");
            assertTrue(Pattern.matches("^\\d{2}$", id.substring(22)), "序号段固定 2 位");
        }

        @Test
        @DisplayName("24 字符远小于 t_activity.id 的 VARCHAR(64)")
        void fitsColumn() {
            assertTrue(serviceWithInstanceId(9).nextId(T0).length() <= 64);
        }

        @Test
        @DisplayName("实例号越界抛错（与订单号共用同一个键）")
        void outOfRangeInstanceIdThrows() {
            ActivityService s = serviceWithInstanceId(12);
            IllegalStateException ex = assertThrows(IllegalStateException.class, () -> s.nextId(T0));
            assertTrue(ex.getMessage().contains("app.instance-id"));
        }
    }

    // ==================== ④ 结构：发号逻辑不许出现第二份 ====================

    @Nested
    @DisplayName("④ 结构约束：全项目只有一份发号状态机")
    class SingleGenerator {

        @Test
        @DisplayName("★ ActivityService 与 OrderService 都只有共享发号器，没有自造的原子计数器")
        void bothServicesUseTheSharedGenerator() {
            assertNoAtomicCounterField(ActivityService.class, "ActivityService");
            assertNoAtomicCounterField(OrderService.class, "OrderService");
            assertTrue(hasGeneratorField(ActivityService.class), "ActivityService 必须用 InstanceSeqGenerator");
            assertTrue(hasGeneratorField(OrderService.class), "OrderService 必须用 InstanceSeqGenerator");
        }

        @Test
        @DisplayName("★ ActivityService 不许再出现 ID_SEQ（旧的自增字段）")
        void legacyIdSeqMustStayRemoved() {
            List<String> fields = new ArrayList<>();
            for (Field f : ActivityService.class.getDeclaredFields()) {
                if (Modifier.isStatic(f.getModifiers())) fields.add(f.getName());
            }
            assertFalse(fields.contains("ID_SEQ"),
                    "ID_SEQ 又回来了 —— L10 修的就是它（进程内自增 ⇒ 多实例撞号）");
        }

        private void assertNoAtomicCounterField(Class<?> type, String label) {
            for (Field f : type.getDeclaredFields()) {
                String n = f.getType().getSimpleName();
                assertFalse(n.startsWith("Atomic") || n.equals("LongAdder"),
                        label + " 自己留了一份原子计数器（" + n + " " + f.getName()
                                + "）—— 发号状态机必须只有一个：common/InstanceSeqGenerator");
            }
        }

        private boolean hasGeneratorField(Class<?> type) {
            for (Field f : type.getDeclaredFields()) {
                if (f.getType().equals(InstanceSeqGenerator.class)) return true;
            }
            return false;
        }
    }
}
