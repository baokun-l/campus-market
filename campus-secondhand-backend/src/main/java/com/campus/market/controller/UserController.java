package com.campus.market.controller;

import com.campus.market.common.PageResult;
import com.campus.market.common.Params;
import com.campus.market.common.Result;
import com.campus.market.config.JwtConfig;
import com.campus.market.dto.FavoriteItem;
import com.campus.market.dto.HistoryItem;
import com.campus.market.entity.Address;
import com.campus.market.entity.Goods;
import com.campus.market.entity.User;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.security.AuthCookie;
import com.campus.market.service.GoodsService;
import com.campus.market.service.UserService;
import com.baomidou.mybatisplus.core.metadata.IPage;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 用户控制器（控制层）
 * <p>
 * 路由总览：
 *  - POST   /user/login                    登录（带失败次数闸门，见 LoginAttemptGuard）
 *  - POST   /user/logout                   登出（清 HttpOnly Cookie；幂等、不要求已登录，见 D9）
 *  - POST   /user/register                 注册
 *  - GET    /user/profile                  获取当前用户信息
 *  - PATCH  /user/profile                  修改个人资料（昵称 / 头像 / 手机号）
 *  - PATCH  /user/password                 修改密码
 *  - POST   /user/heartbeat                在线心跳（刷新最后活跃时间）
 *  - PATCH  /user/privacy                  隐私设置（是否对外展示在线状态）
 *  - GET    /users/online                  批量查询「谁在线」（公开，只返回 id 列表）
 *  - GET    /admin/users                   用户列表（管理端）
 *  - GET    /users/{id}/profile            用户公开主页
 *  - POST   /admin/users/{id}/ban          封禁/解封
 *  - POST   /admin/users/{id}/reset-password  重置密码
 *  - POST   /admin/users/{id}/warn         发送平台警告
 *  - POST   /admin/users/batch-ban         批量封禁/解封
 *  - PATCH  /admin/users/{id}/credit       调整信用分
 *  - GET    /user/goods                    我的商品
 *  - PATCH  /user/goods/{id}/status        我的商品上下架
 *  - DELETE /user/goods/{id}               删除我的商品
 *  - GET    /user/favorites                我的收藏（分页）
 *  - POST   /user/favorites/toggle         收藏 / 取消收藏
 *  - DELETE /user/favorites/{goodsId}      取消收藏
 *  - GET    /user/history                  浏览历史（分页）
 *  - POST   /user/history                  记录足迹
 *  - DELETE /user/history/{id}             删除单条足迹
 *  - DELETE /user/history                  清空足迹
 *  - GET/POST/PUT/DELETE /user/addresses*  收货地址
 */
