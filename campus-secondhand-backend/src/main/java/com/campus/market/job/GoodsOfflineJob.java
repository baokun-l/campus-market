package com.campus.market.job;

import com.campus.market.config.RequestTraceFilter;
import com.campus.market.service.GoodsMaintenanceService;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 定时维护任务：把「在售且发布超过 {@code t_settings.auto_offline_days} 天」的商品自动下架。
 * <p>
 * ★★ 为什么这个类必须和 {@link GoodsMaintenanceService} 分成两个 Bean ★★
 * <p>
 * 业务方法带 {@code @Transactional}，而 Spring 的事务是靠 **代理对象** 织入的。
 * 如果把 {@code @Scheduled} 和 {@code @Transactional} 写在同一个类里，
 * 调度器调用的是**原始对象**上的方法，方法内部再调自己的另一个方法时走的是 {@code this} ——
 * 绕过了代理，事务**不会被开启**，而且**不会报任何错、日志里也看不出来**。
 * 于是「一次下架要么全成要么全败」变成「改到一半失败就留下一半已下架的商品」。
 * <p>
 * 拆成两个 Bean 之后，调度器持有的是被代理过的 {@code GoodsMaintenanceService}，
 * {@code @Transactional} 正常生效。这个坑单测看不出来（单测本来就是 new 出来的裸对象），
 * 只有真机跑才暴露 —— 所以它写成注释留在这里，而不是靠「记得别这么写」。
 * <p>
 * ★ 为什么整个类可以被关掉 ★
 * {@code app.goods-maintenance.offline-enabled=false} 时这个 Bean 根本不创建，
 * 连 {@code @Scheduled} 都不会注册。演示/排障时想彻底停掉定时下架，改配置即可，不必改代码，
 * 也不必在演示前担心「凌晨那条任务有没有把演示数据动过」。
 */
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.goods-maintenance.offline-enabled",
        havingValue = "true", matchIfMissing = true)
public class GoodsOfflineJob {

    private static final Logger log = LoggerFactory.getLogger(GoodsOfflineJob.class);

    private final GoodsMaintenanceService goodsMaintenanceService;

    /**
     * cron 默认 {@code 0 30 3 * * ?}（每天 03:30）。选凌晨而不是每小时，理由有两条：
     * 一是这条动作是「清理陈货」，时效性以天为单位，跑得勤没有额外收益；
     * 二是避开演示与使用高峰 —— 批量改状态期间相关行会被锁住，白天跑容易撞上下单/改价。
     */
    @Scheduled(cron = "${app.goods-maintenance.offline-cron:0 30 3 * * ?}")
    public void offlineStaleGoods() {
        /*
         * ★ P1-6：定时任务的日志也要能被检索 ★
         *
         * traceId 是**线程本地**的，由 RequestTraceFilter 在请求线程上设置；
         * 定时任务跑在调度线程池里，**没有请求上下文** —— 于是它的日志在文件里
         * 会长成 `[no-trace] [uid=anon] [? ?]`，混在成百上千行请求日志里很难被捞出来。
         *
         * 这里给一个**自解释**的 id：job-goods-offline-<毫秒时间戳>。
         * 好处有两点：① 一次执行的所有日志行（含 GoodsMaintenanceService 里打的）天然成组；
         *            ② 排障时 `grep job-goods-offline-` 一条命令就能捞出历次执行。
         * 时间戳不是装饰：同一任务的两次执行必须能区分开，否则"昨天失败了没有"就查不出来。
         *
         * 用 try/finally 清掉 —— 调度线程同样是被**复用**的，
         * 不清就会把上一次的 id 带到下一次执行上（与请求线程同一条纪律）。
         */
        String traceId = "job-goods-offline-" + System.currentTimeMillis();
        MDC.put(RequestTraceFilter.MDC_TRACE_ID, traceId);
        try {
            int rows = goodsMaintenanceService.offlineStaleGoods();
            /*
             * ★ 无论有没有东西可下架，都留一行（2026-09-22，P1-6 轮补）★
             *
             * 原先只在 rows > 0 时打日志，后果是：「任务根本没被触发」与
             * 「触发了、但今天确实没有陈货」在日志里长得**一模一样**（都是什么都没有）——
             * 而这恰恰是排障时要分清的第一件事（没触发 = 调度/开关/进程问题；
             * 触发了 = 业务上确实没事）。多这一行，换来的是一个任务心跳。
             *
             * ★ 它同时是 traceId 的落点 ★：MDC 设了却从没进过任何日志行，等于白设。
             * 本类注释承诺了「grep job-goods-offline- 一条命令捞出历次执行」——
             * 注释承诺了就必须有可观测出口，否则那只是一条约定，不是能力。
             *
             * 级别用 INFO 而不是 DEBUG：生产日志级别就是 INFO，DEBUG 等于没加。
             */
            log.info("[goods-auto-offline] finished, offlined {} stale goods", rows);
        } catch (Exception e) {
            /*
             * ★ 必须在这里把异常吃掉 ★
             * 定时任务抛出的异常不会有人接：Spring 只会打一条日志，然后**照常**等下一次触发。
             * 表面上「任务在跑」，实际上每天失败一次、无人知晓 —— 配置错误（比如数据库临时不可用、
             * 列被改名）会以这种最安静的方式长期存在。
             * 这里显式记 error，让它在日志里有一个稳定的、可以配告警的锚点字符串
             * （[goods-auto-offline] 是 ASCII，避开 Windows 下 GBK 管道的乱码问题）。
             */
            log.error("[goods-auto-offline] scheduled task failed", e);
        } finally {
            MDC.clear();
        }
    }
}
