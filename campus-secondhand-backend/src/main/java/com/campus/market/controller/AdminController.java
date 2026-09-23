package com.campus.market.controller;

import com.campus.market.common.PageResult;
import com.campus.market.common.Result;
import com.campus.market.dto.HotGoodsRow;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.Settings;
import com.campus.market.service.AnalyticsService;
import com.campus.market.service.GoodsMaintenanceService;
import com.campus.market.interceptor.AuthInterceptor;
import com.baomidou.mybatisplus.core.metadata.IPage;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 统计分析 + 系统设置 + 操作日志控制器
 */
@RestController
@RequiredArgsConstructor
public class AdminController {

    private final AnalyticsService analyticsService;
    /** 商品维护（自动下架超期商品）—— 定时任务与手工触发共用同一个业务方法 */
    private final GoodsMaintenanceService goodsMaintenanceService;

    // ==================== 统计分析 ====================

    @GetMapping("/admin/dashboard/summary")
    public Result<Map<String, Object>> dashboardSummary() {
        return Result.success(analyticsService.fetchDashboardSummary());
    }

    @GetMapping("/admin/overview")
    public Result<Map<String, Object>> overview() {
        return Result.success(analyticsService.fetchAdminOverview());
    }

    /**
     * 热销商品榜（按成交单数）
     * <p>
     * 与大屏的 `/analytics/top-goods`（按浏览量）是两个口径：
     * 浏览量高只说明有人围观，成交才算真实带货能力。
     */
    @GetMapping("/admin/analytics/hot-goods")
    public Result<java.util.List<HotGoodsRow>> hotGoods(@RequestParam(defaultValue = "8") int limit) {
        return Result.success(analyticsService.fetchHotGoods(limit));
    }

    // ==================== 操作日志 ====================

    /**
     * 操作日志分页查询（新的在前）
     * <p>
     * 前端 `api/audit.ts` 声明返回 `PageResult<AuditLog>` 并传 page / pageSize，
     * 因此这里必须分页返回 —— 直接给数组会让表格的 list/total 全部落空。
     */
    @GetMapping("/admin/audit-logs")
    public Result<PageResult<AuditLog>> fetchAuditLogs(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String keyword) {
        IPage<AuditLog> p = analyticsService.fetchAuditLogs(page, pageSize, type, keyword);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /**
     * 操作日志导出：与列表共用分类 / 关键字筛选，导出「当前筛选的全部」。
     */
    @GetMapping("/admin/audit-logs/export")
    public Result<List<AuditLog>> exportAuditLogs(
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String keyword) {
        return Result.success(analyticsService.fetchAuditLogsForExport(type, keyword));
    }

    /** 各类动作条数（页签上的小计数） */
    @GetMapping("/admin/audit-logs/stats")
    public Result<Map<String, Integer>> fetchAuditStats() {
        return Result.success(analyticsService.fetchAuditStats());
    }

    /**
     * 清空全部操作日志
     * <p>
     * ★ 必须带 {@code confirm=CLEAR} ★
     * 这是本系统唯一一个「无条件全表删除」的接口，服务端不接受「沉默的清空」：
     * 缺确认口令直接拒绝，一条都不删。详见 {@link AnalyticsService#clearAuditLogs}。
     * 操作人从登录态里取，不由客户端传入（否则可以把痕迹记到别人头上）。
     */
    @DeleteMapping("/admin/audit-logs")
    public Result<Void> clearAuditLogs(HttpServletRequest request,
                                       @RequestParam(required = false) String confirm) {
        analyticsService.clearAuditLogs(confirm, (String) request.getAttribute(AuthInterceptor.ATTR_USERNAME));
        return Result.success();
    }

    // ==================== 系统设置 ====================

    @GetMapping("/admin/settings")
    public Result<Settings> fetchSettings() {
        return Result.success(analyticsService.fetchSettings());
    }

    @PatchMapping("/admin/settings")
    public Result<Settings> saveSettings(@RequestBody Settings patch) {
        return Result.success(analyticsService.saveSettings(patch));
    }

    @PostMapping("/admin/settings/reset")
    public Result<Settings> resetSettings() {
        return Result.success(analyticsService.resetSettings());
    }

    // ==================== 商品维护：自动下架 ====================

    /**
     * 预览：按当前 {@code auto_offline_days} 配置，现在有多少件在售商品会被自动下架。
     * <p>
     * 只读，不改任何数据。用途是让管理员在「改完配置」与「真按下去」之间有个检查点 ——
     * 批量改状态没有撤销键，先看清楚会不会误伤是必要的。
     */
    @GetMapping("/admin/goods/auto-offline")
    public Result<Map<String, Object>> previewAutoOffline() {
        return Result.success(autoOfflinePayload(goodsMaintenanceService.countStaleGoods()));
    }

    /**
     * 立即执行一次自动下架（等价于定时任务的那一次运行）。
     * <p>
     * ★ 为什么要有这个手工入口 ★
     * 定时任务按天在凌晨跑，管理员改完 `auto_offline_days` 后无法当场确认配置是否真的生效 ——
     * 只能「等一晚上看结果」。这条通道让「改配置 → 预览 → 执行 → 看结果」在一次会话里闭环，
     * 也正是它把原先那条死配置变成**可被验证**的配置。
     * <p>
     * 权限：本控制器挂在 {@code /admin/**} 下，按 {@code AuthInterceptor} 的规则**仅 admin 可访问**
     * （goods_admin / report_admin 都不行）。这条动作会批量改商品状态，不应下放给审核员。
     */
    @PostMapping("/admin/goods/auto-offline")
    public Result<Map<String, Object>> runAutoOffline() {
        int offlined = goodsMaintenanceService.offlineStaleGoods();
        return Result.success(autoOfflinePayload(offlined));
    }

    /**
     * 两个入口的响应体保持一致（同名字段含义随动作变化：预览时是「将下架数」，执行时是「已下架数」）。
     * <p>
     * {@code days=0} 表示该功能当前被配置关闭（0/NULL = 不自动下架），
     * 此时两个接口都会返回 0 —— 管理员据此能直接区分「配置没生效」和「没有超期商品」。
     */
    private Map<String, Object> autoOfflinePayload(int count) {
        Map<String, Object> data = new java.util.LinkedHashMap<>();
        data.put("days", analyticsService.autoOfflineDays());
        data.put("count", count);
        return data;
    }
}
