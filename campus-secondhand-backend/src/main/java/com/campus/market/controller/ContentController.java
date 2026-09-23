package com.campus.market.controller;

import com.campus.market.common.BusinessException;
import com.campus.market.common.PageResult;
import com.campus.market.common.Params;
import com.campus.market.common.Result;
import com.campus.market.dto.ReportTargetBrief;
import com.campus.market.entity.Comment;
import com.campus.market.entity.Report;
import com.campus.market.entity.Review;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.ContentService;
import com.baomidou.mybatisplus.core.metadata.IPage;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 评价 + 留言 + 举报控制器
 */
@RestController
@RequiredArgsConstructor
public class ContentController {

    private final ContentService contentService;

    // ==================== 评价 ====================

    @GetMapping("/goods/{goodsId}/reviews")
    public Result<List<Review>> fetchReviewsByGoods(@PathVariable Long goodsId) {
        return Result.success(contentService.fetchReviewsByGoods(goodsId));
    }

    @GetMapping("/users/{userId}/reviews")
    public Result<List<Review>> fetchReviewsByUser(@PathVariable Long userId) {
        return Result.success(contentService.fetchReviewsByUser(userId));
    }

    @PostMapping("/reviews")
    public Result<Map<String, Object>> submitReview(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        /*
         * ★ 入参一律按可缺失收 ★
         * goodsId / toUserId 在 Service 里以订单为准重算（见 ContentService#submitReview），
         * 传不传都不影响落库值 —— 原先 `body.get("goodsId").toString()` 直接撞 NPE 变 500；
         * rating 也可能被客户端传成字符串/浮点，统一走 optionalInt 收敛。
         */
        return Result.success(contentService.submitReview(userId,
                body.get("orderId") != null ? body.get("orderId").toString() : null,
                body.get("goodsId") == null ? null : Params.requiredLong(body.get("goodsId"), "goodsId"),
                body.get("toUserId") == null ? null : Params.requiredLong(body.get("toUserId"), "toUserId"),
                optionalInt(body.get("rating"), "rating"),
                (String) body.get("content")));
    }

    @GetMapping("/orders/{orderId}/review")
    public Result<List<Review>> fetchReviewByOrder(@PathVariable String orderId) {
        Review r = contentService.fetchReviewByOrder(orderId);
        return Result.success(r != null ? List.of(r) : List.of());
    }

    /**
     * 追加评论（追评）
     * <p>
     * ★ 必须带上当前登录用户 ★：原先只传了 orderId，任何人拿到订单号就能替别人追评。
     */
    @PostMapping("/orders/{orderId}/review/append")
    public Result<Map<String, Object>> appendReview(HttpServletRequest request,
                                                    @PathVariable String orderId,
                                                    @RequestBody Map<String, String> body) {
        return Result.success(contentService.appendReview(orderId,
                (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID),
                (String) request.getAttribute(AuthInterceptor.ATTR_ROLE),
                body.get("content")));
    }

    @GetMapping("/admin/reviews")
    public Result<PageResult<Map<String, Object>>> fetchAdminReviews(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Object rating) {
        IPage<Map<String, Object>> p = contentService.fetchAdminReviews(page, pageSize, keyword, rating);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    @DeleteMapping("/admin/reviews/{id}")
    public Result<Void> deleteReview(@PathVariable Long id) {
        contentService.deleteReview(id);
        return Result.success();
    }

    // ==================== 留言 ====================

    @GetMapping("/goods/{goodsId}/comments")
    public Result<List<Comment>> fetchComments(@PathVariable Long goodsId) {
        return Result.success(contentService.fetchComments(goodsId));
    }

    @PostMapping("/goods/{goodsId}/comments")
    public Result<Comment> postComment(HttpServletRequest request, @PathVariable Long goodsId,
                                         @RequestBody Map<String, Object> body) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        Long parentId = body.get("parentId") != null ? Long.valueOf(body.get("parentId").toString()) : null;
        return Result.success(contentService.postComment(userId, goodsId, (String) body.get("content"), parentId));
    }