@RestController
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;
    private final GoodsService goodsService;

    /** 只为了拿 token 的有效期，让 Cookie 的 Max-Age 与 token 同源（D9，见 AuthCookie 类注释） */
    private final JwtConfig jwtConfig;

    /**
     * 登录。
     * <p>
     * ★ 为什么来源地址要在这里取 ★：登录失败闸门除了「账号」维度，还需要一个
     * 「来源」维度来兜住撞库（拿一个弱口令去试上千个账号，每个账号只错一次，
     * 账号维度一次都不会触发）。取的是 <b>TCP 对端地址</b>，<b>不是</b>
     * {@code X-Forwarded-For} —— 后者完全由客户端填写，采信它等于没装，
     * 详见 {@code com.campus.market.security.LoginAttemptGuard} 的类注释。
     */
    @PostMapping("/user/login")
    public Result<Map<String, Object>> login(@RequestBody Map<String, String> body,
                                             HttpServletRequest request,
                                             HttpServletResponse response) {
        Map<String, Object> result = userService.login(
                body.get("username"), body.get("password"), clientIp(request));
        issueSessionCookie(request, response, result);
        return Result.success(result);
    }

    /** 来源地址：只认 TCP 对端，任何客户端可伪造的转发头一律不采信 */
    private String clientIp(HttpServletRequest request) {
        return request == null ? null : request.getRemoteAddr();
    }

    /**
     * 把票据同时写进 HttpOnly Cookie（部署适配清单 D9）。
     * <p>
     * ★ 响应体里的 {@code token} **一个字都不改** ★
     * 接口契约保持原样（登录仍返回 {@code {token, user}}），改动只发生在**存储通道**上：
     * 前端从此不再把它写进 localStorage。这样既有客户端与探针不受影响，
     * 又堵住了「一次 XSS 就能把 24 小时凭据带走」那条路。
     * <p>
     * 残留风险如实记在这里：响应体里仍有 token，所以**正在发生 XSS 的那一刻**
     * 攻击者可以从这次登录的响应里截获它。但那是「需要诱导用户重新登录 + 已知口令」才能拿到，
     * 与「从存储里静默读走现成凭据、换台机器继续用」完全不是一个量级。
     * 彻底消除需要把 token 从浏览器可见的响应体里删掉（属接口契约变更，另行评估）。
     */
    private void issueSessionCookie(HttpServletRequest request, HttpServletResponse response,
                                    Map<String, Object> result) {
        Object token = result == null ? null : result.get("token");
        if (token instanceof String s && !s.isEmpty()) {
            AuthCookie.write(response, s, jwtConfig.getExpiration(), request.isSecure());
        }
    }

    /**
     * 登出：让服务端把 HttpOnly Cookie 清掉。
     * <p>
     * ★ 这个端点是 D9 的**必需品**，不是锦上添花 ★
     * HttpOnly 的含义就是「前端没有能力删它」。没有它，用户点「退出登录」只会清空
     * 前端 store，而浏览器依旧带着那张有效票据 —— 一刷新就又是登录态，
     * 表现是「退不出去」。之前的实现没有这个问题，只因为凭据存在 localStorage、
     * 前端正好能自己删；换成 Cookie 之后这条原本免费的能力必须由服务端补回来。
     * <p>
     * 刻意做成**幂等**且**不要求已登录**：凭据已过期、已被封禁、甚至压根没登录时，
     * 调用它都应当成功返回（清一个不存在的 Cookie 是无害的）。
     * 若要求登录，用户在最需要退出的时刻（会话已失效）反而退不掉。
     */
    @PostMapping("/user/logout")
    public Result<Void> logout(HttpServletRequest request, HttpServletResponse response) {
        AuthCookie.clear(response, request.isSecure());
        return Result.success();
    }

    /** 注册 */
    @PostMapping("/user/register")
    public Result<Map<String, Object>> register(@RequestBody Map<String, String> body,
                                                HttpServletRequest request,
                                                HttpServletResponse response) {
        Map<String, Object> result = userService.register(
                body.get("username"), body.get("password"), body.get("nickname"));
        // 注册即登录（与前端一致），所以同样下发票据 —— 否则新用户注册后第一个请求就是未登录
        issueSessionCookie(request, response, result);
        return Result.success(result);
    }

    /** 获取当前用户信息 */
    @GetMapping("/user/profile")
    public Result<User> getProfile(HttpServletRequest request) {
        return Result.success(userService.getProfile(currentUserId(request)));
    }

    /**
     * 修改个人资料（昵称 / 头像 / 手机号）。
     * <p>
     * ★ 局部更新语义 ★：只改请求体里**出现过的**字段。三个字段都是可选的，
     * 但一个都没出现（或键名全是后端不认识的）会以 1001 拒绝 ——
     * 静默返回成功会让用户以为改好了，刷新后却发现没变，只能反复重试。
     * <p>
     * ★ 返回更新后的完整资料 ★：调用方（前端 `userStore.applyProfile`）应当用这个
     * 返回值回填，而不是沿用本地乐观值 —— 否则请求失败时界面已经变了，
     * 用户会以为保存成功，直到刷新才发现根本没落库。
     * <p>
     * 身份只认 token（{@code currentUserId}），请求体里传别人的 id 无效：
     * 这个接口改的永远是「调用者自己」。
     */
    @PatchMapping("/user/profile")
    public Result<User> updateProfile(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Long userId = currentUserId(request);
        userService.updateProfile(userId, body);
        return Result.success(userService.getProfile(userId));
    }

    /**
     * 修改密码（用户自助，设置页入口）
     * <p>
     * 原密码校验在 Service 层：原密码错误 / 新密码不足 6 位 / 与原密码相同
     * 都会以业务码 1001 拒绝，前端把 message 直接展示给用户。
     */
    @PatchMapping("/user/password")
    public Result<Void> changePassword(HttpServletRequest request, @RequestBody Map<String, String> body) {
        userService.changePassword(currentUserId(request), body.get("oldPassword"), body.get("newPassword"));
        return Result.success();
    }

    /**
     * 在线心跳：把当前用户的最后活跃时间刷新为「现在」。
     * <p>
     * 前端在应用启动时调一次，之后按固定间隔（60 秒）续期。
     * 不做登录校验之外的任何入参 —— 服务端只认「谁在调」，
     * 不认「客户端说自己几点活跃」，否则谁都能把自己或别人刷成在线。
     */
    @PostMapping("/user/heartbeat")
    public Result<Void> heartbeat(HttpServletRequest request) {
        userService.heartbeat(currentUserId(request));
        return Result.success();
    }

    /**
     * 隐私设置：是否对外展示自己的在线状态。
     * <p>
     * ★ 只认布尔字面量 ★：客户端若传 {@code "true"} 这类字符串，
     * 会按「未指定」处理并返回 1001，而不是被 {@code Boolean.parseBoolean}
     * 静默当成 false —— 那会让用户以为自己只是「关掉了展示」，
     * 实际却是被一个拼错的参数关掉的，属于最难发现的一类隐私配置错误。
     */
    @PatchMapping("/user/privacy")
    public Result<Boolean> updatePrivacy(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Object raw = body.get("showOnline");
        Boolean showOnline = (raw instanceof Boolean b) ? b : null;
        return Result.success(userService.updateShowOnline(currentUserId(request), showOnline));
    }

    /**
     * 批量查询在线用户 id（公开可读）。
     * <p>
     * 放行给游客是刻意的：商品详情页未登录也能看，页面上要显示卖家在不在线；
     * 若要求登录，游客看到的永远是一片离线。泄露面也很小 —— 只返回「哪些 id 在线」，
     * 且已经被本人的 {@code show_online} 开关过滤过，拿不到任何活跃时间。
     * <p>
     * 非数字参数**静默丢弃**（与全站「越界筛选静默收敛」一致）：
     * 这是纯展示接口，一个脏值不该让整页的在线标识全部报错。
     */
    @GetMapping("/users/online")
    public Result<List<Long>> fetchOnlineUsers(HttpServletRequest request) {
        List<Long> ids = Params.multiValue(request, "ids").stream()
                .filter(s -> s.matches("\\d+"))
                .map(Long::valueOf)
                .toList();
        return Result.success(userService.queryOnlineIds(ids));
    }

    /** 用户列表（管理端） */
    @GetMapping("/admin/users")
    public Result<PageResult<User>> fetchUsers(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String status) {
        IPage<User> p = userService.fetchUsers(page, pageSize, keyword, status);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /** 用户公开主页 */
    @GetMapping("/users/{id}/profile")
    public Result<Map<String, Object>> fetchPublicProfile(@PathVariable Long id) {
        return Result.success(userService.fetchPublicProfile(id));
    }

    /** 封禁/解封 */
    @PostMapping("/admin/users/{id}/ban")
    public Result<Void> toggleBan(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        userService.toggleUserStatus(id, Boolean.TRUE.equals(body.get("banned")));
        return Result.success();
    }

    /** 批量封禁 / 解封（后台多选） */
    @PostMapping("/admin/users/batch-ban")
    public Result<Integer> batchToggleBan(@RequestBody Map<String, Object> body) {
        return Result.success(userService.batchToggleUserStatus(
                Params.toLongList(body.get("ids")), Boolean.TRUE.equals(body.get("banned"))));
    }

    /** 重置密码，返回重置后的初始密码供前端提示用户 */
    @PostMapping("/admin/users/{id}/reset-password")
    public Result<String> resetPassword(@PathVariable Long id) {
        return Result.success(userService.resetUserPassword(id));
    }

    /** 发送平台警告（站内信 + 审计留痕） */
    @PostMapping("/admin/users/{id}/warn")
    public Result<Void> warnUser(HttpServletRequest request, @PathVariable Long id,
                                  @RequestBody Map<String, String> body) {
        userService.warnUser(currentUserId(request), id, body.get("reason"));
        return Result.success();
    }

    /** 调整信用分 */
    @PatchMapping("/admin/users/{id}/credit")
    public Result<User> setCredit(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        Integer delta = body.get("delta") != null ? ((Number) body.get("delta")).intValue() : null;
        Integer value = body.get("value") != null ? ((Number) body.get("value")).intValue() : null;
        return Result.success(userService.setUserCredit(id, delta, value));
    }

    /** 我发布的商品 */
    @GetMapping("/user/goods")
    public Result<PageResult<Goods>> fetchMyGoods(
            HttpServletRequest request,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "12") int pageSize,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String keyword) {
        IPage<Goods> p = userService.fetchMyGoods(currentUserId(request), page, pageSize, status, keyword);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /**
     * 切换我的商品上下架
     * <p>
     * 传入当前用户 id 做归属校验 —— 前端调的正是这个接口，
     * 不校验的话任何登录用户改一个 id 就能下架别人的商品。
     */
    @PatchMapping("/user/goods/{id}/status")
    public Result<Void> toggleMyGoods(HttpServletRequest request, @PathVariable Long id,
                                      @RequestBody Map<String, String> body) {
        goodsService.updateGoodsStatus(id, body.get("status"), currentUserId(request));
        return Result.success();
    }

    /** 删除我的商品（同样校验归属） */
    @DeleteMapping("/user/goods/{id}")
    public Result<Void> deleteMyGoods(HttpServletRequest request, @PathVariable Long id) {
        goodsService.deleteGoods(id, currentUserId(request));
        return Result.success();
    }

    // ==================== 收藏 ====================

    /** 我的收藏（分页，内嵌商品信息） */
    @GetMapping("/user/favorites")
    public Result<PageResult<FavoriteItem>> fetchFavorites(
            HttpServletRequest request,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "12") int pageSize) {
        IPage<FavoriteItem> p = userService.fetchFavorites(currentUserId(request), page, pageSize);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /**
     * 切换收藏
     *
     * @return {@code {favorited: boolean}} —— 前端据此切换收藏按钮的实心/空心状态
     */
    @PostMapping("/user/favorites/toggle")
    public Result<Map<String, Object>> toggleFavorite(HttpServletRequest request,
                                                       @RequestBody Map<String, Object> body) {
        boolean favorited = userService.toggleFavorite(
                currentUserId(request), Params.requiredLong(body.get("goodsId"), "goodsId"));
        return Result.success(Map.of("favorited", favorited));
    }

    /** 取消收藏（按商品 id，幂等） */
    @DeleteMapping("/user/favorites/{goodsId}")
    public Result<Void> removeFavorite(HttpServletRequest request, @PathVariable Long goodsId) {
        userService.removeFavorite(currentUserId(request), goodsId);
        return Result.success();
    }

    // ==================== 浏览足迹 ====================

    /** 浏览历史（分页，内嵌商品信息） */
    @GetMapping("/user/history")
    public Result<PageResult<HistoryItem>> fetchHistory(
            HttpServletRequest request,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "15") int pageSize) {
        IPage<HistoryItem> p = userService.fetchHistory(currentUserId(request), page, pageSize);
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, pageSize));
    }

    /** 记录浏览足迹 */
    @PostMapping("/user/history")
    public Result<Void> recordHistory(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        userService.recordHistory(currentUserId(request),
                Params.requiredLong(body.get("goodsId"), "goodsId"));
        return Result.success();
    }

    /** 删除单条足迹 */
    @DeleteMapping("/user/history/{id}")
    public Result<Void> removeHistory(HttpServletRequest request, @PathVariable Long id) {
        userService.deleteHistory(currentUserId(request), id);
        return Result.success();
    }

    /** 清空浏览历史 */
    @DeleteMapping("/user/history")
    public Result<Void> clearHistory(HttpServletRequest request) {
        userService.clearHistory(currentUserId(request));
        return Result.success();
    }

    // ==================== 收货地址 ====================

    /** 收货地址列表 */
    @GetMapping("/user/addresses")
    public Result<List<Address>> fetchAddresses(HttpServletRequest request) {
        return Result.success(userService.fetchAddresses(currentUserId(request)));
    }

    /** 新增地址 */
    @PostMapping("/user/addresses")
    public Result<Address> saveAddress(HttpServletRequest request, @RequestBody Address addr) {
        return Result.success(userService.saveAddress(currentUserId(request), addr));
    }

    /** 修改地址 */
    @PutMapping("/user/addresses/{id}")
    public Result<Address> updateAddress(HttpServletRequest request, @PathVariable Long id,
                                          @RequestBody Address addr) {
        addr.setId(id);
        return Result.success(userService.saveAddress(currentUserId(request), addr));
    }

    @DeleteMapping("/user/addresses/{id}")
    public Result<Void> deleteAddress(HttpServletRequest request, @PathVariable Long id) {
        userService.deleteAddress(currentUserId(request), id);
        return Result.success();
    }

    /** 登录态里的用户 id（AuthInterceptor 已解析并写入 request attribute） */
    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }
}
