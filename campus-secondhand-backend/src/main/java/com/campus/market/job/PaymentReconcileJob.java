package com.campus.market.job;

import com.campus.market.config.RequestTraceFilter;
import com.campus.market.service.PaymentService;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 定时任务：对「已送去收银台、结果未知」的支付单做**主动对账**。
 * <p>
 * ★★ 这个 Bean 存在的理由：回调丢了之后，订单不会自己好 ★★
 * <p>
 * 支付链路里最容易被忽略的一件事是：**异步通知是尽力投递，不是保证送达**。
 * 2026-09-23 真机出现过一次：回调地址经内网穿透验证可达（我方探针 POST 能打进来）、
 * 后端进程正常在等，而支付宝那边交易已经是 {@code TRADE_SUCCESS} ——
 * 但我们一条通知都没收到。用户的钱扣了，订单停在「待付款」。
 * <p>
 * 而它不会一直等下去：{@code PaymentTimeoutJob} 到 {@code pay_expire_at} 会把订单
 * 与支付单一起关掉。两件事叠在一起的后果是**钱在渠道、单已作废**。
 * 所以整条链路缺的不是「再等一会儿」，而是**一个主动去问的出口** ——
 * 也就是这个任务。
 * <p>
 * ★ 为什么必须单独成类，不写在 {@code PaymentService} 里 ★
 * <p>
 * 与 {@link PaymentTimeoutJob}、{@link GoodsOfflineJob} 同一个理由：
 * {@code PaymentService#reconcileOne} 带 {@code @Transactional}，而 Spring 的事务
 * 靠**代理对象**织入。若把 {@code @Scheduled} 和它写在同一个类里，调度器拿到的是
 * 原始对象、直接调 {@code this}，事务**静默失效**且不报任何错 ——
 * 「改支付单 + 推进订单」就会变成两步各自提交，中间失败会留下一半状态。
 * 单测看不出来（单测本来就是 new 出来的裸对象），只有真机才暴露。
 * <p>
 * ★ 两条与超时关单任务**刻意不同**的取舍 ★
 * <ol>
 *   <li><b>逐笔独立事务，而不是整批一个事务</b>：一笔的数据异常不该把整批回滚。
 *       定时任务没有重试机制，整批回滚的后果是「每一轮都失败在同一笔上，
 *       后面的永远处理不到」；</li>
 *   <li><b>异常一律在这里吃掉并记 error</b>：{@code @Scheduled} 抛出的异常没人接，
 *       Spring 只会打一条日志然后照常等下一次触发 —— 表面「任务在跑」，
 *       实际每轮都失败、无人知晓。所以每笔各自 try/catch，绝不中断整批。</li>
 * </ol>
 * <p>
 * ★ 与关单任务的分工边界（很重要，不要越过）★
 * <p>
 * 未过期的支付单归本任务对账；**已过期的归 {@code PaymentTimeoutJob} 关单**，
 * 本任务不去碰（候选查询里带了 {@code expire_at > now}）。
 * 两个任务同时处理同一笔会在「关单」与「入账」之间形成难复现的竞态，
 * 而这类竞态的代价是钱 —— 边界清晰比「多救一笔」更重要。
 * 「关单之后才到的付款」由 {@code PaymentService#settle} 的自动原路退回兜住。
 */
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.pay.reconcile-enabled",
        havingValue = "true", matchIfMissing = true)
public class PaymentReconcileJob {

    private static final Logger log = LoggerFactory.getLogger(PaymentReconcileJob.class);

    private final PaymentService paymentService;

    /**
     * 默认每 2 分钟跑一次。
     * <p>
     * ★ 为什么比关单任务（5 分钟）更勤 ★
     * 关单晚几分钟只是库存多占一会儿；而**对账晚几分钟意味着用户已经付了钱、
     * 订单却还没变成「待发货」** —— 用户会刷新、会以为付款失败、会再付一次。
     * 钱的时效性比库存的时效性高一个量级，所以频率也该高一个量级。
     * <p>
     * 配合默认 2 分钟的宽限期（见 {@code app.pay.reconcile-grace-minutes}），
     * 一笔真实支付最坏在约 4 分钟内被兜住，而这期间不会有任何多余的查单请求。
     */
    @Scheduled(cron = "${app.pay.reconcile-cron:0 */2 * * * ?}")
    public void reconcileStuckPayments() {
        /*
         * 与 GoodsOfflineJob 同一条纪律：定时任务跑在调度线程池里，没有请求上下文，
         * 日志会长成 `[no-trace] [uid=anon] [? ?]`，混在成百上千行请求日志里捞不出来。
         * 这里给一个自解释的 id：一次执行的所有日志行天然成组，
         * 排障时 `grep job-pay-reconcile-` 一条命令就能捞出历次执行。
         * 时间戳不是装饰：同一任务的两次执行必须能区分开。
         */
        String traceId = "job-pay-reconcile-" + System.currentTimeMillis();
        MDC.put(RequestTraceFilter.MDC_TRACE_ID, traceId);
        try {
            List<String> candidates = paymentService.findReconcileCandidates();
            if (candidates.isEmpty()) {
                /*
                 * ★ 什么都不做时也要留一行 ★
                 * 「任务根本没被触发」与「触发了、但确实没有待对账的支付单」
                 * 在日志里长得一模一样（都是什么都没有），而这恰恰是排障时要分清的第一件事：
                 * 前者是调度/开关/进程问题，后者是业务上真的没事。
                 * 多这一行，换来的是一个可用的心跳（同时它也是 traceId 的落点）。
                 */
                log.info("[pay-reconcile] finished, nothing to reconcile");
                return;
            }

            int settled = 0;
            int mismatch = 0;
            int unavailable = 0;
            for (String paymentId : candidates) {
                try {
                    PaymentService.ReconcileOutcome outcome = paymentService.reconcileOne(paymentId);
                    switch (outcome) {
                        case SETTLED -> settled++;
                        case AMOUNT_MISMATCH -> mismatch++;
                        case UNAVAILABLE -> unavailable++;
                        default -> {
                            // SKIPPED / NOT_PAID：正常的「还在等用户付钱」，不需要噪音
                        }
                    }
                } catch (Exception e) {
                    // 单笔失败不能拖垮整批：记下来，继续下一笔
                    log.error("[pay-reconcile] reconcile FAILED. paymentId={}", paymentId, e);
                }
            }

            /*
             * 收口日志。把 mismatch 单独拎出来计数是有意的 ——
             * 「渠道说付款了、金额却对不上」是唯一需要**人**去看的形态，
             * 它必须在一眼扫过日志时就能被发现，而不是埋在几十行 INFO 里。
             */
            log.info("[pay-reconcile] finished. checked={} settled={} mismatch={} unavailable={}",
                    candidates.size(), settled, mismatch, unavailable);
        } catch (Exception e) {
            log.error("[pay-reconcile] scheduled task failed", e);
        } finally {
            MDC.clear();
        }
    }
}
