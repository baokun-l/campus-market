package com.campus.market.interceptor;

import com.campus.market.config.JwtConfig;
import com.campus.market.entity.User;
import com.campus.market.mapper.UserMapper;
import com.campus.market.security.AuthCookie;
import com.campus.market.security.AuthSnapshotCache;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 拦截器**在真实请求路径上**真的用上了鉴权快照缓存（P1-11）。
 *
 * <h3>★★ 为什么非要有这个类：它补的是一个判据缺口 ★★</h3>
 * {@link AuthSnapshotCacheTest} 证明的是「缓存对象本身按预期工作」，
 * {@link com.campus.market.service.AuthCacheInvalidationTest} 证明的是「改了鉴权列会清缓存」。
 * 但两者都没有回答最要紧的那个问题：**拦截器到底有没有走缓存？**
 * 如果把 {@code preHandle} 改回「每请求直查 UserMapper」，上面两个类**全绿**，
 * 而 P1-11 要修的东西（每请求一次主键查询）原样回来了 —— 典型的「用例绿、能力没了」。
 * <p>
 * 所以这里用真的 {@link MockHttpServletRequest} 走完整 {@code preHandle}，
 * 断言落点只有一个：**同一个用户连打两个接口，只应该回源一次数据库**。
 * 这条断言一旦红，说明「拦截器经过缓存」这件事不再成立，与缓存内部实现无关。
 *
 * <h3>顺带钉住换缓存时最容易丢的两件事</h3>
 * 一是**撤销**（banned / token_version 不匹配要当场 401，不能因为走了缓存就放过），
 * 二是**角色分区**（{@code role} 现在是快照里取的，别在改造中把 {@code isRoleAllowed} 漏掉）。
 * 它们都是「换了数据来源、判据跟着旧来源写」时容易被静默改坏的地方。
 */
class AuthInterceptorSnapshotTest {

    private static final long USER_ID = 42L;

    private JwtConfig jwtConfig;
    private UserMapper userMapper;
    private AuthInterceptor interceptor;

    @BeforeEach
    void setUp() {
        jwtConfig = mock(JwtConfig.class);
        userMapper = mock(UserMapper.class);
        // 真缓存 + 假 JwtConfig：这样「查了几次库」完全由缓存行为决定
        interceptor = new AuthInterceptor(jwtConfig, new AuthSnapshotCache(userMapper));

        Claims claims = mock(Claims.class);
        when(claims.getSubject()).thenReturn(String.valueOf(USER_ID));
        when(jwtConfig.parseToken("tok")).thenReturn(claims);
        when(jwtConfig.tokenVersionOf(any())).thenReturn(0);
    }

    @AfterEach
    void tearDown() {
        // MDC 是 ThreadLocal：本类直接调 preHandle，没有那个负责清理的过滤器，得自己收尾
        MDC.clear();
    }

    private void givenRow(String status, String role, Integer tokenVersion) {
        User u = new User();
        u.setId(USER_ID);
        u.setUsername("tom");
        u.setNickname("汤姆");
        u.setStatus(status);
        u.setRole(role);
        u.setTokenVersion(tokenVersion);
        when(userMapper.selectById(USER_ID)).thenReturn(u);
    }

