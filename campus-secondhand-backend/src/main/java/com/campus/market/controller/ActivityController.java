package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.dto.ActivityDisplay;
import com.campus.market.entity.Activity;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.ActivityService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 限时活动控制器
 * <p>
 * 路由总览（读接口需登录、写接口仅全能管理员，见 {@code AuthInterceptor}）：
 * <ul>
 *   <li>{@code GET    /activities}                    全部活动（含下架/到期）—— 管理后台列表</li>
 *   <li>{@code GET    /activities/active}             前台可展示（active / pending）—— 首页 Banner 轮播</li>
 *   <li>{@code GET    /activities/current}            主推活动 —— 首页主 Banner</li>
 *   <li>{@code POST   /admin/activities}              新建</li>
 *   <li>{@code PATCH  /admin/activities/{id}}         编辑（局部更新）</li>
 *   <li>{@code POST   /admin/activities/{id}/enabled} 上架 / 下架</li>
 *   <li>{@code DELETE /admin/activities/{id}}         删除</li>
 *   <li>{@code POST   /admin/activities/close}        提前结束主推活动（兼容旧入口）</li>
 *   <li>{@code POST   /admin/activities/restart}      重新开启主推活动（重置倒计时）</li>
 *   <li>{@code POST   /admin/activities/reset}        恢复出厂活动</li>
 * </ul>
 * <p>
 * ★ 状态与倒计时由服务端计算 ★ —— 客户端时钟可以被改，
 * 让前端自己判断「活动是否已开始」，把系统时间往前拨一天就能让未开始的活动提前卖货。
 * <p>
 * ★ 这是本轮新补齐的模块 ★：此前活动只活在前端 localStorage 里，
 * 后端没有任何活动接口，`/admin/overview` 的 {@code activeActivities} 只能是硬编码 0。
 */
@RestController
@RequiredArgsConstructor
public class ActivityController {

    private final ActivityService activityService;

    // ==================== 读 ====================

    /** 全部活动（含已下架 / 已到期），按优先级降序 */
    @GetMapping("/activities")
    public Result<List<ActivityDisplay>> fetchActivities() {
        return Result.success(activityService.listAll());
    }

    /** 前台可展示的活动（active / pending），按优先级降序 —— 首页 Banner 轮播用 */
    @GetMapping("/activities/active")
    public Result<List<ActivityDisplay>> fetchActiveActivities() {
        return Result.success(activityService.listActive());
    }

    /** 主推活动（进行中优先，其次待开始，都没有则回落列表首位） */
    @GetMapping("/activities/current")
    public Result<ActivityDisplay> fetchCurrentActivity() {
        return Result.success(activityService.current());
    }

    // ==================== 写（仅 admin）====================

    /** 新建活动（未传 startAt 视为从此刻开始） */
    @PostMapping("/admin/activities")
    public Result<Activity> createActivity(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        return Result.success(activityService.create(body, operator(request)));
    }

    /** 编辑活动（局部更新，未传的字段保持原值） */
    @PatchMapping("/admin/activities/{id}")
    public Result<Activity> updateActivity(HttpServletRequest request,
                                           @PathVariable String id,
                                           @RequestBody Map<String, Object> body) {
        return Result.success(activityService.update(id, body, operator(request)));
    }

    /**
     * 上架 / 下架活动。
     * <p>
     * 入参 {@code {enabled: boolean}}；下架即 cancelled，前台立即消失，记录保留，
     * 因此「下架」是可逆的，不需要真的删除数据。
     */
    @PostMapping("/admin/activities/{id}/enabled")
    public Result<Activity> setEnabled(HttpServletRequest request,
                                       @PathVariable String id,
                                       @RequestBody Map<String, Object> body) {
        boolean enabled = Boolean.parseBoolean(String.valueOf(body.get("enabled")));
        return Result.success(activityService.setEnabled(id, enabled, operator(request)));
    }

    /** 删除活动 */
    @DeleteMapping("/admin/activities/{id}")
    public Result<Boolean> deleteActivity(HttpServletRequest request, @PathVariable String id) {
        return Result.success(activityService.delete(id, operator(request)));
    }

    /** 提前结束主推活动（主推由服务端解析，不接受客户端传 id） */
    @PostMapping("/admin/activities/close")
    public Result<Activity> close(HttpServletRequest request) {
        return Result.success(activityService.closeFeatured(operator(request)));
    }

    /** 重新开启主推活动，默认 14 天并重置倒计时 */
    @PostMapping("/admin/activities/restart")
    public Result<Activity> restart(HttpServletRequest request, @RequestBody(required = false) Map<String, Object> body) {
        Integer days = null;
        if (body != null && body.get("durationDays") != null) {
            days = ((Number) body.get("durationDays")).intValue();
        }
        return Result.success(activityService.restartFeatured(days, operator(request)));
    }

    /** 恢复出厂活动（清空后按内置模板重建） */
    @PostMapping("/admin/activities/reset")
    public Result<List<Activity>> reset(HttpServletRequest request) {
        return Result.success(activityService.resetToFactory(operator(request)));
    }

    /** 操作人昵称（写进活动日志，出争议能查出是谁改的） */
    private String operator(HttpServletRequest request) {
        String name = (String) request.getAttribute(AuthInterceptor.ATTR_USERNAME);
        return name != null && !name.isBlank() ? name : "admin";
    }
}
