package com.campus.market.config;

import lombok.Getter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * ---- AI 助手配置（唯一入口）----
 * <p>
 * ★★ 为什么 AI 配置要收在一个类里 ★★
 * <p>
 * 与 {@link PayProperties} 同一条理由：本项目吃过「一个概念两个名字 = 两个开关」的亏。
 * 曾经 AI 只有一条路径（{@code spring.ai.openai.*}），
 * 于是「接哪个模型」这件事只能靠**改 yml 重新打包**——换模型等于发版。
 * 现在改成一条**有序降级链**（默认 {@code deepseek,qwen}），
 * 每个供应商一组 {@code app.ai.<name>.*}。
 * <p>
 * ★★ 所有 {@code app.ai.*} 只在这里读一次 ★★
 * 其余类一律注入本对象。同一个键不要在别处再 {@code @Value} 一次。
 * <p>
 * ★★ 密钥一律走环境变量，仓库里绝不能有真值 ★★
 * 与支付宝私钥同理：AI key 泄露等于别人拿你的账单刷接口。
 * 所以 {@code *.api-key} 在 yml 里**没有默认值**（默认空串），
 * 且**空 key ⇒ 该供应商不注册**（见 {@link #configured(String)}）——
 * 它会从链里沉默地消失，而不是让应用启动失败、或者等用户点了才报错。
 * 这一点与支付渠道 {@code available()} 的口径一致：**失败关闭，不信任配置**。
 * <p>
 * ★★ 环境变量名必须带 {@code APP_} 前缀 ★★
 * {@code app.ai.*} 在 yml 里**没有任何占位符**，只靠 Spring Boot 的 relaxed binding
 * 从环境变量绑定：{@code app.ai.deepseek.api-key} ←→ {@code APP_AI_DEEPSEEK_API_KEY}。
 * 少写 {@code APP_}（例如写成 {@code AI_DEEPSEEK_API_KEY}）**不会报任何错，只是绑不上**：
 * key 保持空 ⇒ 该供应商不注册 ⇒ 链里少一环 ⇒ 全部供应商都没配时**每一条回复都变成模板文案**。
 * 这与支付那边踩过的坑是同一个形态（见 {@code deploy/env.example} 的 {@code APP_PAY_*} 段落），
 * 所以 {@code deploy/env.example} 里把每个名字都列出来供照抄。
 */
@Getter
@Component
public class AiProperties {

    /* ==================================================================
     * 链
     * ================================================================== */

    /**
     * 供应商的**尝试顺序**，逗号分隔、从左到右。
     * <p>
     * ★ 顺序即优先级：排在前面的先用，抛异常或返回空就自动落到下一个 ★
     * <p>
     * 默认 {@code deepseek,qwen} —— 客服与商品描述都是中文短文本场景，
     * 这两个的性价比明显好于直连 OpenAI（后者在国内网络下通常根本连不上，
     * 见 {@code AiHttpClientConfig} 记录的实测 21 秒连接超时）。
     * <p>
     * 写 {@code openai} 可以把 OpenAI 也排进链（凭据取 {@code spring.ai.openai.*}？否 ——
     * 本项目已**移除** Spring AI 的 OpenAI 自动配置，它的凭据同样在
     * {@code app.ai.openai.*} 下，见 {@code application.yml} 的说明）。
     * <p>
     * ★ 认不出的名字会被忽略，但会**在启动日志里点名** ★
     * 静默忽略一个拼错的供应商名，等于「我明明配了却没生效」——
     * 那正是本项目最怕的静默失效形态。
     */
    @Value("${app.ai.chain:deepseek,qwen}")
    private String chain;

    /**
     * 采样温度，套用到所有供应商。
     * <p>
     * 0.7 是原 {@code spring.ai.openai.chat.options.temperature} 的值，保持不变：
     * 客服话术与商品描述需要一点措辞变化，又不能离谱。
     * 降温到 0 会让同一个问题永远得到同一句话，看起来像坏了。
     */
    @Value("${app.ai.temperature:0.7}")
    private Double temperature;

    /**
     * 出站路径（拼在 base-url 之后）。
     * <p>
     * ★★ 这个值必须**显式**给出，不能依赖框架默认 ★★
     * 「OpenAI 兼容」是各家自己声明的，默认路径是不是 {@code /v1/chat/completions}
     * 属于实现细节；一旦某天框架换了默认值，报错只会是一句 404，
     * 而「404 是因为路径变了」这个因果在日志里完全看不出来。
     * 本项目已有的实测证据是当前 OpenAI 出站地址为
     * {@code https://api.openai.com/v1/chat/completions}（见对账期日志），三者同构，故共用此默认值。
     */
    @Value("${app.ai.completions-path:/v1/chat/completions}")
    private String completionsPath;

    /**
     * ★ 出站重试次数 ★
     * <p>
     * 原值在 {@code spring.ai.retry.max-attempts}，现由本类读取并传给链上**每一个**供应商，
     * 保证三条渠道口径一致。
     * <p>
     * ★ 为什么默认是 1（不重试）★
     * 实测一次不可达的调用要等到连接超时；框架默认重试会把等待叠加成数十秒，
     * 而前端 axios 的 timeout 是 15 秒 —— 用户会先看到「请求超时」，
     * 后端却还在傻等，最后才走到模板降级。失败就该**立刻**降级，所以不重试。
     * （底层连接/读超时见 {@code AiHttpClientConfig}：3 秒 / 8 秒。）
     */
    @Value("${spring.ai.retry.max-attempts:1}")
    private int maxAttempts;

    /* ==================================================================
     * DeepSeek
     * ================================================================== */

    /** 是否允许使用（还要 api-key 非空才真正注册，两个条件都要满足） */
    @Value("${app.ai.deepseek.enabled:true}")
    private boolean deepseekEnabled;

    /**
     * 接口根地址。★ 末尾**不带** {@code /v1} ★
     * <p>
     * 完整的出站地址 = base-url + completions-path
     * （默认 {@code https://api.deepseek.com} + {@code /v1/chat/completions}）。
     * 把 {@code /v1} 写进 base-url 会拼出 {@code …/v1/v1/chat/completions}，
     * 得到 404 —— 而报错信息里只有那句 404，看不出是多写了一段。
     */
    @Value("${app.ai.deepseek.base-url:https://api.deepseek.com}")
    private String deepseekBaseUrl;

    /** 应用 key（{@code sk-…}）。留空 ⇒ 本供应商不注册 */
    @Value("${app.ai.deepseek.api-key:}")
    private String deepseekApiKey;

    /** 模型名。客服/短文本生成用 {@code deepseek-chat}；推理型是 {@code deepseek-reasoner} */
    @Value("${app.ai.deepseek.model:deepseek-chat}")
    private String deepseekModel;

    /* ==================================================================
     * 千问（阿里云百炼 / DashScope 的 OpenAI 兼容模式）
     * ================================================================== */

    @Value("${app.ai.qwen.enabled:true}")
    private boolean qwenEnabled;

    /**
     * ★ 兼容模式的根地址末尾**已经含 {@code /v1}**，所以默认值写到
     * {@code /compatible-mode} 为止，由 completions-path 补上 {@code /v1/chat/completions} ★
     * <p>
     * 两个供应商的「根地址该写到哪里」并不一致（DeepSeek 不带 {@code /v1}、
     * DashScope 兼容模式要带），所以这里**不猜**：各自写全，并在注释里点名差别。
     */
    @Value("${app.ai.qwen.base-url:https://dashscope.aliyuncs.com/compatible-mode}")
    private String qwenBaseUrl;

    @Value("${app.ai.qwen.api-key:}")
    private String qwenApiKey;

    /** 模型名：{@code qwen-plus} 均衡；另有 {@code qwen-turbo}（快/便宜）、{@code qwen-max}（最强/最贵） */
    @Value("${app.ai.qwen.model:qwen-plus}")
    private String qwenModel;

    /* ==================================================================
     * OpenAI（保留为可选第三环，默认关闭且不在链里）
     * ================================================================== */

    @Value("${app.ai.openai.enabled:false}")
    private boolean openaiEnabled;

    @Value("${app.ai.openai.base-url:https://api.openai.com}")
    private String openaiBaseUrl;

    @Value("${app.ai.openai.api-key:}")
    private String openaiApiKey;

    @Value("${app.ai.openai.model:gpt-3.5-turbo}")
    private String openaiModel;

    /* ==================================================================
     * 派生（唯一的解析口径）
     * ================================================================== */

    /** 本项目认识的供应商名。写错的名字不算数（但会被启动日志点名） */
    public static final List<String> KNOWN_PROVIDERS = List.of("deepseek", "qwen", "openai");

    /** 链上的供应商名，已去重、去空白、全小写、并剔除不认识的名字 */
    public List<String> chainList() {
        List<String> out = new ArrayList<>();
        if (chain == null) {
            return out;
        }
        Set<String> seen = new LinkedHashSet<>();
        for (String raw : chain.split(",")) {
            String name = raw.trim().toLowerCase(Locale.ROOT);
            if (!name.isEmpty() && KNOWN_PROVIDERS.contains(name) && seen.add(name)) {
                out.add(name);
            }
        }
        return out;
    }

    /** 链里写了、但本项目不认识的名字（用于启动时点名，避免拼错后静默少一环） */
    public List<String> unknownChainNames() {
        List<String> out = new ArrayList<>();
        if (chain == null) {
            return out;
        }
        for (String raw : chain.split(",")) {
            String name = raw.trim().toLowerCase(Locale.ROOT);
            if (!name.isEmpty() && !KNOWN_PROVIDERS.contains(name) && !out.contains(name)) {
                out.add(name);
            }
        }
        return out;
    }

    /**
     * 该供应商**是否真的可用**（开关打开 + key 非空）。
     * <p>
     * ★ 两个条件都必要 ★
     * 只看 {@code enabled} 会让「忘了填 key」表现为「渠道在、但每次都失败」；
     * 只看 key 又没法在不删 key 的情况下临时停用某条渠道。
     */
    public boolean configured(String name) {
        return switch (name) {
            case "deepseek" -> deepseekEnabled && notBlank(deepseekApiKey);
            case "qwen" -> qwenEnabled && notBlank(qwenApiKey);
            case "openai" -> openaiEnabled && notBlank(openaiApiKey);
            default -> false;
        };
    }

    /** 某供应商的模型名（未配置时返回空串，用于日志） */
    public String modelOf(String name) {
        return switch (name) {
            case "deepseek" -> deepseekModel;
            case "qwen" -> qwenModel;
            case "openai" -> openaiModel;
            default -> "";
        };
    }

    /** 某供应商的接口根地址（末尾不带 {@code /v1}，完整地址由 completions-path 补齐） */
    public String baseUrlOf(String name) {
        return switch (name) {
            case "deepseek" -> deepseekBaseUrl;
            case "qwen" -> qwenBaseUrl;
            case "openai" -> openaiBaseUrl;
            default -> "";
        };
    }

    /** 某供应商的 key（仅用于构建客户端，**不要**打进日志） */
    public String apiKeyOf(String name) {
        return switch (name) {
            case "deepseek" -> deepseekApiKey;
            case "qwen" -> qwenApiKey;
            case "openai" -> openaiApiKey;
            default -> "";
        };
    }

    /** 采样温度（null / 非法值一律退回 0.7 —— 温度没有「不限」这个语义） */
    public Double effectiveTemperature() {
        if (temperature == null || temperature.isNaN() || temperature < 0 || temperature > 2) {
            return 0.7;
        }
        return temperature;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