    /** 一个「已登录、命中非公开路径」的请求 */
    private MockHttpServletRequest request(String uri) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", uri);
        r.setContextPath("/api");
        r.setRequestURI(uri);
        r.addHeader("Authorization", "Bearer tok");
        return r;
    }

    private MockHttpServletRequest request() {
        return request("/api/orders/mine");
    }

    @Test
    @DisplayName("同一用户连打两个接口，只回源一次 —— 拦截器确实走了缓存（P1-11 的核心判据）")
    void twoRequestsShareOneSnapshot() throws Exception {
        givenRow("active", "user", 0);

        assertTrue(interceptor.preHandle(request(), new MockHttpServletResponse(), new Object()));
        assertTrue(interceptor.preHandle(request(), new MockHttpServletResponse(), new Object()));

        verify(userMapper, times(1)).selectById(USER_ID);
    }

    @Test
    @DisplayName("库里是 banned：当场拒绝、回 401，HTTP 状态码仍是 200（既定契约）")
    void bannedSnapshotIsRejected() throws Exception {
        givenRow("banned", "user", 0);
        MockHttpServletResponse resp = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request(), resp, new Object()));

        assertEquals(200, resp.getStatus(), "本项目所有业务错误一律 HTTP 200 + body 业务码");
        assertTrue(resp.getContentAsString().contains("\"code\":401"),
                "被封禁必须 401（前端据此登出跳登录页），实际响应体：" + resp.getContentAsString());
    }

    @Test
    @DisplayName("令牌里的 ver 落后于库：旧令牌当场作废（不靠 TTL 兜）")
    void staleTokenVersionIsRejected() throws Exception {
        givenRow("active", "user", 1); // 库里已 +1（用户刚改完密码）
        when(jwtConfig.tokenVersionOf(any())).thenReturn(0); // 手上令牌还是签发时的 0
        MockHttpServletResponse resp = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request(), resp, new Object()));
        assertTrue(resp.getContentAsString().contains("\"code\":401"),
                "改密之后旧令牌必须当次请求即失效，实际响应体：" + resp.getContentAsString());
    }

    @Test
    @DisplayName("角色分区没在换缓存时被丢掉：普通用户进不了 /admin/**")
    void roleZoneStillEnforced() throws Exception {
        givenRow("active", "user", 0);
        MockHttpServletResponse resp = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request("/api/admin/users"), resp, new Object()));
        assertTrue(resp.getContentAsString().contains("\"code\":403"),
                "角色是从快照里取的，别在改造中断了这条判定，实际响应体：" + resp.getContentAsString());
    }

    @Test
    @DisplayName("账号不存在：负缓存路径也要回 401，而不是 500")
    void unknownAccountIsRejected() throws Exception {
        when(userMapper.selectById(USER_ID)).thenReturn(null);
        MockHttpServletResponse resp = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request(), resp, new Object()));
        assertTrue(resp.getContentAsString().contains("\"code\":401"),
                "删号后手上的旧 token 应当 401，实际响应体：" + resp.getContentAsString());
    }

    /* ==================== D9：票据来源 ==================== */

    /** 只带 Cookie、不带 Authorization 头的请求（真实浏览器在新方案下的常态） */
    private MockHttpServletRequest cookieRequest(String cookieValue) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", "/api/orders/mine");
        r.setContextPath("/api");
        r.setRequestURI("/api/orders/mine");
        r.setCookies(new Cookie(AuthCookie.NAME, cookieValue));
        return r;
    }

    @Test
    @DisplayName("★ 只带 Cookie 就能鉴权 —— 这是 D9 改造后的主通道（前端不再发 Authorization 头）")
    void cookieOnlyRequestAuthenticates() throws Exception {
        givenRow("active", "user", 0);

        assertTrue(interceptor.preHandle(cookieRequest("tok"), new MockHttpServletResponse(), new Object()),
                "Cookie 通道不通，真机上就是「登录成功但每个接口都 401」");
    }

    @Test
    @DisplayName("对照：两条通道都没有凭据时必须 401（防「谁都没走还放行」）")
    void noCredentialIsRejected() throws Exception {
        givenRow("active", "user", 0);
        MockHttpServletRequest r = new MockHttpServletRequest("GET", "/api/orders/mine");
        r.setContextPath("/api");
        r.setRequestURI("/api/orders/mine");
        MockHttpServletResponse resp = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(r, resp, new Object()));
        assertTrue(resp.getContentAsString().contains("\"code\":401"));
    }

    @Test
    @DisplayName("Cookie 优先于 Authorization 头：头里是垃圾票也不能把合法 Cookie 会话拖下水")
    void cookieTakesPriorityOverHeader() throws Exception {
        givenRow("active", "user", 0);
        MockHttpServletRequest r = cookieRequest("tok");
        r.addHeader("Authorization", "Bearer 垃圾票");

        assertTrue(interceptor.preHandle(r, new MockHttpServletResponse(), new Object()),
                "若实现改成「头优先」，这条会红 —— 那种实现在浏览器场景下会把主通道废掉");
    }

    @Test
    @DisplayName("Cookie 里的票同样要过封禁与 token_version 校验（新通道不许少验）")
    void cookieTicketIsSubjectToTheSameRevocationChecks() throws Exception {
        givenRow("banned", "user", 0);
        MockHttpServletResponse resp = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(cookieRequest("tok"), resp, new Object()),
                "★ 两条通道必须进同一段校验；出现「Cookie 通道少验一层」就等于撤销被绕过");
        assertTrue(resp.getContentAsString().contains("\"code\":401"));
    }
}
