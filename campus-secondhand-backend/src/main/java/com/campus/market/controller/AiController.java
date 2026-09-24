package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.config.AiProperties;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.AiAssistantService;
import com.campus.market.service.ai.AiProviderChain;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Spring AI 智能助手控制器
 * <p>
 * 提供：
 *  1. POST /ai/generate-description —— 商品描述自动生成
 *  2. POST /ai/chat                   —— 智能客服
 *  3. GET  /ai/providers              —— 查看降级链实际生效情况（自查/排障用）
 * <p>
 * ★ 三个接口都<b>需要登录</b> ★
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
 * <p>
 * ★ 只有第 3 个接口读 {@link AiProviderChain} / {@link AiProperties}，且是只读的 ★
 * 两个生成类接口仍然只依赖 {@link AiAssistantService}，
 * 所以「换模型」这件事对它们的签名与行为没有任何影响。
 */
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class AiController {

    private final AiAssistantService aiService;

    /** 降级链实例：只用于自查接口读「哪些供应商真的注册上了」 */
    private final AiProviderChain chain;

    /** AI 配置：只用于自查接口回显链序/模型名；**不回显 key** */
    private final AiProperties props;

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

    /**
     * 查看 AI 降级链的**实际生效情况**（P1-14）
     * <p>
     * 返回形如：
     * <pre>
     * {
     *   "chain":     ["deepseek","qwen"],   // 配置里写的顺序（已剔除不认识的名字）
     *   "available": ["deepseek"],          // 真正注册进链的（开关打开 **且** key 非空）
     *   "missing":   ["qwen"],              // 在链里但没配 key —— 这一项最常被需要
     *   "unknown":   [],                    // 链里拼错、已被忽略的名字
     *   "temperature": 0.7,
     *   "providers": [ {"name":"deepseek","enabled":true,"keyConfigured":true,
     *                   "model":"deepseek-chat","baseUrl":"https://api.deepseek.com"}, ... ]
     * }
     * </pre>
     * <p>
     * ★★ 为什么要专门做这个接口，而不是让运维去翻日志 ★★
     * <p>
     * 因为「AI 是不是真的接上了」在没有这个接口时的唯一表现是
     * 「客服回复听起来像套话」—— 而这与「模型正常工作但回答本来就简短」**无法区分**。
     * 本项目的支付模块为此做过 {@code GET /pay/channels}，并有真机三场景对照证明：
     * 环境变量少写 {@code APP_} 前缀时渠道会**静默消失**、日志里一条错都没有。
     * AI 这边是同一个形态（{@code APP_AI_*_API_KEY} 写错 ⇒ 该供应商静默不进链），
     * 所以配一个同样口径的自查点：**看用户能看到什么，而不是看配置写了什么**。
     * <p>
     * ★ 只回 {@code keyConfigured} 布尔值，**绝不回 key 本身** ★
     * 这个接口要登录才能调，但「要登录」不等于可以回传密钥：
     * 一旦回传，它就会出现在浏览器网络面板、前端日志、截图与答辩录屏里。
     */
    @GetMapping("/providers")
    public Result<Map<String, Object>> providers() {
        List<String> configuredChain = props.chainList();
        List<String> available = chain.providerNames();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("chain", configuredChain);
        out.put("available", available);
        out.put("missing", configuredChain.stream().filter(n -> !available.contains(n)).toList());
        out.put("unknown", props.unknownChainNames());
        out.put("temperature", props.effectiveTemperature());
        out.put("completionsPath", props.getCompletionsPath());

        List<Map<String, Object>> detail = new ArrayList<>();
        for (String name : AiProperties.KNOWN_PROVIDERS) {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("name", name);
            one.put("enabled", enabledOf(props, name));
            one.put("keyConfigured", props.apiKeyOf(name) != null && !props.apiKeyOf(name).isBlank());
            one.put("inChain", configuredChain.contains(name));
            one.put("registered", available.contains(name));
            one.put("model", props.modelOf(name));
            one.put("baseUrl", props.baseUrlOf(name));
            detail.add(one);
        }
        out.put("providers", detail);
        return Result.success(out);
    }

    private boolean enabledOf(AiProperties props, String name) {
        return switch (name) {
            case "deepseek" -> props.isDeepseekEnabled();
            case "qwen" -> props.isQwenEnabled();
            case "openai" -> props.isOpenaiEnabled();
            default -> false;
        };
    }

    /** 当前登录用户 id：由 AuthInterceptor 解析登录态后写入 request attribute */
    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }
}
