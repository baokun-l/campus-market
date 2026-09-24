package com.campus.market.config;

import com.campus.market.service.ai.AiProviderChain;
import io.micrometer.observation.ObservationRegistry;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.model.tool.ToolCallingManager;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.List;

/**
 * ---- 多供应商 AI 客户端的装配（DeepSeek / 千问 / OpenAI 兼容端点）----
 * <p>
 * ★★ 为什么三个供应商都用 {@code spring-ai-openai} 而不是各自的 starter ★★
 * <p>
 * DeepSeek 与阿里云百炼都提供 **OpenAI 兼容端点**，对话协议完全一致，
 * 所以一个 {@link OpenAiApi} 就能服务三家，只是 {@code baseUrl}/{@code apiKey}/{@code model} 不同。
 * <p>
 * 反过来说，如果为了「更原生」去引入 {@code spring-ai-starter-model-deepseek}，
 * 那是个**版本陷阱**：本机 {@code ~/.m2} 里同时存在 1.0.0-M6 与 1.0.0 GA 两套制品，
 * 而本项目是 M6（模块还叫 {@code spring-ai-core}；GA 已改名 {@code spring-ai-model}）。
 * 引 GA 的 starter 会把 GA 的 {@code spring-ai-model}/{@code spring-ai-client-chat}
 * 一起拖进来，与 M6 的 core 共存 —— 这不是「多一个依赖」，是**两套模型抽象同时在类路径上**。
 * 用兼容端点则完全不碰依赖树。
 * <p>
 * ★★ 为什么显式排除 Spring AI 的 OpenAI 自动配置 ★★
 * <p>
 * 见 {@code application.yml} 的 {@code spring.autoconfigure.exclude}。
 * 一句话：一个应用里只能有**一条**「AI 走哪家」的配置路径。
 * 若同时留着自动配置，类路径上就会出现第二个 {@link ChatModel} bean，
 * 而 {@code AiAssistantService} 是按接口注入的 —— 到那时「到底走了谁」取决于
 * bean 的条件注解与 {@code @Primary} 的组合，那种不确定性正是本项目反复在修的形态。
 * <p>
 * ★★ 注册规则：开关打开 **且** key 非空，才进链 ★★
 * 缺任何一项 ⇒ 该供应商沉默地不进链（并用启动日志把这件事说出来）。
 * 这与支付渠道 {@code available()} 的口径一致：**失败关闭，不信任配置**。
 */
@Slf4j
@Configuration
public class AiProviderConfig {

    /**
     * 装配降级链，并作为**唯一的** {@link ChatModel} bean 暴露给业务代码。
     * <p>
     * ★ 出站客户端复用 {@code AiHttpClientConfig} 提供的 {@link RestClient.Builder} ★
     * 那个 Bean 带着 3 秒连接 / 8 秒读的超时。若不显式传下去，
     * 每个供应商会各自 new 一个默认客户端 ⇒ 失败时要等 JDK 默认超时（实测 21 秒），
     * 稳稳超过前端的 15 秒 —— 「功能有兜底、界面还是报超时」的老问题会原样复发。
     */
    @Bean
    public AiProviderChain aiChatModel(AiProperties props,
                                       ObjectProvider<RestClient.Builder> restClientBuilder,
                                       ObjectProvider<ToolCallingManager> toolCallingManager,
                                       ObjectProvider<ObservationRegistry> observationRegistry) {

        RestClient.Builder http = restClientBuilder.getIfAvailable(RestClient::builder);

        /*
         * 不重试：失败立刻降级到下一个供应商。
         * max-attempts 由 AiProperties 从 spring.ai.retry.max-attempts 读取，
         * 保证「重试次数」这个概念只有一个来源。
         */
        RetryTemplate retry = RetryTemplate.builder()
                .maxAttempts(Math.max(1, props.getMaxAttempts()))
                .build();

        List<AiProviderChain.Entry> chain = new ArrayList<>();
        List<String> skipped = new ArrayList<>();

        for (String name : props.chainList()) {
            if (!props.configured(name)) {
                skipped.add(name);
                continue;
            }
            OpenAiChatModel model = build(name, props, http, retry,
                    toolCallingManager.getIfAvailable(), observationRegistry.getIfAvailable());
            chain.add(new AiProviderChain.Entry(name, model));
            // 注意：**只打模型名与地址，绝不打 key**
            log.info("[ai] provider registered: {} model={} baseUrl={}",
                    name, props.modelOf(name), props.baseUrlOf(name));
        }

        AiProviderChain result = new AiProviderChain(chain);

        if (!skipped.isEmpty()) {
            log.warn("[ai] providers skipped (enabled 但缺 api-key，或已停用): {}", skipped);
        }
        if (!props.unknownChainNames().isEmpty()) {
            // 拼错的供应商名必须点名：静默少一环等于「我明明配了却没生效」
            log.warn("[ai] 链里出现了无法识别的供应商名，已忽略: {}（可用：{}）",
                    props.unknownChainNames(), AiProperties.KNOWN_PROVIDERS);
        }
        if (result.isEmpty()) {
            /*
             * 空链不是启动失败 —— 本地开发、未配 key 的部署都该能跑，
             * 只是每条回复都走 AiAssistantService 的模板文案。
             * 但这必须**在启动期就说清楚**，否则「AI 怎么老说套话」会变成一个没人能查的现象。
             */
            log.warn("[ai] 降级链为空 —— 没有任何已配置的供应商，AI 回复将全部走模板文案。"
                    + "请设置 APP_AI_DEEPSEEK_API_KEY 或 APP_AI_QWEN_API_KEY（见 deploy/env.example）");
        } else {
            log.info("[ai] chain registered: {} (temperature={})",
                    result.providerNames(), props.effectiveTemperature());
        }
        return result;
    }

    /** 用一个 OpenAI 兼容端点构建某供应商的客户端 */
    private OpenAiChatModel build(String name,
                                  AiProperties props,
                                  RestClient.Builder http,
                                  RetryTemplate retry,
                                  ToolCallingManager toolCallingManager,
                                  ObservationRegistry observationRegistry) {

        OpenAiApi api = OpenAiApi.builder()
                .baseUrl(props.baseUrlOf(name))
                .apiKey(props.apiKeyOf(name))
                .completionsPath(props.getCompletionsPath())
                .restClientBuilder(http)
                .build();

        OpenAiChatOptions options = new OpenAiChatOptions();
        options.setModel(props.modelOf(name));
        options.setTemperature(props.effectiveTemperature());

        OpenAiChatModel.Builder builder = OpenAiChatModel.builder()
                .openAiApi(api)
                .defaultOptions(options)
                .retryTemplate(retry);

        if (toolCallingManager != null) {
            builder.toolCallingManager(toolCallingManager);
        }
        if (observationRegistry != null) {
            builder.observationRegistry(observationRegistry);
        }
        return builder.build();
    }
}
