package com.campus.market.controller;

import com.campus.market.common.PageResult;
import com.campus.market.common.Params;
import com.campus.market.common.Result;
import com.campus.market.entity.Category;
import com.campus.market.entity.Goods;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.GoodsService;
import com.baomidou.mybatisplus.core.metadata.IPage;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 商品 + 分类控制器
 */
@RestController
@RequiredArgsConstructor
public class GoodsController {

    private final GoodsService goodsService;

    /**
     * 商品列表
     * <p>
     * ★ {@code statuses} 必须走 {@link Params#multiValue} 手动读取，不能用
     * {@code @RequestParam List<String>}：axios 把它序列化成
     * {@code statuses[]=on_sale&statuses[]=sold}（带方括号），按字面名取值绑不上、
     * 会静默变成 null。而买家侧商品广场正是靠这个白名单挡住「审核中 / 已下架」的商品 ——
     * 白名单一丢，未过审和已下架的商品就会直接出现在广场里，点进去才发现买不了。
     * <p>
     * ★ 与详情接口同源的身份透传 ★
     * <p>
     * 可见范围由 Service 判定，而判定需要访问者身份，所以这里把
     * **id 与 role 一并透传**（两个都要：role 决定是不是后台，
     * id 决定是不是「在查自己发布的商品」—— 卖家要能看见自己的待审 / 已下架商品）。
     * 后台（商品管理 / CSV 导出）要拿全量，买家与匿名只能拿到 on_sale + sold；
     * 调用方自己传来的状态条件同样要过这道判定，否则匿名多带一个
     * {@code ?statuses=pending} 就能把范围重新撑开。
     * 这里从拦截器取**可空**的身份（公开路由，匿名时两者皆 null），取值必须按可空处理。
     */
    @GetMapping("/goods")
    public Result<PageResult<Goods>> fetchGoods(
            HttpServletRequest request,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "12") int pageSize,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Long categoryId,
            @RequestParam(required = false) Long sellerId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String sort) {
        Long viewerId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        String viewerRole = (String) request.getAttribute(AuthInterceptor.ATTR_ROLE);
        IPage<Goods> p = goodsService.fetchGoods(page, pageSize, keyword, categoryId, sellerId, status,
                Params.multiValue(request, "statuses"), sort, viewerId, viewerRole);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /**
     * 商品详情
     * <p>
     * 同时挂 `/goods/{id}/detail` 与 `/goods/{id}` 两个路径：
     * 后者是前端 `api/goods.ts:101` 实际调用的写法，缺了它会直接 404
     * （列表点进详情、我的发布→查看、收藏→查看 全部入口都会挂）。
     * <p>
     * ★ 必须把访问者身份传下去做可见性判定 ★
     * <p>
     * 本接口是**公开路由**（匿名可达），而列表接口的 `statuses` 白名单只保护了列表，
     * 详情此前是「谁拿 id 都能读」—— 审核中/已下架的商品因此可以被直接访问。
     * 这里把拦截器解析出的身份（**匿名时两者皆为 null**）透传给 Service 做判定。
     * 注意 `AuthInterceptor` 对公开路径也会尽力解析 token：带了就注入、没带就是 null，
     * 所以取值必须按「可空」处理，不能断言非空。
     */
    @GetMapping({"/goods/{id}", "/goods/{id}/detail"})
    public Result<Goods> fetchDetail(HttpServletRequest request, @PathVariable Long id) {
        Long viewerId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        String viewerRole = (String) request.getAttribute(AuthInterceptor.ATTR_ROLE);
        return Result.success(goodsService.fetchGoodsDetail(id, viewerId, viewerRole));
    }

    /** 发布商品 */
    @PostMapping("/goods")
    public Result<Goods> publishGoods(HttpServletRequest request, @RequestBody Goods goods) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(goodsService.publishGoods(goods, userId));
    }

    /**
     * 修改商品状态
     * <p>
     * ★ 必须把当前登录用户与角色传下去 ★：这两个接口原先调的是不带 operatorId 的重载，
     * 归属校验形同虚设 —— 任何登录用户改一个 id 就能下架别人的在售商品。
     */
    @PatchMapping("/goods/{id}/status")
    public Result<Void> updateStatus(HttpServletRequest request, @PathVariable Long id,
                                     @RequestBody Map<String, String> body) {
        goodsService.updateGoodsStatus(id, body.get("status"),
                currentUserId(request), currentRole(request));
        return Result.success();
    }

    /** 删除商品（同上：后台角色可删任意商品，卖家只能删自己的） */
    @DeleteMapping("/goods/{id}")
    public Result<Void> deleteGoods(HttpServletRequest request, @PathVariable Long id) {
        goodsService.deleteGoods(id, currentUserId(request), currentRole(request));
        return Result.success();
    }

    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }

    private String currentRole(HttpServletRequest request) {
        return (String) request.getAttribute(AuthInterceptor.ATTR_ROLE);
    }

    // ==================== 分类 ====================

    @GetMapping("/categories")
    public Result<List<Category>> fetchCategories() {
        return Result.success(goodsService.fetchCategories());
    }

    @GetMapping("/admin/categories/stats")
    public Result<List<Map<String, Object>>> fetchCategoryStats() {
        return Result.success(goodsService.fetchCategoryStats());
    }

    @PostMapping("/admin/categories")
    public Result<Category> createCategory(@RequestBody Map<String, String> body) {
        return Result.success(goodsService.createCategory(body.get("name"), body.get("icon")));
    }

    @PatchMapping("/admin/categories/{id}")
    public Result<Category> updateCategory(@PathVariable Long id, @RequestBody Map<String, String> body) {
        return Result.success(goodsService.updateCategory(id, body.get("name"), body.get("icon")));
    }

    @DeleteMapping("/admin/categories/{id}")
    public Result<Map<String, Object>> deleteCategory(@PathVariable Long id) {
        return Result.success(goodsService.deleteCategory(id));
    }

    // ==================== 批量操作 ====================

    @PatchMapping("/admin/goods/batch-status")
    public Result<Integer> batchUpdateStatus(@RequestBody Map<String, Object> body) {
        return Result.success(goodsService.batchUpdateStatus(
                Params.toLongList(body.get("ids")), (String) body.get("status")));
    }

    /** 批量删除商品 */
    @PostMapping("/admin/goods/batch-delete")
    public Result<Integer> batchDeleteGoods(@RequestBody Map<String, Object> body) {
        return Result.success(goodsService.batchDeleteGoods(Params.toLongList(body.get("ids"))));
    }
}