    @GetMapping("/admin/comments")
    public Result<PageResult<Map<String, Object>>> fetchAdminComments(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Long goodsId) {
        // 简化：直接用 service
        IPage<Map<String, Object>> p = contentService.fetchAdminComments(page, pageSize, keyword, goodsId);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    @DeleteMapping("/admin/comments/{id}")
    public Result<Map<String, Object>> deleteComment(@PathVariable Long id) {
        int removed = contentService.deleteComment(id);
        return Result.success(Map.of("removed", removed));
    }

    // ==================== 举报 ====================

    @PostMapping("/reports")
    public Result<Void> submitReport(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        // 同 submitReview：targetId 缺失时不能靠 .toString() 去撞 NPE（会变成 500）
        contentService.submitReport(userId,
                (String) body.get("type"),
                Params.requiredLong(body.get("targetId"), "targetId"),
                (String) body.get("reason"),
                (String) body.get("description"));
        return Result.success();
    }

    @GetMapping("/admin/reports")
    public Result<PageResult<Report>> fetchReports(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String type) {
        IPage<Report> p = contentService.fetchReports(page, pageSize, status, type);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    @GetMapping("/admin/reports/stats")
    public Result<Map<String, Object>> fetchReportStats() {
        return Result.success(contentService.fetchReportStats());
    }

    @PostMapping("/admin/reports/{id}/resolve")
    public Result<Void> resolveReport(HttpServletRequest request, @PathVariable Long id, @RequestBody Map<String, Object> body) {
        String operator = (String) request.getAttribute(AuthInterceptor.ATTR_USERNAME);
        contentService.resolveReport(id,
                (String) body.get("action"),
                (String) body.get("measure"),
                (String) body.get("remark"),
                operator);
        return Result.success();
    }

    /**
     * 批量处理 / 驳回举报
     *
     * @return 实际被处理的条数（已处理过的会被跳过，不重复计入）
     */
    @PostMapping("/admin/reports/batch-resolve")
    public Result<Integer> batchResolveReports(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        String operator = (String) request.getAttribute(AuthInterceptor.ATTR_USERNAME);
        return Result.success(contentService.batchResolveReports(
                Params.toLongList(body.get("ids")),
                (String) body.get("action"),
                (String) body.get("measure"),
                (String) body.get("remark"),
                operator));
    }

    /**
     * 被举报对象现状快照（核实抽屉）
     * <p>
     * 举报处理后台的「核实」必须能当场看到被举报对象现在的状态，
     * 商品类举报还要给出完整商品档案。
     */
    @GetMapping("/admin/reports/target/{type}/{targetId}")
    public Result<ReportTargetBrief> fetchReportTargetBrief(@PathVariable String type,
                                                            @PathVariable Long targetId) {
        return Result.success(contentService.fetchReportTargetBrief(type, targetId));
    }

    /**
     * 举报处理记录导出：与列表共用同一套筛选，导出「当前筛选的全部」而非当前页 ——
     * 导出截断是「悄悄少数据」，比直接报错危险得多。
     */
    @GetMapping("/admin/reports/export")
    public Result<List<Report>> exportReports(
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String type) {
        return Result.success(contentService.fetchReportsForExport(status, type));
    }

    /**
     * 可选整型参数：JSON 里可能收到 Integer / Long / String，
     * 统一按 Number 收，避免 `(Integer) body.get(...)` 的 ClassCastException（会变成 500）。
     */
    private Integer optionalInt(Object raw, String field) {
        if (raw == null) return null;
        if (raw instanceof Number n) return n.intValue();
        String s = raw.toString().trim();
        if (s.isEmpty()) return null;
        try {
            return Integer.valueOf(s);
        } catch (NumberFormatException e) {
            throw BusinessException.paramError("参数格式错误：" + field);
        }
    }
}
