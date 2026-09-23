package com.campus.market.interceptor;

import com.campus.market.config.JwtConfig;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 公开白名单（游客可达面）的判定口径 —— 尤其是**方法敏感性**。
 *
 * <h3>为什么要有这个测试</h3>
 * 白名单里的商品详情是一条通配路径。历史上这个白名单是通过
 * {@code excludePathPatterns} 注册的，而那个 API **只按路径匹配、不看 HTTP 方法**：
 * 为了放行游客看商品详情而写上的那条 pattern，会连 {@code DELETE /goods/{id}}
 * 一起放行 —— 任何人无需登录即可删除别人的商品。
 * 现在白名单改在拦截器内部按「方法 + 路径」判定，本测试就是把这条性质**钉死**：
 * 一旦有人把 {@code if (!"GET".equalsIgnoreCase(method)) return false;} 那行删掉
 *（或者把白名单挪回 excludePathPatterns），下面「同路径不同方法」那一组会立刻变红。
 *
 * <h3>为什么直接 new 一个拦截器就够了</h3>
 * 本测试只针对 {@code preHandle} 里的**公开路径判定**这一段：
 * 匿名请求（不带 {@code Authorization} 头）根本不会走到解析 Token / 回查数据库的分支，
 * 所以 {@link JwtConfig} 与 {@link UserMapper} 传 null 是安全的 ——
 * 反过来说，如果哪天有人把「查库」挪到了公开路径判定**之前**，
 * 下面这些用例会直接 NPE 报错，这本身就是一条护栏。
 *
 * <p>跨边界的那一层由真机探针 {@code .workbuddy/e2e-guest-surface.mjs} 负责
 * （62 条断言：匿名可达面 + 隐私字段扫描 + 写操作一律 401）。这里负责的是
 * 「改代码时第一时间变红」那一层。
 */
class AuthInterceptorPublicPathTest {

    /** 匿名场景下 JwtConfig / UserMapper 不会被触碰（理由见类注释） */
    private final AuthInterceptor interceptor = new AuthInterceptor(null, null);

