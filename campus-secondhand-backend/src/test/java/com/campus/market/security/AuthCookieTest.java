package com.campus.market.security;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 会话票据的 HttpOnly Cookie 通道（D9）。
 *
 * <h3>★★ 这个类守的是什么 ★★</h3>
 * D9 要修的是「凭据落在 JS 能读到的地方」。所以这里逐条钉住的不是「代码写了什么」，
 * 而是**浏览器实际收到的那些属性**：
 * <ul>
 *   <li>{@code HttpOnly} —— 少这一个，整个改造就白做了（凭据又回到 JS 手里），
 *       而且功能上完全正常、没有任何报错，只在安全评审时才看得出来；</li>
 *   <li>{@code SameSite=Lax} —— 少了它 Cookie 会被跨站请求带上，引入 CSRF；</li>
 *   <li>{@code Path=/} —— 少了它（或写成别的路径），
 *       会出现「登录成功但下一个请求未登录」这种最难查的形态；</li>
 *   <li>{@code Max-Age} 与 token 同源 —— 漂移会导致「Cookie 还在、token 已过期」；</li>
 *   <li>登出必须用 <b>同名同路径</b> 的 {@code Max-Age=0} ——
 *       属性不一致就是「删了个不存在的 Cookie」，用户点了退出刷新又回来。</li>
 * </ul>
 */
class AuthCookieTest {

    private static final String TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.sig";
    private static final long ONE_DAY_MS = 86_400_000L;

    private static String setCookieHeader(MockHttpServletResponse resp) {
        List<String> all = resp.getHeaders("Set-Cookie");
        assertNotNull(all, "响应里没有 Set-Cookie 头");
        assertEquals(1, all.size(), "一次只应下发一条会话 Cookie，实得 " + all);
        return all.get(0);
    }

    @Test
    @DisplayName("下发：HttpOnly + SameSite=Lax + Path=/ + Max-Age 与 token 同源")
    void writeSetsTheAttributesThatMakeItSafeAndUsable() {
        MockHttpServletResponse resp = new MockHttpServletResponse();

        AuthCookie.write(resp, TOKEN, ONE_DAY_MS, true);

        String c = setCookieHeader(resp);
        assertTrue(c.startsWith(AuthCookie.NAME + "=" + TOKEN), "Cookie 名与值不对：" + c);
        assertTrue(c.contains("HttpOnly"), "★ 少了 HttpOnly，凭据就回到 JS 手里了：" + c);
        assertTrue(c.contains("SameSite=Lax"), "★ 少了 SameSite=Lax 会引入 CSRF：" + c);
        assertTrue(c.contains("Path=/"), "Path 不对会导致「登录成功但下个请求未登录」：" + c);
        assertTrue(c.contains("Max-Age=" + (ONE_DAY_MS / 1000)),
                "Max-Age 必须与 token 有效期同源，实得：" + c);
        assertTrue(c.contains("Secure"), "HTTPS 下必须带 Secure：" + c);
    }

    @Test
    @DisplayName("本地 HTTP 下不能带 Secure —— 否则浏览器直接丢弃，表现为「登录成功却未登录」")
    void httpDoesNotMarkSecure() {
        MockHttpServletResponse resp = new MockHttpServletResponse();

        AuthCookie.write(resp, TOKEN, ONE_DAY_MS, false);

        String c = setCookieHeader(resp);
        assertTrue(c.contains("HttpOnly"), "HttpOnly 与协议无关，必须始终在：" + c);
        assertTrue(!c.contains("Secure"),
                "HTTP 下带 Secure 会被浏览器丢弃，且没有任何报错：" + c);
    }

    @Test
    @DisplayName("登出：同名同路径 + Max-Age=0（属性不一致就删不掉）")
    void clearExpiresTheSameCookie() {
        MockHttpServletResponse resp = new MockHttpServletResponse();

        AuthCookie.clear(resp, false);

        String c = setCookieHeader(resp);
        assertTrue(c.startsWith(AuthCookie.NAME + "="), "必须是同名 Cookie：" + c);
        assertTrue(c.contains("Path=/"), "路径必须与下发时一致，否则删不掉：" + c);
        assertTrue(c.contains("Max-Age=0"), "登出必须立即过期：" + c);
    }

    @Test
    @DisplayName("读取：只认本 Cookie；缺失/空值返回 null（不是空串，避免下游拿到空票去验签）")
    void readPicksOnlyOurCookie() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        assertNull(AuthCookie.read(req), "没有 Cookie 时应返回 null");

        req.setCookies(new Cookie("other", "x"));
        assertNull(AuthCookie.read(req), "不应认别人的 Cookie");

        req.setCookies(new Cookie(AuthCookie.NAME, ""));
        assertNull(AuthCookie.read(req), "空值等同于没有");

        req.setCookies(new Cookie(AuthCookie.NAME, TOKEN));
        assertEquals(TOKEN, AuthCookie.read(req));
    }

    @Test
    @DisplayName("读取：同名多条时固定取第一条（客户端自造形态，行为必须可预期）")
    void readTakesTheFirstWhenDuplicated() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setCookies(new Cookie(AuthCookie.NAME, "first"),
                new Cookie(AuthCookie.NAME, "second"));

        assertEquals("first", AuthCookie.read(req));
    }

    @Test
    @DisplayName("空 token 不下发（宁可不给，也不要给一张空票）")
    void blankTokenIsNotWritten() {
        MockHttpServletResponse resp = new MockHttpServletResponse();
        AuthCookie.write(resp, "", ONE_DAY_MS, false);
        AuthCookie.write(resp, null, ONE_DAY_MS, false);

        assertEquals(0, resp.getHeaders("Set-Cookie").size(), "空 token 不应产生 Set-Cookie");
    }
}
