package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.AiAssistantService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * Spring AI 智能助手控制器
 * <p>
 * 提供：
 *  1. POST /ai/generate-description —— 商品描述自动生成
 *  2. POST /ai/chat                   —— 智能客服
 * <p>
 * ★ 两个接口都<b>需要登录</b> ★
 * <p>
 * {@code /ai/**} 不在 {@code AuthInterceptor} 的任何白名单里，所以匿名调用会被拦成 401。
 * 这既是产品口径（AI 是登录用户的能力），也是 AI 闸门的前提 ——
 * {@link AiAssistantService} 的调用配额是按 <b>userId</b> 计的，
 * 匿名放行会让「按用户限流」退化成「按一个永远为 null 的 key 限流」，即全站共用一个额度。
 * <p>
 * ★ 为什么 userId 要显式从 Controller 传下去，而不是在 Service 里读 ThreadLocal ★
 * <p>
 * 与本项目其它模块一致（见 {@code GoodsController#currentUserId}）：
 * 身份由拦截器解析后放进 request attribute，Controller 取出来当参数传递。
 * 显式的参数让「这个方法会不会越权」在签名上就能看出来，
 * 而 ThreadLocal 形式的隐式上下文一旦在异步/线程池里丢失，
 * 拿到的就是 null 或上一个请求的残留值 —— 那种缺陷极难复现。
 */
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class AiController {

    private final AiAssistantService aiService;

    /**
     * 商品描述自动生成
     * 入参：{ "title": "高数教材", "keywords": "九成新,同济版" }
     * 返回：{ "description": "..." }
     */
    @PostMapping("/generate-description")
    public Result<Map<String, String>> generateDescription(@RequestBody Map<String, String> body,
                                                          HttpServletRequest request) {
        String desc = aiService.generateGoodsDescription(
                body.get("title"), body.get("keywords"), currentUserId(request));
        return Result.success(Map.of("description", desc));
    }

    /**
     * 智能客服
     * 入参：{ "message": "怎么退款？" }
     * 返回：{ "reply": "..." }
     */
    @PostMapping("/chat")
    public Result<Map<String, String>> chat(@RequestBody Map<String, String> body,
                                           HttpServletRequest request) {
        String reply = aiService.chat(body.get("message"), currentUserId(request));
        return Result.success(Map.of("reply", reply));
    }

    /** 当前登录用户 id：由 AuthInterceptor 解析登录态后写入 request attribute */
    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }
}
