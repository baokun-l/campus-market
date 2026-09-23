package com.campus.market.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * ---- ⑤ 定时任务配置 ----
 * <p>
 * 开启 Spring 的 {@code @Scheduled} 支持（{@code com.campus.market.job} 包下的任务在此生效）。
 * <p>
 * ★ 为什么单独放一个配置类，而不是加在启动类上 ★
 * <p>
 * 「这个项目有定时任务」应该是一个**能被 grep 到、有名字的开关**。
 * 放在启动类上时，任何人想知道「有没有后台任务在悄悄改数据」都得先想到去看启动类；
 * 而定时任务是本项目里唯一会在**没有人操作**的情况下修改业务数据的机制 ——
 * 它必须一眼可见。单独一个类，类名本身就回答了这个问题。
 * <p>
 * 注意：这里只负责「打开调度器」，任务本身是否注册由
 * {@code app.goods-maintenance.offline-enabled} 控制（见 {@code GoodsOfflineJob}）。
 * 两者分开是因为「调度器开着、但一个任务都没注册」是完全正常的组合 ——
 * 若把开关做在这一层，以后新增第二个任务时就会出现「为了让它跑，被迫打开全部任务」。
 */
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
