package com.campus.market.controller;

import com.campus.market.config.JwtConfig;
import com.campus.market.security.AuthCookie;
import com.campus.market.service.GoodsService;
import com.campus.market.service.UserService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 票据的**签发与撤销接线**（D9）—— 即「谁负责把 Cookie 写上/清掉」。
 *
 * <h3>★ 为什么机制测试（{@code AuthCookieTest}）之外还要有这一个 ★</h3>
 * {@code AuthCookie.write()} 写得再对，只要**没有任何地方调用它**，
 * 整条改造就是零效果：前端从此不带 Authorization 头、服务端也从不发 Cookie，
 * 结果是「所有人都登录不上」——或者更糟，测试全绿而真机全线 401。
 * 所以这里走一遍真实的控制器方法，断言浏览器实实在在收到了那条 {@code Set-Cookie}。
 *
 * <h3>★ 登出为什么必须单独钉 ★</h3>
 * 换成 HttpOnly 之后，「前端自己删 token」这条免费能力没有了。
 * 没有服务端的清票端点，用户点「退出登录」只清空前端 store，
 * 浏览器仍带着有效票据 —— 一刷新又回来了。而这条**不会在种子里报错**，
 * 只有真人操作才发现，所以必须由用例守住。
 */
class UserAuthCookieTest {

    private static final String TOKEN = "header.payload.sig";
    private static final long ONE_DAY_MS = 86_400_000L;

    private UserService userService;
    private UserController controller;

    @BeforeEach
    void setUp() {
        userService = mock(UserService.class);
        JwtConfig jwtConfig = mock(JwtConfig.class);
        when(jwtConfig.getExpiration()).thenReturn(ONE_DAY_MS);
        controller = new UserController(userService, mock(GoodsService.class), jwtConfig);
    }

    private static String onlySetCookie(MockHttpServletResponse resp) {
        assertEquals(1, resp.getHeaders("Set-Cookie").size(),
                "应当恰好下发一条 Cookie，实得 " + resp.getHeaders("Set-Cookie"));
        return resp.getHeaders("Set-Cookie").get(0);
    }

    @Test
    @DisplayName("登录成功下发票据：HttpOnly + Max-Age 跟随 jwt.expiration")
    void loginIssuesSessionCookie() {
        when(userService.login(anyString(), anyString(), anyString()))
                .thenReturn(Map.of("token", TOKEN, "user", Map.of("id", 1)));
        MockHttpServletRequest req = new MockHttpServletRequest();
        MockHttpServletResponse resp = new MockHttpServletResponse();

        controller.login(Map.of("username", "tom", "password", "secret1"), req, resp);

        String c = onlySetCookie(resp);
        assertTrue(c.startsWith(AuthCookie.NAME + "=" + TOKEN), "Cookie 名/值不对：" + c);
        assertTrue(c.contains("HttpOnly"), "★ 少了 HttpOnly，D9 等于没做：" + c);
        assertTrue(c.contains("Max-Age=" + (ONE_DAY_MS / 1000)),
                "Max-Age 必须与 token 同源，否则会出现「Cookie 还在、token 已过期」：" + c);
    }

    @Test
    @DisplayName("注册即登录：注册也要下发票据（否则新用户注册完第一个请求就是未登录）")
    void registerIssuesSessionCookie() {
        when(userService.register(anyString(), anyString(), anyString()))
                .thenReturn(Map.of("token", TOKEN, "user", Map.of("id", 2)));
        MockHttpServletRequest req = new MockHttpServletRequest();
        MockHttpServletResponse resp = new MockHttpServletResponse();

        controller.register(Map.of("username", "newbie", "password", "secret1", "nickname", "新人"), req, resp);

        assertTrue(onlySetCookie(resp).contains("HttpOnly"));
    }

    @Test
    @DisplayName("登出清票：Max-Age=0，且**不要求已登录**（会话失效时更要能退出去）")
    void logoutClearsCookieWithoutRequiringLogin() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        MockHttpServletResponse resp = new MockHttpServletResponse();

        // 刻意不带任何凭据调用 —— 这正是「被封禁/已过期」用户点退出时的真实形态
        controller.logout(req, resp);

        String c = onlySetCookie(resp);
        assertTrue(c.startsWith(AuthCookie.NAME + "="), "必须是同名 Cookie：" + c);
        assertTrue(c.contains("Max-Age=0"), "必须立即过期，否则刷新还会回到登录态：" + c);
    }

    @Test
    @DisplayName("登录失败不下发票据（服务层抛异常时不该留下半张票）")
    void failedLoginIssuesNothing() {
        when(userService.login(anyString(), anyString(), anyString()))
                .thenThrow(new RuntimeException("用户名或密码错误"));
        MockHttpServletRequest req = new MockHttpServletRequest();
        MockHttpServletResponse resp = new MockHttpServletResponse();

        try {
            controller.login(Map.of("username", "tom", "password", "bad"), req, resp);
        } catch (RuntimeException ignored) {
            // 全局异常处理器会把它翻成业务码；这里只关心有没有误发票据
        }

        assertEquals(0, resp.getHeaders("Set-Cookie").size(),
                "登录失败却发了 Cookie，等于给了对方一张无效但存在的票");
    }
}
