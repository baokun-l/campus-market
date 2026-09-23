package com.campus.market.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * P1-6（请求上下文进日志）的守卫用例。
 * <p>
 * 这些断言锁的都是「**看起来正常、其实没用**」的形态：
 * <ul>
 *   <li>traceId 不合法却原样进了日志 ⇒ 攻击者可以伪造日志行（日志注入）；</li>
 *   <li>结束时不清 MDC ⇒ 线程复用导致下一个请求的日志顶着上一个请求的身份
 *       （本地单请求几乎复现不出，只在并发下出错）；</li>
 * </ul>
 * 两类都不会报错、不会让任何功能不可用，所以只能靠用例钉住。
 */
class RequestTraceFilterTest {

    private final RequestTraceFilter filter = new RequestTraceFilter();

    @AfterEach
    void clearMdc() {
        // 用例之间互相污染会让"MDC 被清干净了"这条断言变成随机通过，必须显式兜底
        MDC.clear();
    }

    /** 记录链条执行期间 MDC 的快照，用来断言「请求处理过程中上下文是可用的」 */
    private static FilterChain capture(AtomicReference<String> trace, AtomicReference<String> uid,
                                       AtomicReference<String> method, AtomicReference<String> uri) {
        return (req, res) -> {
            trace.set(MDC.get(RequestTraceFilter.MDC_TRACE_ID));
            uid.set(MDC.get(RequestTraceFilter.MDC_UID));
            method.set(MDC.get(RequestTraceFilter.MDC_METHOD));
            uri.set(MDC.get(RequestTraceFilter.MDC_URI));
        };
    }

    private static FilterChain noop() {
        return (req, res) -> { };
    }

    @Test
    @DisplayName("没有带 X-Request-Id 时自己生成，并把 id 放进上下文、回写响应头")
    void generatesTraceIdWhenHeaderAbsent() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/goods");
        MockHttpServletResponse res = new MockHttpServletResponse();

        AtomicReference<String> seen = new AtomicReference<>();
        AtomicReference<String> method = new AtomicReference<>();
        AtomicReference<String> uri = new AtomicReference<>();
        filter.doFilter(req, res, capture(seen, new AtomicReference<>(), method, uri));

