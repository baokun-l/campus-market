package com.campus.market.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

/**
 * Spring AI 出站 HTTP 客户端超时配置
 * <p>
 * ★ 这个类解决的是一个「接口能返回，但要等 21 秒」的问题 ★
 * <p>
 * {@code AiAssistantService} 调的是 {@code https://api.openai.com}。在国内网络下
 * TCP 连接被丢包，默认的 JDK 客户端要等到**连接超时**才放弃（实测 21 秒）。
 * 而前端 axios 的 timeout 是 15 秒 —— 于是用户先看到「请求超时」，
 * 后端却还在傻等，最后才走到 {@code AiAssistantService} 的模板降级分支。
 * 结果就是：功能明明有降级兜底，界面上仍然是一次超时报错。
 * <p>
 * Spring AI 1.0.0-M6 的 {@code spring.ai.openai} **没有暴露超时配置项**
 * （只有 bedrock 有 {@code spring.ai.bedrock.aws.timeout}），
 * 但 {@code OpenAiAutoConfiguration#openAiChatModel} 的签名里带了
 * {@code ObjectProvider<RestClient.Builder>}，也就是说：
 * <b>我们自己提供一个带超时的 {@code RestClient.Builder} Bean，Spring AI 就会用它。</b>
 * <p>
 * 超时压到 3 秒 + 8 秒读超时后，AI 不可用时约 3 秒就能落到模板文案，
 * 稳稳落在前端 15 秒超时之内。
 * <p>
 * 说明：本 Bean 是宽松条件下的 {@code @ConditionalOnMissingBean}，
 * 项目里除 Spring AI 外没有其它组件使用 {@code RestClient}，因此影响面仅限 AI 调用。
 */
@Configuration
public class AiHttpClientConfig {

    /** 建立连接的超时（毫秒）。连不通时快速失败，交给模板降级 */
    private static final int CONNECT_TIMEOUT_MS = 3000;

    /** 等待响应的超时（毫秒）。给真实 AI 生成留出余量，但不至于拖到前端超时 */
    private static final int READ_TIMEOUT_MS = 8000;

    @Bean
    public RestClient.Builder restClientBuilder() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(CONNECT_TIMEOUT_MS);
        factory.setReadTimeout(READ_TIMEOUT_MS);
        return RestClient.builder().requestFactory(factory);
    }
}
