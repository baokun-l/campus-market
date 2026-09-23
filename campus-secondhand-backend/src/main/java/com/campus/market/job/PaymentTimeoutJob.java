package com.campus.market.job;

import com.campus.market.service.PaymentService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 定时任务：关掉超时未付款的订单与支付单。
 * <p>
 * ★★ 这个 Bean 存在的意义，是把「24 小时未付款自动关单」从一句口号变成真的会发生的事 ★★
 * <p>
 * 改造前的状况：前端常量 {@code ORDER_SLA_HOURS.pending_payment = 24} 用来把超时订单标红，
 * 后端 SQL 里也有 {@code slaBreach} 的筛选片段 —— 但**全仓没有一个定时任务真的关单**。
 * 后果是买家拍下不付款，库存被永久占住：
 * <ul>
 *   <li>卖家卖不了（库存被占）；</li>
 *   <li>买家自己解除不了（{@code cancelByBuyer} 只有买家能调，而他就是不点）；</li>
 *   <li>管理员在后台看到的只是一条普通的「待付款」，不会有人想到去手动关。</li>
 * </ul>
 * 商品就这样从货架上消失了，而且没有任何报错。
 * <p>
 * ★ 为什么必须单独成类，不直接写在 {@link PaymentService} 里 ★
 * <p>
 * 与 {@link GoodsOfflineJob} 同一个理由：{@code PaymentService#closeExpired} 里的
 * 逐笔关单由 {@code OrderService} 的 {@code @Transactional} 代理织入，
 * 如果把 {@code @Scheduled} 和事务方法写在同一个类里，调度器拿到的是原始对象，
 * 事务**静默失效**。拆成两个 Bean 之后，调度器持有的是被代理过的 Service。
 * <p>
 * ★ 关单顺序：先关支付单，再关订单（顺序不能反）★
 * <p>
 * 支付单是「这笔钱还可能进来」的标志。若先关订单、再关支付单，
 * 中间那几毫秒里用户在支付宝付了款，回调打进来会看到订单已关 ——
 * 触发自动退回。虽然不会出错，但用户会经历「付了款又被退」。
 * 先关支付单，用户即便立刻付款，回调也找不到活跃支付单，这笔钱不会进来。
 */
@Slf4j
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.pay.timeout-enabled", havingValue = "true", matchIfMissing = true)
public class PaymentTimeoutJob {

    private final PaymentService paymentService;

    /**
     * 默认每 5 分钟跑一次。
     * <p>
     * 关单的时效性以分钟计就够 —— 用户不会盯着倒计时最后一秒付款，
     * 但也不能跑成每小时：那意味着一个「已超时 59 分钟」的订单还要占一小时库存。
     */
    @Scheduled(cron = "${app.pay.close-cron:0 */5 * * * ?}")
    public void closeExpiredOrders() {
        try {
            int rows = paymentService.closeExpired();
            if (rows > 0) {
                log.info("[pay-timeout] closed {} expired orders", rows);
            }
        } catch (Exception e) {
            /*
             * ★ 必须在这里吃掉异常 ★
             * 定时任务抛出的异常没人接：Spring 打一条日志，然后**照常**等下一次触发。
             * 表面上「任务在跑」，实际每 5 分钟失败一次、无人知晓 ——
             * 配置错误或数据库抖动会以这种最安静的方式长期存在。
             * 这里显式记 error，留下一个可配告警的稳定锚点（ASCII，避开 GBK 管道乱码）。
             */
            log.error("[pay-timeout] scheduled task failed", e);
        }
    }
}
