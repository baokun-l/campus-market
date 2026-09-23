package com.campus.market.common;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * 「毫秒 ＋ 实例号 ＋ 毫秒内序号」发号器 —— 本项目**所有**业务字符串 id 的**唯一**发号实现。
 * <p>
 * ★★ 为什么要有这个类（而不是每个 Service 各写一份）★★
 * <p>
 * 本类是为一次真实的漏修而抽取的。L5 把订单号（{@code OrderService}）的发号器重写成了
 * 「按毫秒归零 ＋ 实例号 ＋ 毫秒内序号」，但同族的 {@code ActivityService.ID_SEQ}
 * ——一个 {@code static AtomicLong} 进程内自增、多实例各从 0 起——**当时没被扫到**。
 * 两条 id 都落在字符串业务主键上（{@code t_order.id} / {@code t_activity.id}），
 * 撞号就是主键冲突、用户看到一个没有任何线索的 500。
 * <p>
 * 所以这里把**状态机本身**收成一份：
 * <ul>
 *   <li>以后任何「再加一个业务 id」的需求，都该调 {@link #id(String, long, int)}，
 *       而不是在自己类里 {@code new AtomicLong()}；</li>
 *   <li>「改一处必查另一处」从**靠纪律**变成**靠结构**：发号逻辑只有一处，
 *       就算忘了扫同族，也写不出第二份错误实现。</li>
 * </ul>
 * <p>
 * ★ 三条口径（与 L5 一致，别各改各的）★
 * <ol>
 *   <li><b>序号按毫秒归零</b>：它表达的是「这一毫秒里的第几个」，
 *       不是从进程启动到退出的全局流水号；</li>
 *   <li><b>一毫秒发满就把毫秒推进一格，绝不回绕</b>：回绕 = 复用已发过的号 = 撞号。
 *       代价是发出的时间戳可能略微跑在挂钟前面（标准雪花算法的取舍），
 *       换来的是「绝不重复」——业务 id 的用途本来就只是「唯一 + 大致有序」；</li>
 *   <li><b>{@code lastMillis} 只增不减</b> ⇒ 顺带免疫 NTP 时钟回拨。</li>
 * </ol>
 * <p>
 * 实例号越界（{@code <0} 或 {@code >9}）时**抛错而不是静默夹紧**：
 * 夹紧会把 12 号实例悄悄当成 9 号，去和真的 9 号撞号。配置错误必须响亮地失败。
 * <p>
 * 本类**无状态依赖 Spring**，可以在单测里直接 {@code new} —— 这是刻意的：
 * 调用方都是 Lombok {@code @RequiredArgsConstructor} 的 Service，
 * 把它们变成需要注入的组件会改掉生成的构造器签名，全仓单测都要跟着补参。
 */
public final class InstanceSeqGenerator {

    /** 一次发号的结果：毫秒、实例号、该毫秒内的序号（三元组严格不重复） */
    public record Seat(long millis, int instanceId, int seqInMs) {
    }

    /**
     * 时间戳段格式。与历史订单号同为 17 位 {@code yyyyMMddHHmmssSSS} ——
     * 不要改位数：改了就是另一套格式，历史数据与新数据不再同形。
     */
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");

    /** 实例号允许的取值个数（0..9） */
    private static final int INSTANCE_SLOTS = 10;

    private final int seqDigits;
    private final int maxSeqInMs;

    /** 见类注释：这两个字段是**联合不变量**，必须一起改，所以要用锁而不是单个原子变量 */
    private final Object lock = new Object();
    private long lastMillis = -1L;
    private int seqInMs = 0;

    /**
     * @param seqDigits 毫秒内序号的位数：2 → {@code 00..99}（每毫秒 100 个号）
     */
    public InstanceSeqGenerator(int seqDigits) {
        if (seqDigits < 1 || seqDigits > 4) {
            throw new IllegalArgumentException("seqDigits 必须在 1..4 之间，当前 = " + seqDigits);
        }
        this.seqDigits = seqDigits;
        this.maxSeqInMs = (int) Math.pow(10, seqDigits) - 1;
    }

    /**
     * 发一个号。
     *
     * @param nowMillis  当前毫秒（单测可以传固定值，把「同一毫秒内连发」变成确定性场景）
     * @param instanceId 实例号，取值 {@code 0..9}
     * @throws IllegalStateException 实例号越界
     */
    public Seat next(long nowMillis, int instanceId) {
        checkInstanceId(instanceId);
        long millis;
        int seq;
        synchronized (lock) {
            if (nowMillis > lastMillis) {
                // 新的一毫秒：序号从头开始
                lastMillis = nowMillis;
                seqInMs = 0;
            } else if (seqInMs >= maxSeqInMs) {
                // 这一毫秒发满了：把毫秒推一格，序号重来 —— 绝不回绕到已发过的号上
                lastMillis++;
                seqInMs = 0;
            } else {
                seqInMs++;
            }
            millis = lastMillis;
            seq = seqInMs;
        }
        return new Seat(millis, instanceId, seq);
    }

    /**
     * 发号并格式化成 id：{@code prefix + 17 位时间戳 + 实例号 + N 位序号}。
     * <p>
     * 例：{@code new InstanceSeqGenerator(2).id("act_", t, 0)} → {@code act_20260922175530000}（24 字符）；
     * 订单号用 {@code id("", t, 0)} → 20 字符。
     */
    public String id(String prefix, long nowMillis, int instanceId) {
        Seat s = next(nowMillis, instanceId);
        String p = prefix == null ? "" : prefix;
        return p + timestamp(s.millis()) + s.instanceId() + pad(s.seqInMs());
    }

    /** 毫秒 → {@code yyyyMMddHHmmssSSS}（17 位，系统默认时区） */
    public static String timestamp(long millis) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneId.systemDefault()).format(TS);
    }

    /**
     * 实例号校验：越界抛错，**不静默夹紧**。
     * 夹紧会把 12 号实例悄悄当成 9 号，去和真的 9 号撞号 —— 配置错误必须响亮地失败。
     */
    public static void checkInstanceId(int instanceId) {
        if (instanceId < 0 || instanceId >= INSTANCE_SLOTS) {
            throw new IllegalStateException("app.instance-id 必须在 0..9 之间，当前 = " + instanceId
                    + "（多实例部署时每个实例配一个不同值；单实例保持默认 0）");
        }
    }

    private String pad(int seq) {
        return String.format("%0" + seqDigits + "d", seq);
    }
}
