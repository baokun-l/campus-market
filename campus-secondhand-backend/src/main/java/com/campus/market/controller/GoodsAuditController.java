package com.campus.market.controller;

import com.campus.market.common.PageResult;
import com.campus.market.common.Result;
import com.campus.market.entity.Goods;
import com.campus.market.entity.GoodsAuditRecord;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.GoodsAuditService;
import com.baomidou.mybatisplus.core.metadata.IPage;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 商品审核控制器（独立于全能管理员，职能单一）
 */
@RestController
@RequiredArgsConstructor
public class GoodsAuditController {

    private final GoodsAuditService goodsAuditService;

    @GetMapping("/review/goods/pending")
    public Result<PageResult<Goods>> fetchPending(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String keyword) {
        IPage<Goods> p = goodsAuditService.fetchPendingGoods(page, pageSize, keyword);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    @GetMapping("/review/goods/{goodsId}/detail")
    public Result<Map<String, Object>> fetchDetail(@PathVariable Long goodsId) {
        return Result.success(goodsAuditService.fetchAuditDetail(goodsId));
    }

    @PostMapping("/review/goods/{goodsId}/review")
    public Result<Void> reviewGoods(HttpServletRequest request,
                                     @PathVariable Long goodsId,
                                     @RequestBody Map<String, Object> body) {
        String operator = (String) request.getAttribute(AuthInterceptor.ATTR_USERNAME);
        goodsAuditService.reviewGoods(goodsId,
                (String) body.get("action"),
                (String) body.get("reason"),
                operator);
        return Result.success();
    }

    @GetMapping("/review/goods/records")
    public Result<PageResult<GoodsAuditRecord>> fetchRecords(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String keyword) {
        IPage<GoodsAuditRecord> p = goodsAuditService.fetchRecords(page, pageSize, keyword);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /**
     * 审核记录导出：与列表共用关键字过滤，导出「全部」而不是当前页。
     */
    @GetMapping("/review/goods/records/export")
    public Result<List<GoodsAuditRecord>> exportRecords(@RequestParam(required = false) String keyword) {
        return Result.success(goodsAuditService.fetchRecordsForExport(keyword));
    }

    @GetMapping("/review/goods/stats")
    public Result<Map<String, Object>> fetchStats() {
        return Result.success(goodsAuditService.fetchStats());
    }
}
