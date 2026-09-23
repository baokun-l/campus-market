package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ★ 共享发号器 {@link InstanceSeqGenerator} 的回归测试 ★
 * <p>
 * <b>守的是什么</b>：本项目所有业务字符串 id（订单号、活动 id…）都落在
 * **字符串业务主键**上，撞号 = 主键冲突 = 用户看到一个没有任何线索的 500。
 * <p>
 * <b>为什么要抽这个类</b>：L5 重写了订单号发号器，但同族的 {@code ActivityService.ID_SEQ}
 * 没被扫到（L10）—— 同族却两份实现，改一处漏一处。
 * 把状态机收成一份之后，「改一处必查另一处」从**靠纪律**变成**靠结构**。
 * 本测试守的就是这份共享状态机的语义，两边共用它 ⇒ 两边一起受益。
 * <p>
 * <b>判据</b>：同毫秒连发不撞号、序号按毫秒归零、发满推进毫秒而不回绕、
 * 实例号段零交集、时钟回拨安全、越界实例号**报错不夹紧**。
 */
class InstanceSeqGeneratorTest {

    private static final long T0 = 1_756_000_000_000L;
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");

    private static String tsOf(long millis) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneId.systemDefault()).format(TS);
    }

    @Nested
    @DisplayName("① 唯一性")
    class Uniqueness {

        @Test
        @DisplayName("★ 同一毫秒内连发 101 个号，两两不同（旧实现第 N 与第 N+1000 会撞）")
        void neverCollidesWithinOneMillisecond() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            Set<String> seen = new HashSet<>();
            // 2 位序号的上限是 100（00..99），第 101 个必须靠推进毫秒来让位
            for (int i = 0; i < 101; i++) {
                String id = g.id("act_", T0, 0);
                assertTrue(seen.add(id), "第 " + i + " 个号撞了：" + id);
            }
            assertEquals(101, seen.size());
        }

        @Test
        @DisplayName("连续 3000 个号（跨毫秒）也不重复")
        void neverCollidesAcrossMilliseconds() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 3000; i++) {
                assertTrue(seen.add(g.id("", T0 + i / 100, 0)));
            }
            assertEquals(3000, seen.size());
        }

        @Test
        @DisplayName("★ 实例 0 与实例 1 的号段零交集（多实例不撞号）")
        void differentInstancesNeverOverlap() {
            Set<String> a = new HashSet<>();
            Set<String> b = new HashSet<>();
            InstanceSeqGenerator g0 = new InstanceSeqGenerator(2);
            InstanceSeqGenerator g1 = new InstanceSeqGenerator(2);
            for (int i = 0; i < 500; i++) {
                a.add(g0.id("act_", T0 + i, 0));
                b.add(g1.id("act_", T0 + i, 1));
            }
            for (String id : a) {
                assertFalse(b.contains(id), "实例 0 与实例 1 撞号：" + id);
            }
        }
    }

    @Nested
    @DisplayName("② 序号语义")
    class SequenceSemantics {

        @Test
        @DisplayName("序号按毫秒归零：换毫秒后第一个号回到 00")
        void seqResetsEveryMillisecond() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            assertEquals("act_" + tsOf(T0) + "0" + "00", g.id("act_", T0, 0));
            assertEquals("act_" + tsOf(T0) + "0" + "01", g.id("act_", T0, 0));
            // 换毫秒：序号回到 00（这里不能再额外发一个号，否则测的是第二个号）
            assertEquals("act_" + tsOf(T0 + 1) + "0" + "00", g.id("act_", T0 + 1, 0));
        }

        @Test
        @DisplayName("★ 一毫秒发满 100 个后把毫秒推进一格，绝不回绕")
        void rollsMillisForwardInsteadOfWrapping() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            for (int i = 0; i < 99; i++) g.id("", T0, 0);
            // 第 100 个（序号 99）仍在这一毫秒
            assertEquals(tsOf(T0) + "099", g.id("", T0, 0));
            // 第 101 个：毫秒被推进一格，序号回到 00 —— 而不是回到 T0+00
            assertEquals(tsOf(T0 + 1) + "000", g.id("", T0, 0));
        }

        @Test
        @DisplayName("★ 时钟回拨安全：毫秒只增不减")
        void clockRollbackIsSafe() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 10; i++) seen.add(g.id("", T0 + 500, 0));
            // 时钟被拨回：仍在推进后的毫秒上继续发，不会倒退回已发过的号
            for (int i = 0; i < 50; i++) {
                assertTrue(seen.add(g.id("", T0 - 1000, 0)), "时钟回拨导致撞号");
            }
        }
    }

    @Nested
    @DisplayName("③ 格式与配置校验")
    class FormatAndConfig {

        @Test
        @DisplayName("订单号形态：空前缀 + 17 位时间戳 + 1 位实例号 + 2 位序号 = 20 位纯数字")
        void orderIdShape() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            String id = g.id("", T0, 0);
            assertTrue(Pattern.matches("^\\d{20}$", id), "订单号不是 20 位纯数字：" + id);
            assertEquals(tsOf(T0), id.substring(0, 17));
            assertEquals('0', id.charAt(17));
        }

        @Test
        @DisplayName("活动 id 形态：act_ + 17 位时间戳 + 1 位实例号 + 2 位序号 = 24 字符，且能唯一切分")
        void activityIdShape() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            String id = g.id("act_", T0, 3);
            assertTrue(Pattern.matches("^act_\\d{20}$", id), "活动 id 形态不对：" + id);
            assertEquals(24, id.length());
            assertEquals(tsOf(T0), id.substring(4, 21));
            assertEquals('3', id.charAt(21));
        }

        @Test
        @DisplayName("★ 实例号越界抛错，不静默夹紧（夹紧会让 12 号假装成 9 号去撞真 9 号）")
        void outOfRangeInstanceIdThrows() {
            InstanceSeqGenerator g = new InstanceSeqGenerator(2);
            IllegalStateException ex = assertThrows(IllegalStateException.class, () -> g.id("", T0, 12));
            assertTrue(ex.getMessage().contains("app.instance-id"), "错误信息要指名是 app.instance-id："
                    + ex.getMessage());
            assertThrows(IllegalStateException.class, () -> g.id("", T0, -1));
        }

        @Test
        @DisplayName("序号位数非法（<1 或 >4）在构造时就抛错")
        void badSeqDigitsRejected() {
            assertThrows(IllegalArgumentException.class, () -> new InstanceSeqGenerator(0));
            assertThrows(IllegalArgumentException.class, () -> new InstanceSeqGenerator(5));
        }
    }
}
