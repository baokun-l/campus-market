package com.campus.market.security;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;

import java.time.Duration;

/**
 * 会话票据的 HttpOnly Cookie 通道（部署适配清单 D9）。
 *
 * <h3>★★ 要修的是什么 ★★</h3>
 * 原先 JWT 由前端写进 {@code localStorage}（{@code stores/modules/user.ts} 的
 * {@code persist.paths=['token']}）。这有一个不会报错的后果：
 * <b>页面上任何一段脚本都能把它读走</b>。一次 XSS（第三方脚本、评论里塞的
 * {@code <img onerror>}、被投毒的依赖）就能把 24 小时有效的凭据静默带出去，
 * 攻击者换一台机器照样能用 —— 而用户直到令牌过期都毫无察觉。
 * <p>
 * 所以凭据改为走 <b>HttpOnly Cookie</b>：浏览器自动携带，JS 读不到。
 * 前端连「读 token」这个动作都不再需要。
 *
 * <h3>★ 为什么走 Cookie 不会把 CSRF 引进来 ★</h3>
 * Cookie 会被自动带上，这正是 CSRF 的成因。这里用 {@code SameSite=Lax} 兜住：
 * 跨站发起的 POST/PUT/PATCH/DELETE <b>不会</b>带上本 Cookie，
 * 而本项目的写操作全部是这些方法（GET 只读）。于是「诱导点击」这条路径被浏览器自己掐断，
 * 不需要再自己实现一套 CSRF token —— 少一套机制，就少一处「忘了接」的角落。
 * <p>
 * （若哪天要支持跨站 POST，就必须补 CSRF token，届时这条 {@code SameSite=Lax} 的
 * 保护会在改动中被静默削弱，所以写在这里。）
 *
 * <h3>★ 为什么 Secure 由请求自己判断，而不是做成配置项 ★</h3>
 * 本地开发走 {@code http://}，带 {@code Secure} 的 Cookie 会被浏览器直接丢弃 ——
 * 表现是「登录接口返回成功、下一个请求却是未登录」，且没有任何报错。
 * 做成配置项就等于把这个坑交给运维去踩。
 * 所以按 {@code request.isSecure()} 自动决定：HTTPS 下自动加 Secure，
 * HTTP 下自动不加。本项目已配 {@code server.forward-headers-strategy=framework}，
 * 反代终止 TLS 时 {@code isSecure()} 也能正确识别。
 * 判断失误的方向是「HTTP 下少一个 Secure 标记」（仍可用），而不是「HTTPS 下登录不了」。
 *
 * <h3>★ Max-Age 必须与 token 的过期时间同源 ★</h3>
 * 取 {@code JwtConfig#getExpiration()}，不另设一个常量：
 * 两者一旦漂移，就会出现「Cookie 还在、token 已过期」或反过来的错位状态，
 * 而前端此时已经不再持有 token，无从自证，表现是「莫名其妙要求重新登录」。
 */
public final class AuthCookie {

    /**
     * Cookie 名。带项目前缀，避免与同一域名下的其它应用撞名
     * （撞名的后果是两边互相覆盖，且都只表现为「偶尔登录不上」）。
     */
    public static final String NAME = "c2c-token";

    private AuthCookie() {
    }

    /**
     * 下发会话 Cookie。
     *
     * @param token          JWT 原文
     * @param maxAgeMillis   有效期，与 token 一致
     * @param secure         是否只在 HTTPS 下回传（由 {@code request.isSecure()} 决定）
     */
    public static void write(HttpServletResponse response, String token, long maxAgeMillis, boolean secure) {
        if (response == null || token == null || token.isEmpty()) {
            return;
        }
        String header = ResponseCookie.from(NAME, token)
                .httpOnly(true)
                .secure(secure)
                .sameSite("Lax")
                .path("/")
                .maxAge(Duration.ofMillis(Math.max(0, maxAgeMillis)))
                .build()
                .toString();
        response.addHeader(HttpHeaders.SET_COOKIE, header);
    }

    /**
     * 清除会话 Cookie（登出）。
     * <p>
     * ★ 必须由服务端来做 ★：HttpOnly 意味着前端**没有能力**删掉它。
     * 这不是缺陷，正是这道机制的要点 —— 没有这个端点，用户点「退出登录」之后
     * 一刷新就又回来了（前端 store 被清空，但请求仍带着有效 Cookie）。
     * <p>
     * 清空用 {@code Max-Age=0} + 同名同路径，浏览器会立刻丢弃。
     * 属性必须与下发时一致（Path 尤其重要），否则会「删了个不存在的 Cookie」。
     */
    public static void clear(HttpServletResponse response, boolean secure) {
        if (response == null) {
            return;
        }
        String header = ResponseCookie.from(NAME, "")
                .httpOnly(true)
                .secure(secure)
                .sameSite("Lax")
                .path("/")
                .maxAge(Duration.ZERO)
                .build()
                .toString();
        response.addHeader(HttpHeaders.SET_COOKIE, header);
    }

    /**
     * 取出请求里的会话票据，没有则返回 {@code null}。
     * <p>
     * 只认第一个同名 Cookie：同名多条是客户端自己造的，不是合法形态，
     * 与其挑一个不如固定取第一个，保证行为可预期。
     */
    public static String read(HttpServletRequest request) {
        if (request == null) {
            return null;
        }
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie c : cookies) {
            if (NAME.equals(c.getName())) {
                String v = c.getValue();
                return (v == null || v.isEmpty()) ? null : v;
            }
        }
        return null;
    }
}
