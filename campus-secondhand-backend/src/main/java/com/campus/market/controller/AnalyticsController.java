package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.dto.NameValue;
import com.campus.market.dto.TrendPoint;
import com.campus.market.entity.Goods;
import com.campus.market.service.AnalyticsService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 数据可视化统计控制器（登录用户可读）
 * <p>
 * 路由与前端 `src/api/analytics.ts` 逐条对齐：
 * <ul>
 *   <li>{@code GET /analytics/trend?days=7}                  趋势折线</li>
 *   <li>{@code GET /analytics/category-distribution}         分类占比饼图</li>
 *   <li>{@code GET /analytics/top-goods?limit=5}             热门商品榜（按浏览量）</li>
 * </ul>
 * 这三条路径此前只在白名单里被当作公开接口放行，后端却不存在对应映射 —— 悬空配置，现补齐实现。
 * <p>
 * ★ 它们现在**需要登录** ★：{@code /analytics/**} 已从 {@code AuthInterceptor} 的
 * PUBLIC_GET 白名单移出 —— 前端大屏与首页两条路由的 meta 都是 {@code requireAuth: true}，
 * 没有任何游客页面读这些数据，留在白名单等于把经营数据暴露给未登录访客。
 * 未登录访问会得到业务码 401，与前端「登录状态已过期」的全局处理对齐。
 */
@RestController
@RequiredArgsConstructor
public class AnalyticsController {

    private final AnalyticsService analyticsService;

    /** 近 N 天 PV / UV / 订单趋势 */
    @GetMapping("/analytics/trend")
    public Result<List<TrendPoint>> fetchTrend(@RequestParam(defaultValue = "7") int days) {
        return Result.success(analyticsService.fetchTrend(days));
    }

    /** 分类占比 */
    @GetMapping("/analytics/category-distribution")
    public Result<List<NameValue>> fetchCategoryDistribution() {
        return Result.success(analyticsService.fetchCategoryDistribution());
    }

    /** 热门商品（按浏览量倒序） */
    @GetMapping("/analytics/top-goods")
    public Result<List<Goods>> fetchTopGoods(@RequestParam(defaultValue = "5") int limit) {
        return Result.success(analyticsService.fetchTopGoods(limit));
    }

    /**
     * 平台概览（首页顶部 Banner 的「商品数 / 用户数 / 订单数」）。
     * <p>
     * ★ 为什么单独开这个口子：{@code /admin/dashboard/summary} 是管理后台接口，
     * 普通用户调用会被角色分区拦下（403），而首页 Banner 对**所有登录用户**展示，
     * 于是普通用户一进首页就弹「您没有该操作权限」（实测踩坑）。
     * 聚合总数不属于敏感经营数据，登录用户可见即可；admin 大屏仍走原接口。
     */
    @GetMapping("/analytics/summary")
    public Result<Map<String, Object>> platformSummary() {
        return Result.success(analyticsService.fetchDashboardSummary());
    }
}