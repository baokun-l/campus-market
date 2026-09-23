package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.dto.PayChannelOption;
import com.campus.market.dto.PayLaunch;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.PaymentService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 支付控制器：收银台、支付状态轮询、渠道异步回调。
 * <p>
 * ★★ 本类里最需要注意的是那个「不遵守项目约定」的接口 ★★
 * <p>
 * 全项目的响应一律是 {@code {code, message, data}}（见 {@link Result}），
 * 只有 {@code POST /pay/notify/{channel}} 例外 —— 它返回**纯文本**
 * {@code success} / {@code failure}。这不是偷懒，是支付宝定的协议：
 * 它只看响应体是不是 {@code success} 这七个字符，不是就认为通知失败并
 * 按 4m/10m/10m/1h/2h/6h/15h 的节奏一直重推。回一段 JSON 的后果是
 * 「钱已经结算了，但支付宝还在推同一条回调推十几个小时」。
 * <p>
 * 所以这个接口必须显式声明 {@code produces = "text/plain"}，并且**不能**
 * 被统一的 {@code ResponseBodyAdvice}（如果将来加了）包成 JSON。
 *
 * ★ 三个接口的鉴权各不相同，别想当然 ★
 * <ul>
 *   <li>{@code GET /pay/channels}、{@code GET /orders/{id}/pay/status} —— 需要登录。
 *       前者要读当前用户的钱包余额，后者会暴露订单支付状态，两者都不能匿名。</li>
 *   <li>{@code POST /pay/notify/{channel}} —— **完全公开**。它必须公开，
 *       因为渠道服务器不会带我们的 Authorization 头。它的鉴权**只有验签**，
 *       这一点在 {@link AuthInterceptor} 的白名单里写死为「仅 POST」。</li>
 * </ul>
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class PayController {

    private final PaymentService paymentService;

    /* ==================================================================
     * 收银台
     * ================================================================== */

    /**
     * 当前可用的支付方式。
     * <p>
     * ★ 只返回「此刻真的能用」的渠道 ★
     * 没配密钥的支付宝沙箱、prod 下的演示渠道都不会出现在这个列表里，
     * 所以前端照着它渲染，用户不可能点到一条会失败的渠道。
     */
    @GetMapping("/pay/channels")
    public Result<List<PayChannelOption>> channels(HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(paymentService.availableChannels(userId));
    }

    /**
     * 查某笔订单的支付状态（收银台轮询用）。
     * <p>
     * 轮询是必要的：用户跳到支付宝之后会在**外部页面**完成付款，
     * 我们的前端无从得知他什么时候付完（可能付了、也可能关掉页面走人）。
     * 所以跳走之前先记住订单号，跳回来之后按这个接口问一句。
     */
    @GetMapping("/orders/{id}/pay/status")
    public Result<Map<String, Object>> payStatus(HttpServletRequest request, @PathVariable String id) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(paymentService.payStatus(id, userId));
    }

    /* ==================================================================
     * 渠道异步回调
     * ================================================================== */

    /**
     * 渠道异步通知入口。
     * <p>
     * ★★★ 这是全网可访问的接口，它的安全性完全押在验签上 ★★★
     * <p>
     * 它必须公开（渠道服务器不知道我们的 JWT），所以任何人都能往这里 POST。
     * 鉴权由 {@code PayChannel#parseNotify} 内部的验签 + appid 比对完成，
     * 再由 {@code PaymentService#handleNotify} 核对金额与支付单状态。
     * 三层校验缺一层，就等于开了一个「任意推订单到已付款」的口子。
     *
     * ★ 返回体必须是纯文本 ★ 见类注释。
     */
    @PostMapping(value = "/pay/notify/{channel}", produces = "text/plain;charset=UTF-8")
    @ResponseBody
    public String notify(@PathVariable String channel, HttpServletRequest request) {
        Map<String, String> params = new LinkedHashMap<>();
        Enumeration<String> names = request.getParameterNames();
        while (names.hasMoreElements()) {
            String name = names.nextElement();
            params.put(name, request.getParameter(name));
        }
        try {
            return paymentService.handleNotify(channel, params);
        } catch (Exception e) {
            /*
             * ★ 这里吞异常、返回 failure，而不是让它冒泡 ★
             *
             * 冒泡会落到 GlobalExceptionHandler 的兜底分支，返回的是
             * {"code":500,...} 这段 JSON —— 支付宝看不懂，会判定通知失败并按节奏重推。
             * 而异常本身往往是一次性的（比如数据库抖动），重推反而可能成功。
             * 所以返回 failure 让渠道重推是对的行为，但必须留下日志：
             * 回调是「钱进来」的唯一通道，任何一次处理失败都要能被查到。
             */
            log.error("[pay] notify handler threw. channel={}", channel, e);
            return "failure";
        }
    }

    /* ==================================================================
     * 内部工具
     * ================================================================== */

    /**
     * 取客户端 IP。
     * <p>
     * ★ 直接读 {@code getRemoteAddr()} 在反向代理后面是错的 ★
     * 部署形态是 Nginx → Spring Boot，此时 remoteAddr 恒为 127.0.0.1。
     * 支付渠道拿到的 IP 若全是内网地址，风控形同虚设。
     * 所以优先读代理头，取不到再退回 socket 地址。
     */
    static String clientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            // XFF 可能是 "client, proxy1, proxy2"，第一个才是真实客户端
            return xff.split(",")[0].trim();
        }
        String real = request.getHeader("X-Real-IP");
        if (real != null && !real.isBlank()) {
            return real.trim();
        }
        return request.getRemoteAddr();
    }
}
