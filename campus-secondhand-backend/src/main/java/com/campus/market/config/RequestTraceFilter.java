package com.campus.market.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.security.SecureRandom;

/**
 * 请求上下文过滤器（部署适配清单 P1-6）
 * <p>
 * 把「这次请求是谁、打到哪、用哪个 id 跟踪」放进 MDC，让**每一行日志**都自带上下文，
 * 而不是只有时间戳和堆栈。生产上收到「有一个 500」时，第一件事就是知道
 * **哪个接口、哪个用户** —— 没有这两项，只能用时间窗在几百行日志里猜，排查成本高一个数量级。
 *
 * <h3>★ 为什么用 Filter 而不是像清单里说的在拦截器里做 ★</h3>
 * 清单给的最小改法是在 {@code AuthInterceptor} 里 {@code MDC.put("uri", …)}。
 * 但拦截器的入口 {@code preHandle} **晚于** 一些会在日志里出现的环节，最主要的是
 * {@code NoResourceFoundException}（路由不存在，本项目也兜成 200）与 Servlet 容器层面的
 * 拒绝 —— 这些请求**根本进不到拦截器**，于是它们的日志仍然是没有上下文的孤行。
 * {@link OncePerRequestFilter} 在 Filter 链上，**先于** DispatcherServlet 与所有拦截器，
 * 覆盖面更大；而「谁」这一项（uid）仍然由拦截器在解析出身份后补进去
 * （见 {@code AuthInterceptor#preHandle}）—— 过滤器不知道鉴权规则，也不该知道。
 *
 * <h3>★ traceId 从哪来 ★</h3>
 * 优先沿用调用方传来的 {@code X-Request-Id}（Nginx 可以用 {@code $request_id} 生成并透传，
 * 这样「网关那一跳」和「应用这一跳」是同一个 id，跨层排查能串起来）；
 * 没有或不合法时由本类生成。**并把它回写到响应头**，这样用户报故障时能直接把 id 给运维 ——
 * 否则我们有了 traceId 也没人能告诉我们「出问题的那次」是哪个。
 *
 * <h3>★★ 安全性：为什么必须做「合法性校验」而不是原样使用 ★★</h3>
 * 头部是**攻击者可控**的输入，直接 {@code MDC.put} 再打进日志，等于开了一条
 * <b>日志注入</b>的口子：攻击者塞进 {@code \r\n} 就能在日志里**凭空伪造一整行**
 * （例如伪造一条 {@code ERROR 支付失败} 让值班的人去查一个不存在的事故），
 * 塞进超长串还能把真实日志挤出可视范围、把日志文件撑爆。
 * 所以这里**白名单式校验**：只接受 {@code [A-Za-z0-9_-]} 且长度 8..64 的值，
 * 其余一律丢弃并重新生成 —— 也就是说「不合法的输入不进日志」，
 * 而不是「进日志但转义一下」（转义规则一旦漏一个字符，前功尽弃）。
 * 校验通过的值同时写进响应头，也因此不存在响应头注入。
 *
 * <h3>★ 清理为什么必须写在 finally 里 ★</h3>
 * 线程是**复用**的（Tomcat 线程池）。不清 MDC，下一个请求会继承上一个请求的
 * traceId / uid —— 日志不但没帮忙，反而**把人带偏到别人的请求上**，
 * 而这种错乱只在并发下出现，本地几乎复现不出来。用 {@code MDC.clear()} 而不是逐个
 * {@code remove}：将来有人往 MDC 里加字段，clear 一定不会漏。
 *
 * <h3>已知边界</h3>
 * MDC 是**线程本地**的（{@code ThreadLocal}），所以：
 * <ul>
 *   <li>本项目全部是同步 MVC，一次请求只在一个线程上跑 ⇒ 覆盖完整；</li>
 *   <li>异步任务（{@code @Async}）与定时任务（{@code @Scheduled}）**不在请求线程上**，
 *       没有 MDC —— 这是真实边界，不是缺陷；{@code GoodsOfflineJob} 自己设了
 *       {@code traceId=job-*} 供检索（见该类注释）；</li>
 *   <li>子线程里要带上下文，得自己 {@code MDC.getCopyOfContextMap()} 传递。</li>
 * </ul>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestTraceFilter extends OncePerRequestFilter {

    /** 调用方（Nginx / 前端 / 其他服务）可传的请求 id 头，同时也是我们的回写头 */
    public static final String TRACE_HEADER = "X-Request-Id";

    public static final String MDC_TRACE_ID = "traceId";
    public static final String MDC_UID = "uid";
    public static final String MDC_METHOD = "method";
    public static final String MDC_URI = "uri";

    /** traceId 白名单字符集。**刻意允许下划线/连字符**，方便 Nginx 的 request_id 与人工打的标记直接使用 */
    private static final java.util.regex.Pattern LEGAL_TRACE = java.util.regex.Pattern.compile("^[A-Za-z0-9_-]{8,64}$");

    /** 路径长度上限：超长 URI 本身可能是一次探测/攻击，不做截断就写进日志会污染日志 */
    private static final int MAX_URI_LEN = 200;

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String traceId = resolveTraceId(request);

        MDC.put(MDC_TRACE_ID, traceId);
        MDC.put(MDC_METHOD, request.getMethod());
        MDC.put(MDC_URI, safeUri(request));
        // uid 由 AuthInterceptor 解析出身份后补入（过滤器不参与鉴权，也就不知道"谁"）

        // 回写响应头：用户/前端能拿到 id，报障时可以直接给运维一个可检索的锚点
        response.setHeader(TRACE_HEADER, traceId);
        // 跨域时必须显式暴露，否则浏览器里读不到（CORS 默认只暴露少数安全头）
        response.setHeader("Access-Control-Expose-Headers", TRACE_HEADER);

        try {
            chain.doFilter(request, response);
        } finally {
            // ★ 必须清干净：线程复用会让下一个请求继承本次的上下文（见类注释）
            MDC.clear();
        }
    }

    /**
     * 取 traceId：合法则沿用，否则生成。
     * <p>
     * ★ 这里**不做**「空值回退到 URI/时间戳」这类构造 —— 那样两个不同请求可能撞成同一个 id，
     * 而「id 能不能唯一定位一次请求」是这个字段唯一的用途。
     */
    private String resolveTraceId(HttpServletRequest request) {
        String incoming = request.getHeader(TRACE_HEADER);
        if (incoming != null && LEGAL_TRACE.matcher(incoming).matches()) {
            return incoming;
        }
        return randomTraceId();
    }

    /** 16 位十六进制随机串（64 bit，碰撞概率对本项目量级可忽略） */
    private static String randomTraceId() {
        char[] buf = new char[16];
        for (int i = 0; i < buf.length; i++) {
            buf[i] = HEX[RANDOM.nextInt(HEX.length)];
        }
        return new String(buf);
    }

    /**
     * URI 只做「去控制字符 + 截断」。
     * <p>
     * ★ 为什么不按 traceId 那样白名单校验 ★：URI 里本来就可能出现中文、百分号编码、各种符号，
     * 用白名单会把正常请求的路径也丢掉（那就等于这个字段没用了）。
     * 这里要挡的只有**换行**（伪造日志行的必要成分），所以逐字符过滤控制字符就够了 ——
     * 不同字段的风险面不同，判据也就该不同。
     */
    private static String safeUri(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null) {
            return "-";
        }
        StringBuilder sb = new StringBuilder(Math.min(uri.length(), MAX_URI_LEN));
        for (int i = 0; i < uri.length() && sb.length() < MAX_URI_LEN; i++) {
            char c = uri.charAt(i);
            if (c >= 0x20 && c != 0x7F) {
                sb.append(c);
            }
        }
        return sb.length() == 0 ? "-" : sb.toString();
    }
}
