package com.campus.market.service;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.campus.market.common.OperatorContext;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.Goods;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

/**
 * 商品维护业务 —— 目前只有一件事：把「挂了太久没人要」的在售商品自动下架。
 * <p>
 * ★ 为什么需要这个类 ★
 * <p>
 * {@code t_settings.auto_offline_days} 原本是一条**死配置**：后台能填、能存、能读出来显示，
 * 但全仓没有任何 {@code @Scheduled}（已 grep 确认为 0 命中），因此无论填 3 天还是 365 天，
 * 都不会有任何商品被下架。这类「配置项看起来生效、实际上无人消费」的字段比缺功能更糟 ——
 * 它会让管理员相信自己已经控制住了局面。
 * <p>
 * ★ 与 {@link AnalyticsService#autoOfflineDays()} 的分工 ★
 * 取值口径（含 0 / NULL = 不自动下架）由 AnalyticsService 统一负责，本类只消费结果，
 * 不再自行解释配置。这样「配置怎么读」只有一个地方需要理解。
 */
@Service
@RequiredArgsConstructor
public class GoodsMaintenanceService {

    private final AnalyticsService analyticsService;
    private final GoodsMapper goodsMapper;
    private final AuditLogMapper auditLogMapper;

    /**
     * 按当前配置把超期在售商品批量下架。
     *
     * @return 实际下架的件数；0 表示「功能被配置关闭（0/NULL）」或「没有超期商品」
     */
    @Transactional
    public int offlineStaleGoods() {
        int days = analyticsService.autoOfflineDays();
        if (days <= 0) {
            // 0 / NULL = 关闭自动下架。配置缺失时放宽，绝不收紧（理由见 AnalyticsService#autoOfflineDays）
            return 0;
        }
        return offlineCreatedBefore(LocalDateTime.now().minusDays(days), days);
    }

    /**
     * 预览：按当前配置**当前有多少件**在售商品会被下架，供管理员「先看清楚再按下去」。
     * <p>
     * ★ 为什么执行入口要配一个只读的预览入口 ★
     * 这是一条**批量改状态**的动作，点下去没有撤销键。管理员改完配置想验证时，
     * 若只能「直接执行」，他就必须拿真实数据去试 —— 配置填错（比如本意 30 天填成了 3 天）
     * 的代价由卖家承担。加一个零副作用的计数接口，「改配置 → 看预览 → 再执行」才成立。
     * <p>
     * 不返回具体商品 id：预览只需要回答「会不会误伤」，返回 id 列表反而会被当成待办清单去逐个核对。
     */
    public int countStaleGoods() {
        int days = analyticsService.autoOfflineDays();
        if (days <= 0) {
            return 0;
        }
        return Math.toIntExact(goodsMapper.selectCount(
                new LambdaUpdateWrapper<Goods>()
                        .eq(Goods::getStatus, "on_sale")
                        .lt(Goods::getCreateTime, LocalDateTime.now().minusDays(days))));
    }

    /**
     * 真正执行下架。
     *
     * @param deadline 发布时间早于该时刻的在售商品会被下架
     * @param days    配置里的天数，只用于审计文案（让日志能复述「当时按几天算的」）
     */
    private int offlineCreatedBefore(LocalDateTime deadline, int days) {
        LocalDateTime now = LocalDateTime.now();

        /*
         * ★★ 为什么必须是 update(null, LambdaUpdateWrapper) 而不是「查出来改字段再 updateById」★★
         *
         * t_goods 的 stock / view_count / favorite_count 三列**别处也在写**
         * （下单扣库存、浏览 +1、收藏增减）。如果这里先把整行 selectById 读出来、
         * 只改 status 再整行写回，就会把「读」与「写」之间别人改过的这三列**盖回旧值** ——
         * 一次下单的扣减、一次点赞的计数，在毫无报错的情况下被抹掉。
         * 这正是本项目已经收口过的「快照回写」缺陷族，t_goods 属于其中的高危表。
         *
         * 单列 UPDATE 只在 SET 里出现 status 一列，不携带任何读出来的旧值，天然免疫丢更新。
         * 顺带两点：
         *   - update_time 不在这里写：列上已有 ON UPDATE CURRENT_TIMESTAMP，由 MySQL 自己维护；
         *   - 不加 LIMIT：一条 UPDATE 是原子的，且这条动作**可逆**（管理员能重新上架），
         *     真正的护栏是「配置 + 预览 + 审计留痕」，不是把批量切成小批（切了反而会出现
         *     「500 件之后悄悄不处理了」这种更难查的半成品状态）。
         */
        LambdaUpdateWrapper<Goods> condition = new LambdaUpdateWrapper<Goods>()
                .set(Goods::getStatus, "off_shelf")   // 写成什么
                .eq(Goods::getStatus, "on_sale")      // 只碰在售（sold / pending / 已下架的都不动）
                .lt(Goods::getCreateTime, deadline);  // 且发布时间够早
        int rows = goodsMapper.update(null, condition);

        if (rows > 0) {
            /*
             * 只在下架了东西时留痕。定时任务每天都会跑，若为空也写一条，
             * 操作日志会被 365 条「自动下架 0 件」淹没，真正有事的那天反而翻不到。
             *
             * 操作人走 OperatorContext：后台手工触发时取到登录管理员的名字，
             * 定时任务没有请求上下文则返回 "system" —— 这正是该类当初预留的场景。
             */
            AuditLog trace = new AuditLog();
            trace.setAction("goods.auto_offline");
            trace.setActionLabel("自动下架超期商品");
            trace.setTarget(rows + " 件在售商品");
            trace.setDetail("发布超过 " + days + " 天（早于 " + deadline + "）的在售商品已自动下架");
            trace.setOperator(OperatorContext.currentOperator());
            trace.setCreateTime(now);
            auditLogMapper.insert(trace);
        }
        return rows;
    }
}