    /** 模拟一次匿名请求，返回拦截器是否放行 */
    private boolean allowed(String method, String path) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        request.setRequestURI(path);
        // ★ 刻意不设 Authorization 头 —— 这就是"游客"的样子
        return interceptor.preHandle(request, new MockHttpServletResponse(), new Object());
    }

    /* ============================================================
     * ★★ 核心：同一条路径，GET 放行、写方法必须挡住 ★★
     * ============================================================ */

    @Nested
    @DisplayName("★★ 方法敏感性：同路径不同方法（本组是白名单退化成按路径匹配时的报警器）")
    class MethodSensitivity {

        @Test
        @DisplayName("★ GET /goods/{id} 放行（游客能看商品详情）")
        void getGoodsDetailAllowed() throws Exception {
            assertTrue(allowed("GET", "/goods/5"));
        }

        @Test
        @DisplayName("★★ DELETE /goods/{id} 必须挡住 —— 与上面同一个 pattern，只差方法")
        void deleteGoodsDetailRejected() throws Exception {
            assertFalse(allowed("DELETE", "/goods/5"),
                    "DELETE /goods/{id} 被放行了：白名单退化成「只按路径匹配」，任何人都能删别人的商品");
        }

        @Test
        @DisplayName("★★ POST /goods 必须挡住（发布商品要登录）")
        void postGoodsRejected() throws Exception {
            assertFalse(allowed("POST", "/goods"));
        }

        @Test
        @DisplayName("★ PATCH /goods/{id}/status 必须挡住")
        void patchGoodsStatusRejected() throws Exception {
            assertFalse(allowed("PATCH", "/goods/5/status"));
        }

        @Test
        @DisplayName("★ POST /goods/{id}/comments 必须挡住（留言要登录）")
        void postCommentRejected() throws Exception {
            assertFalse(allowed("POST", "/goods/5/comments"));
        }

        @Test
        @DisplayName("★ GET /goods/{id}/comments 放行（看留言不用登录）")
        void getCommentsAllowed() throws Exception {
            assertTrue(allowed("GET", "/goods/5/comments"));
        }

        @Test
        @DisplayName("★ GET /uploads/** 放行（否则商品图在页面上全裂），但 PUT/POST/DELETE 必须挡住")
        void uploadsIsGetOnly() throws Exception {
            assertTrue(allowed("GET", "/uploads/2026/09/abc.jpg"));
            assertFalse(allowed("PUT", "/uploads/2026/09/abc.jpg"));
            assertFalse(allowed("POST", "/uploads/2026/09/abc.jpg"));
            assertFalse(allowed("DELETE", "/uploads/2026/09/abc.jpg"));
        }

        @Test
        @DisplayName("★ GET /v3/api-docs 放行（Swagger UI 靠它渲染），POST 必须挡住")
        void apiDocsIsGetOnly() throws Exception {
            assertTrue(allowed("GET", "/v3/api-docs"));
            assertFalse(allowed("POST", "/v3/api-docs"));
        }
    }

    /* ============================================================
     * 放行清单本身（游客能看什么）
     * ============================================================ */

    @Nested
    @DisplayName("放行清单：游客能看的浏览类 GET")
    class AnonymousReadable {

        @Test
        @DisplayName("商品广场 / 详情 / 分类")
        void goodsSurfaces() throws Exception {
            assertTrue(allowed("GET", "/goods"), "游客连商品列表都看不了，放开游客浏览就是空话");
            assertTrue(allowed("GET", "/goods/5"));
            assertTrue(allowed("GET", "/goods/5/detail"));
            assertTrue(allowed("GET", "/categories"));
        }

        @Test
        @DisplayName("公告列表与详情")
        void noticeSurfaces() throws Exception {
            assertTrue(allowed("GET", "/notices"));
            assertTrue(allowed("GET", "/notices/1"));
        }

        @Test
        @DisplayName("评价（按商品 / 按用户）")
        void reviewSurfaces() throws Exception {
            assertTrue(allowed("GET", "/goods/5/reviews"));
            assertTrue(allowed("GET", "/users/4/reviews"));
        }

        @Test
        @DisplayName("★ 他人主页放行 —— 否则游客在详情页点卖家头像就被弹去登录，动线断掉")
        void publicProfileAllowed() throws Exception {
            assertTrue(allowed("GET", "/users/4/profile"));
        }

        @Test
        @DisplayName("★ 在线名单放行 —— 否则游客看到的卖家永远「离线」")
        void onlineListAllowed() throws Exception {
            assertTrue(allowed("GET", "/users/online"));
        }

        @Test
        @DisplayName("登录 / 注册 / 容器错误页：任何方法都放行（PUBLIC_ANY）")
        void publicAnySurfaces() throws Exception {
            assertTrue(allowed("POST", "/user/login"));
            assertTrue(allowed("POST", "/user/register"));
            assertTrue(allowed("GET", "/error"));
            // PUBLIC_ANY 的语义就是"不区分方法"，这里顺手把这个语义也钉住
            assertTrue(allowed("GET", "/user/login"));
        }

        @Test
        @DisplayName("OPTIONS 预检一律放行（CORS 预检不带凭证，挡掉会变成莫名其妙的跨域失败）")
        void optionsAlwaysAllowed() throws Exception {
            assertTrue(allowed("OPTIONS", "/admin/settings"));
            assertTrue(allowed("OPTIONS", "/orders"));
        }
    }

    /* ============================================================
     * ★ 反面：不在白名单里的一律不放行
     * ============================================================ */

    @Nested
    @DisplayName("反面：GET 也不等于放行（「凡 GET 就放行」是最容易犯的错）")
    class ProtectedGetIsStillProtected {

        @Test
        @DisplayName("★ GET /analytics/** 必须挡住 —— 已刻意移出白名单，别被人顺手加回去")
        void analyticsStaysProtected() throws Exception {
            assertFalse(allowed("GET", "/analytics/summary"),
                    "/analytics/** 被放行了：GMV / 趋势 / 分类占比这些经营数据会暴露给未登录访客");
            assertFalse(allowed("GET", "/analytics/trend"));
            assertFalse(allowed("GET", "/analytics/top-goods"));
            assertFalse(allowed("GET", "/analytics/category-distribution"));
        }

        @Test
        @DisplayName("GET /user/** 挡住（都是「我的」数据）")
        void myDataStaysProtected() throws Exception {
            assertFalse(allowed("GET", "/user/profile"));
            assertFalse(allowed("GET", "/user/favorites"));
            assertFalse(allowed("GET", "/user/history"));
            assertFalse(allowed("GET", "/user/addresses"));
            assertFalse(allowed("GET", "/user/goods"));
        }

        @Test
        @DisplayName("GET /orders/**、/messages/** 挡住")
        void orderAndMessageStayProtected() throws Exception {
            assertFalse(allowed("GET", "/orders"));
            assertFalse(allowed("GET", "/orders/1/logs"));
            assertFalse(allowed("GET", "/messages/sessions"));
            assertFalse(allowed("GET", "/messages/unread"));
        }

        @Test
        @DisplayName("GET /admin/** 挡住")
        void adminStaysProtected() throws Exception {
            assertFalse(allowed("GET", "/admin/settings"));
            assertFalse(allowed("GET", "/admin/users"));
            assertFalse(allowed("GET", "/admin/orders"));
        }

        @Test
        @DisplayName("★ 形状相似但不在白名单的 GET 也挡住（防止被「照着抄」误加进去）")
        void lookalikesStayProtected() throws Exception {
            // 与 /goods/*/reviews 形状很像，但凭订单号看评价要登录
            assertFalse(allowed("GET", "/orders/1/review"));
            // 与 /users/*/profile 同前缀，但这是"某人发布的商品"
            assertFalse(allowed("GET", "/users/4/goods"));
        }

        @Test
        @DisplayName("活动接口挡住（首页/详情里的活动位依赖登录态，不在白名单）")
        void activityStaysProtected() throws Exception {
            assertFalse(allowed("GET", "/activities"));
            assertFalse(allowed("GET", "/activities/active"));
            assertFalse(allowed("GET", "/activities/current"));
        }
    }

    /* ============================================================
     * ★ 支付回调：唯一「匿名可写」的接口
     * ============================================================ */

    @Nested
    @DisplayName("支付回调：POST 必须放行、GET 必须挡住（本组是新支付链路的报警器）")
    class PaymentNotify {

        @Test
        @DisplayName("★ POST /pay/notify/{channel} 放行 —— 渠道服务器不带我们的 Authorization 头")
        void notifyPostAllowed() throws Exception {
            assertTrue(allowed("POST", "/pay/notify/alipay_sandbox"),
                    "支付回调被挡住了：用户在支付宝真付了钱，而我们的订单会永远停在待付款，且没有任何报错");
            assertTrue(allowed("POST", "/pay/notify/wallet"));
        }

        @Test
        @DisplayName("★★ GET /pay/notify/** 必须挡住 —— 白名单是「仅 POST」，不是「整条路径公开」")
        void notifyGetRejected() throws Exception {
            assertFalse(allowed("GET", "/pay/notify/alipay_sandbox"),
                    "GET 回调被放行了：白名单退化成按路径匹配，任何人能用浏览器探测回调入口");
            assertFalse(allowed("PUT", "/pay/notify/alipay_sandbox"));
            assertFalse(allowed("DELETE", "/pay/notify/alipay_sandbox"));
        }

        @Test
        @DisplayName("★ GET /pay/channels 挡住 —— 它要返回当前用户的钱包余额，不能匿名")
        void payChannelsRejected() throws Exception {
            assertFalse(allowed("GET", "/pay/channels"));
        }

        @Test
        @DisplayName("★ GET /orders/{id}/pay/status 挡住 —— 支付状态含金额与渠道流水号")
        void payStatusRejected() throws Exception {
            assertFalse(allowed("GET", "/orders/2026091700001/pay/status"));
        }
    }

    /* ============================================================
     * 通配不越界：`/goods/*` 只吃一段，不能把子路径也吃掉
     * ============================================================ */

    @Nested
    @DisplayName("通配范围：星号只吃一段路径，不能顺带放行更深的路由")
    class WildcardScope {

        @Test
        @DisplayName("★ /goods/*/status 不在白名单 —— 通配没有把「改状态」这条子路径也放进来")
        void wildcardDoesNotSwallowDeeperWritePath() throws Exception {
            assertFalse(allowed("GET", "/goods/5/status"));
        }

        @Test
        @DisplayName("★ /notices/*/admin 之类更深的路径不放行")
        void deeperNoticePathRejected() throws Exception {
            assertFalse(allowed("GET", "/notices/1/anything"));
        }

        @Test
        @DisplayName("★ /v3/api-docs 的开放不影响 /v3/other")
        void apiDocsPrefixDoesNotLeak() throws Exception {
            assertFalse(allowed("GET", "/v3/other-docs"));
        }
    }
}