        assertNotNull(seen.get(), "请求处理期间必须能取到 traceId");
        assertTrue(seen.get().matches("[0-9a-f]{16}"), "自生成的 traceId 应为 16 位十六进制，实际=" + seen.get());
        assertEquals(seen.get(), res.getHeader(RequestTraceFilter.TRACE_HEADER),
                "响应头必须回写同一个 id —— 否则用户报障时给不出可检索的锚点");
        assertEquals("GET", method.get());
        assertEquals("/api/goods", uri.get());
    }

    @Test
    @DisplayName("调用方传了合法 id 就沿用（Nginx $request_id 透传后两层共用一个 id）")
    void reusesLegalIncomingTraceId() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/orders");
        req.addHeader(RequestTraceFilter.TRACE_HEADER, "6f1a2b3c4d5e6f70");
        MockHttpServletResponse res = new MockHttpServletResponse();

        AtomicReference<String> seen = new AtomicReference<>();
        filter.doFilter(req, res, capture(seen, new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>()));

        assertEquals("6f1a2b3c4d5e6f70", seen.get());
        assertEquals("6f1a2b3c4d5e6f70", res.getHeader(RequestTraceFilter.TRACE_HEADER));
    }

    @Test
    @DisplayName("★ 非法 X-Request-Id 一律丢弃并重新生成（防日志注入）★")
    void rejectsIllegalIncomingTraceId() throws Exception {
        // 每个都对应一种真实攻击/踩坑形态，不是凑数：
        //  ① 换行 ⇒ 凭空伪造一整行日志（例如伪造 "ERROR 支付失败" 让值班的人去查不存在的事故）
        //  ② 空格 / ③ 太短 / ④ 超长 / ⑤ 非 ASCII ⇒ 污染日志可读性、撑爆日志文件
        String[] illegal = {
                "abc12345\r\n2026-09-22 ERROR 支付失败",
                "abc 12345",
                "short",
                "x".repeat(65),
                "traceId-中文-1234",
                "abc12345\t9"
        };

        for (String bad : illegal) {
            MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/goods");
            req.addHeader(RequestTraceFilter.TRACE_HEADER, bad);
            MockHttpServletResponse res = new MockHttpServletResponse();

            AtomicReference<String> seen = new AtomicReference<>();
            filter.doFilter(req, res, capture(seen, new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>()));

            assertNotEquals(bad, seen.get(), "非法值不得进入日志上下文：" + bad);
            assertTrue(seen.get().matches("[0-9a-f]{16}"), "应换成自生成的合法 id，实际=" + seen.get());
            assertFalse(seen.get().contains("\r") || seen.get().contains("\n"),
                    "上下文里绝不能出现换行（日志注入的必要成分）");
            assertNotEquals(bad, res.getHeader(RequestTraceFilter.TRACE_HEADER),
                    "非法值也不该被回写到响应头（响应头注入）");
        }
    }

    @Test
    @DisplayName("★★ 请求结束后 MDC 必须清空（线程复用会把上下文串到下一个请求上）★★")
    void clearsMdcAfterRequest() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/goods");
        req.addHeader(RequestTraceFilter.TRACE_HEADER, "aaaa1111bbbb2222");
        filter.doFilter(req, new MockHttpServletResponse(), noop());

        assertNull(MDC.get(RequestTraceFilter.MDC_TRACE_ID), "traceId 未清理 ⇒ 下一个请求的日志会顶着别人的 id");
        assertNull(MDC.get(RequestTraceFilter.MDC_URI), "uri 未清理");
        assertNull(MDC.get(RequestTraceFilter.MDC_METHOD), "method 未清理");
    }

    @Test
    @DisplayName("★ 抛异常时也必须清空（清理写在 finally 里，不是正常路径的尾巴）★")
    void clearsMdcEvenWhenChainThrows() {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/goods");
        FilterChain boom = (rq, rs) -> {
            throw new ServletException("模拟下游炸了");
        };

        assertThrows(ServletException.class, () -> filter.doFilter(req, new MockHttpServletResponse(), boom));
        assertNull(MDC.get(RequestTraceFilter.MDC_TRACE_ID),
                "异常路径漏清 ⇒ 该线程被复用后，下个请求的日志带着本次的 traceId");
    }

    @Test
    @DisplayName("URI 去掉控制字符并截断（URI 不能白名单校验，但换行必须挡掉）")
    void sanitizesUri() throws Exception {
        String evil = "/api/goods\r\n2026-09-22 ERROR 伪造的一行";
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/goods");
        req.setRequestURI(evil);
        AtomicReference<String> uri = new AtomicReference<>();
        filter.doFilter(req, new MockHttpServletResponse(), capture(new AtomicReference<>(), new AtomicReference<>(),
                new AtomicReference<>(), uri));

        assertNotNull(uri.get());
        assertFalse(uri.get().contains("\r") || uri.get().contains("\n"), "URI 里的换行必须被过滤，实际=" + uri.get());

        // 超长 URI：一次探测/攻击可能带 8KB 路径，原样写进日志会把真实日志挤出可视范围
        MockHttpServletRequest longReq = new MockHttpServletRequest("GET", "/api/goods");
        longReq.setRequestURI("/api/goods/" + "a".repeat(500));
        AtomicReference<String> longUri = new AtomicReference<>();
        filter.doFilter(longReq, new MockHttpServletResponse(), capture(new AtomicReference<>(), new AtomicReference<>(),
                new AtomicReference<>(), longUri));
        assertTrue(longUri.get().length() <= 200, "超长 URI 必须截断，实际长度=" + longUri.get().length());
    }

    @Test
    @DisplayName("过滤器不自己填 uid —— 「谁」只能由鉴权环节补（职责边界）")
    void doesNotInventUserId() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/goods");
        AtomicReference<String> uid = new AtomicReference<>("unset");
        filter.doFilter(req, new MockHttpServletResponse(), capture(new AtomicReference<>(), uid,
                new AtomicReference<>(), new AtomicReference<>()));

        assertNull(uid.get(),
                "过滤器不参与鉴权，塞 uid 等于绕过鉴权凭空编身份；uid 由 AuthInterceptor 解析后补入");
    }
}
