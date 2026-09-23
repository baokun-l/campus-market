package com.campus.market.interceptor;

import com.campus.market.config.JwtConfig;
import com.campus.market.security.AuthCookie;
import com.campus.market.security.AuthSnapshotCache;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.List;
import java.util.Optional;

/**
 * JWT 认证 + 授权拦截器
 * <p>
 * 从请求头 {@code Authorization: Bearer <token>} 中解析 Token，
 * 将 userId / username / role 存入 request attribute 供 Controller 取用。
 * <p>
 * Token 无效或过期 → 401；已登录但角色不够 → 403。
 * <p>
 * ★ 公开路由按「方法 + 路径」判定 ★
 * <p>
 * 早期把白名单交给 {@code excludePathPatterns}，那是**只按路径**匹配的：
 * 一旦为了放行游客看商品详情而写上 {@code /goods/*}，同一个 pattern 会把
 * {@code DELETE /goods/{id}} 一起放出去 —— 任何人无需登录即可删除别人的商品。
 * 方法敏感的白名单必须在拦截器内部判定，所以本类自己持有 PUBLIC_GET / PUBLIC_ANY。
 * <p>
 * ★ 角色分区（本轮补上的鉴权缺口）★
 * <p>
 * 修好认证之后，曾经有很长一段时间**只有认证、没有授权**：只要 Token 有效，
 * 任何登录学生都能调 {@code POST /admin/users/{id}/reset-password}（直接接管他人账号）、
 * {@code POST /admin/users/{id}/ban}、{@code PATCH /admin/settings}、
 * {@code DELETE /admin/audit-logs}（抹掉审计痕迹）、{@code POST /admin/orders/{id}/refund}。
 * 前端的 {@code meta.requireAdmin} / {@code meta.roles} 只是路由守卫，
 * 绕过页面直连接口就完全失效 —— 权限必须落在这里。
 * <p>
 * 分区口径与前端 {@code router/index.ts} 的 {@code meta} 逐条对齐：
 * <ul>
 *   <li>{@code /admin/**}（除举报子域）→ 仅 {@code admin}</li>
 *   <li>{@code /admin/reports/**} → {@code admin} 或 {@code report_admin}（举报处理后台）</li>
 *   <li>{@code /review/goods/**} → {@code admin} 或 {@code goods_admin}（商品审核后台）</li>
 * </ul>
 * 两个审核后台「职能互斥」，所以 {@code goods_admin} 进不了举报域、{@code report_admin}
 * 也进不了商品审核域；全能 {@code admin} 两边都放行（与前端注释一致，便于排查演示）。
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    public static final String ATTR_USER_ID = "currentUserId";
    public static final String ATTR_USERNAME = "currentUsername";
    public static final String ATTR_ROLE = "currentRole";

    private static final AntPathMatcher MATCHER = new AntPathMatcher();

    /**
     * 匿名可读：仅当请求方法是 GET 时放行（浏览类接口）。
     * <p>
     * 注意 {@code /analytics/**} 已从白名单移出：前端 {@code Home.vue} 与
     * {@code Analytics.vue} 两条路由的 meta 都是 {@code requireAuth: true}，
     * 没有任何游客页面读它。留在白名单等于把 GMV / 趋势 / 分类占比
     * 这些经营数据暴露给未登录访客。
     */
    private static final List<String> PUBLIC_GET = List.of(
            "/goods",
            "/goods/*",
            "/goods/*/detail",
            "/categories",
            "/notices",
            "/notices/*",
            "/goods/*/comments",
            "/goods/*/reviews",
            "/users/*/profile",
            "/users/*/reviews",
            /*
             * ★ 在线名单必须匿名可读 ★
             * 商品详情页游客也能看，页面上要显示卖家在不在线 —— 若要求登录，
             * 游客看到的是「所有人永远离线」，这个标识对站点最大的流量来源就等于不存在。
             * 返回体只有「哪些 id 在线」，且服务端已按本人 show_online 开关过滤过，
             * 既不含活跃时间也不含任何身份信息；写入方向全部需要登录
             * （POST /user/heartbeat、PATCH /user/privacy 都不在白名单）。
             */
            "/users/online",
            /*
             * ★ 商品图必须匿名可读，否则整站图片裂开 ★
             * 前端渲染商品图用的是 <img src="/api/uploads/...">，浏览器发起的是
             * 一个不带 Authorization 头的普通 GET 请求 —— 拦截器一旦要求登录，
             * 返回的 401 JSON 会被当成图片内容，页面上就是一排碎图标。
             * 商品图本身是公开展示内容（商品详情未登录都能看），放行不泄露任何隐私；
             * 反过来「写」的方面仍然是受控的：上传接口 POST /upload/image 不在白名单，
             * 未登录无法上传，也就无法往磁盘塞文件。
             */
            "/uploads/**",
            /*
             * ★ 接口文档（springdoc / Swagger UI）必须匿名可读 ★
             *
             * 浏览器打开 /api/swagger-ui/index.html 是一个**普通的页面导航**，
             * 不带 Authorization 头 —— 若在这里要求登录，返回的会是
             * {"code":401,...} 这段 JSON（本拦截器一律 HTTP 200 + body 码），
             * 于是页面上显示一坨 JSON 而不是文档，看起来像「文档功能坏了」。
             * 同理，Swagger UI 自己要去拉 /v3/api-docs，那也是它发出的 XHR。
             *
             * ★★ 安全边界：放开它等于公开「接口地图」★★
             * 文档会把每个端点的路径、参数、错误码都列出来 —— 对攻击者是免费的侦察资料。
             * 这里只放行 **GET**（本列表只在方法为 GET 时生效），所以「看」可以、「改」不行；
             * 但真正合规的做法是**生产环境把它关掉**，而不是靠这里拦：
             *   springdoc.api-docs.enabled=false
             *   springdoc.swagger-ui.enabled=false
             * 已在 application.yml 里配成可被环境变量覆盖，**靠机制不靠"记得"**。
             * 另外 Swagger UI 的 "Try it out" 默认不带 Authorization 头，
             * 所以它实际只能打通公开接口；需要登录的接口在文档里仍然只是"看一下"。
             */
            "/v3/api-docs",
            "/v3/api-docs/**",
            "/swagger-ui.html",
            "/swagger-ui/**",
            /*
             * ★ 健康检查端点必须匿名可读（P1-5）★
             * Nginx/LB/云监控发起的探测**不带 Authorization 头**；若要求登录，探针收到的是
             * {"code":401,...}，而本项目连这个也是 HTTP 200 ⇒ 探针"看到 200，判定健康"，
             * 于是数据库挂了、服务实际不可用时监控依然全绿 —— 这正是 P1-5 要修的核心问题，
             * 放错位置的鉴权会让修复完全失效。
             * 只放行 GET（本列表只在方法为 GET 时生效）；响应内容见 HealthController 的
             * 「匿名暴露的信息边界」，不含内部地址、路径与异常堆栈。
             */
            "/health"
    );

    /**
     * 任何方法都允许匿名（登录注册 + 登出 + 容器错误页转发）
     * <p>
     * ★ {@code /user/logout} 为什么必须在白名单里（D9）★
     * 登出要做的唯一一件事是让服务端把 HttpOnly Cookie 清掉。
     * 若要求先登录，那么「凭据已经失效 / 账号已被封禁」的用户就**永远退不出去**：
     * 清 Cookie 的请求本身先被 401 拦下，浏览器只好一直带着那张票据。
     * 这是最需要能退出的时刻，恰恰不能设门槛。
     * <p>
     * 放开它不构成风险：该端点不读任何输入、不改任何数据，只是回一个
     * {@code Set-Cookie: Max-Age=0}。最坏情况是有人诱导受害者登出（一个烦人的恶作剧），
     * 而且跨站发起时 {@code SameSite=Lax} 会让浏览器压根不带票，连这点影响也没有。
     */
    private static final List<String> PUBLIC_ANY = List.of(
            "/user/login",
            "/user/logout",
            "/user/register",
            "/error"
    );

    /**
     * 匿名可 POST：渠道支付回调。
     * <p>
     * ★★ 为什么必须放行，以及为什么**只能**放行 POST ★★
     * <p>
     * 支付宝沙箱的异步通知是它的服务器主动打过来的，不会带我们的
     * {@code Authorization} 头 —— 不放进白名单，回调一律 401，
     * 结果是「用户在支付宝里真付了钱，我们的订单永远停在待付款」。
     * 这类故障特别隐蔽：付款页面显示成功、钱也确实扣了，
     * 只是我们自己不知道，且没有任何报错。
     * <p>
     * 代价是这条路径**对全网开放**，所以它的安全性完全押在两处：
     * <ol>
     *   <li>只放行 POST —— GET 不放，避免有人用浏览器直接访问探测；</li>
     *   <li>真正的鉴权在 {@code PayChannel#parseNotify} 的**验签**里，
     *       没有密钥的人伪造不出合法报文。这是唯一可信的一道闸。</li>
     * </ol>
     * 换句话说：这里放开的是「能不能打到」，验签管的是「打了算不算数」。
     * 两者缺一不可，但绝不能因为「反正是公开的」就省掉验签。
     */
    private static final List<String> PUBLIC_POST = List.of(
            "/pay/notify/**"
    );

    /* ------------------------- 角色分区 ------------------------- */

    private static final List<String> ROLE_ADMIN = List.of("admin");
    private static final List<String> ROLE_GOODS_AUDIT = List.of("admin", "goods_admin");
    private static final List<String> ROLE_REPORT_AUDIT = List.of("admin", "report_admin");

    /** 商品审核后台（GoodsAuditController） */
    private static final List<String> GOODS_AUDIT_ZONE = List.of("/review/goods", "/review/goods/**");

    /** 举报处理后台（ContentController 的 /admin/reports* 子集） */
    private static final List<String> REPORT_AUDIT_ZONE = List.of("/admin/reports", "/admin/reports/**");

    /** 其余后台接口：仅全能管理员 */
    private static final List<String> ADMIN_ZONE = List.of("/admin/**");

    private final JwtConfig jwtConfig;

    /**
     * 鉴权快照缓存（P1-11）。
     * <p>
     * 原先这里注入的是 {@code UserMapper}，每个已登录请求直查一次 t_user。
     * 现在改成走这个短 TTL 的本地缓存 —— 语义（以库为准）没有变，
     * 变的是「以库为准」的代价从「每请求一次往返」降到「每用户每 10 秒一次」。
     * <p>
     * ★ 换缓存**不等于**放松撤销 ★：改了 status / role / token_version 的地方
     * 都必须显式失效，否则封禁会退化成「最多慢 10 秒」。
     * 这条契约由 {@code AuthSnapshotCache} 的类注释与它的看守测试负责说明与看守。
     */
    private final AuthSnapshotCache authSnapshotCache;

    public AuthInterceptor(JwtConfig jwtConfig, AuthSnapshotCache authSnapshotCache) {
        this.jwtConfig = jwtConfig;
        this.authSnapshotCache = authSnapshotCache;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        /*
         * ★ 票据来源：优先 HttpOnly Cookie，其次 Authorization 头（D9）★
         *
         * 主通道是 Cookie —— 它由服务端下发、JS 读不到，XSS 拿不走。
         * 保留 Authorization 头作为**第二条通道**，理由是加法式改动的纪律：
         * ① 现有探针、脚本、Swagger「Try it out」都靠它，砍掉等于同时废掉一批验证手段；
         * ② 将来若接入非浏览器客户端，那条路本来就该走头，而不是 Cookie。
         * 两条通道进的是**同一个验签与同一段后续校验**，不存在「某条通道少验了什么」——
         * 这是这里唯一需要守的边界：绝不为了兼容再写一套平行的鉴权逻辑。
         */
        String token = AuthCookie.read(request);
        if (token == null) {
            String auth = request.getHeader("Authorization");
            if (auth != null && auth.startsWith("Bearer ")) {
                token = auth.substring(7);
            }
        }
        boolean loggedIn = false;
        // claims 提到 try 外面声明：下面比 token_version 时还要用它（try 块内声明的作用域出不来）
        Claims claims = null;
        if (token != null) {
            try {
                claims = jwtConfig.parseToken(token);
                request.setAttribute(ATTR_USER_ID, Long.valueOf(claims.getSubject()));
                request.setAttribute(ATTR_USERNAME, claims.get("username", String.class));
                request.setAttribute(ATTR_ROLE, claims.get("role", String.class));
                /*
                 * ★ P1-6：把「谁」补进日志上下文 ★
                 *
                 * traceId / method / uri 已由 {@link com.campus.market.config.RequestTraceFilter}
                 * 在过滤器链最前面写好；「谁」这一项只能在**解析出身份之后**补 ——
                 * 过滤器不参与鉴权，也就不该知道用户是谁。
                 *
                 * 放在这里而不是放到下面「回查数据库」之后，是因为公开路径
                 * （如带 token 访问商品详情）也会走到这一行，那些请求同样需要归属；
                 * 而 `MDC.clear()` 由过滤器在请求结束时统一做（线程复用，不清会串号）。
                 */
                MDC.put(com.campus.market.config.RequestTraceFilter.MDC_UID,
                        String.valueOf(request.getAttribute(ATTR_USER_ID)));
                loggedIn = true;
            } catch (Exception ignored) {
                // token 失效：公开路径继续匿名放行，非公开路径下面统一 401
            }
        }

        String path = pathOf(request);

        if (isPublic(path, request.getMethod())) {
            return true;
        }

        if (!loggedIn) {
            reject(response, 401, "未登录");
            return false;
        }

        /*
         * ★ 以数据库为准，不信 Token 里的快照 ★
         *
         * JWT 是「签发那一刻」的身份快照，签出去之后服务端改不动它。于是：
         *   - 管理员把某人「封禁」了，对方手上的 token 到期前仍然畅通无阻，
         *     登录接口拦得住「新登录」，拦不住「已经登录着的」；
         *   - 管理员把某人从 admin 降权成普通用户，旧 token 里的 role 还是 admin，
         *     后台接口照进不误。
         * 这两条都属于「撤销权限撤不干净」，所以这里每个已登录请求都要拿到
         * 库里的 status / role 覆盖 Token 里的值。
         *
         * ★ 代价从「每请求一次主键查询」降到「每用户每 10 秒一次」（P1-11）★
         * 读的是同一行的三个几乎不变的字段，是典型读多写极少，所以交给
         * {@link AuthSnapshotCache} 托管。注意这里的语义**没有变**：
         * 仍然是「以库为准、不信 token」，只是「库」变成了「最多 10 秒前的库」。
         * 两者的差距由两道保障压到可接受：改这三个列的 6 个写入点全部显式失效
         * （立即生效），TTL 只作为「万一漏了」的兜底。
         * 别把这段逻辑挪回直查 UserMapper —— 那会退回每请求一次往返的老问题。
         */
        Optional<AuthSnapshotCache.Snapshot> found =
                authSnapshotCache.get((Long) request.getAttribute(ATTR_USER_ID));
        if (found.isEmpty()) {
            reject(response, 401, "账号不存在，请重新登录");
            return false;
        }
        AuthSnapshotCache.Snapshot current = found.get();
        if (current.isBanned()) {
            // 用 401 而不是 403：前端收到 401 会弹「登录状态已过期」并清 token 跳登录页，
            // 这正是被踢下线应有的表现。
            reject(response, 401, "账号已被封禁，请联系管理员");
            return false;
        }
        request.setAttribute(ATTR_ROLE, current.role());

        /*
         * ★ token_version 比对：补上「撤销」的最后一块短板 ★
         *
         * 上面回查 t_user 已经能兜住「封禁 / 降权」的撤销，但**改密码撤销不了**：
         * 密码换掉了，旧令牌里的身份快照没有任何变化，24 小时内照样畅通 ——
         * 「怀疑账号被盗 → 赶紧改密码」这个最常用的自救动作等于白做。
         *
         * 现在登录时把用户的 token_version 写进 token 的 ver 声明，
         * 改密码 / 被管理员重置时把它 +1。这里一比：
         *   ver(令牌签发时)  !=  t_user.token_version(现在)  →  该令牌已作废。
         * 升级前签发的令牌没有 ver 声明，tokenVersionOf 返回 0，
         * 与库里的默认值 0 相等，所以这次发版不会把在线用户全部踢下线。
         *
         * 同样用 401 而不是 403：前端收到 401 会清 token 并跳登录页，
         * 正是「你的凭证失效了，请重新登录」应有的表现。
         */
        int dbTokenVersion = current.tokenVersion();
        if (jwtConfig.tokenVersionOf(claims) != dbTokenVersion) {
            reject(response, 401, "登录状态已失效，请重新登录");
            return false;
        }

        if (!isRoleAllowed(path, current.role())) {
            reject(response, 403, "无权限访问该接口");
            return false;
        }
        return true;
    }

    /** 去掉 contextPath 后的请求路径 */
    private String pathOf(HttpServletRequest request) {
        String path = request.getRequestURI();
        String ctx = request.getContextPath();
        if (ctx != null && !ctx.isEmpty() && path.startsWith(ctx)) {
            path = path.substring(ctx.length());
        }
        return path;
    }

    /** 按「方法 + 路径」判定是否公开 */
    private boolean isPublic(String path, String method) {
        for (String p : PUBLIC_ANY) {
            if (MATCHER.match(p, path)) return true;
        }
        if ("POST".equalsIgnoreCase(method)) {
            for (String p : PUBLIC_POST) {
                if (MATCHER.match(p, path)) return true;
            }
        }
        if (!"GET".equalsIgnoreCase(method)) return false;
        for (String p : PUBLIC_GET) {
            if (MATCHER.match(p, path)) return true;
        }
        return false;
    }

    /**
     * 角色判定。先看更宽松的审核子域，再看 {@code /admin/**} 兜底 ——
     * 顺序不能反：{@code /admin/reports/**} 同样命中 {@code /admin/**}，
     * 若先判兜底，{@code report_admin} 会被自己的后台挡在门外。
     * <p>
     * 非后台路径（{@code /orders/**}、{@code /user/**}、{@code /messages/**} 等）
     * 只要登录即可，归属校验由各 Service 按 userId 负责。
     */
    private boolean isRoleAllowed(String path, String role) {
        if (matchAny(GOODS_AUDIT_ZONE, path)) return contains(ROLE_GOODS_AUDIT, role);
        if (matchAny(REPORT_AUDIT_ZONE, path)) return contains(ROLE_REPORT_AUDIT, role);
        if (matchAny(ADMIN_ZONE, path)) return contains(ROLE_ADMIN, role);
        return true;
    }

    private boolean matchAny(List<String> patterns, String path) {
        for (String p : patterns) {
            if (MATCHER.match(p, path)) return true;
        }
        return false;
    }

    private boolean contains(List<String> roles, String role) {
        return role != null && roles.contains(role);
    }

    /**
     * 拒绝请求：返回 **HTTP 200 + body 业务码**，与 {@code GlobalExceptionHandler}
     * 的约定保持一致。
     * <p>
     * ★ 这里不能用 HTTP 401 / 403 状态码 ★
     * <p>
     * 前端 {@code api/request.ts} 是按「HTTP 200 + body.code」写的：cookie 之外的所有
     * 业务错误都从 {@code res.code} 判定。axios 默认把非 2xx 丢进 **error 分支**，
     * 而 error 分支里只认 404 / >=500 / 网络错误，其余统一
     * {@code ElMessage.error(err.message)} —— 也就是弹出
     * 「Request failed with status code 401」这种英文乱码。
     * 结果就是前端精心写好的两条分支永远走不到：
     * <ul>
     *   <li>{@code code === 401} → 弹「登录状态已过期，请重新登录」并 logout 跳 /login</li>
     *   <li>{@code code === 403} → 弹「您没有该操作权限」</li>
     * </ul>
     * 既然全局异常处理已经把业务错误码塞在 body 里走 200，认证层就不该另搞一套。
     */
    private void reject(HttpServletResponse response, int code, String message) throws java.io.IOException {
        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"code\":" + code + ",\"message\":\"" + message + "\",\"data\":null}");
    }
}
