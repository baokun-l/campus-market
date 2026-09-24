package com.campus.market.service.ai;

import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.ChatOptions;
import org.springframework.ai.chat.prompt.Prompt;
import reactor.core.publisher.Flux;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * ---- 多供应商降级链（DeepSeek → 千问 → …）----
 * <p>
 * ★★ 为什么做成 {@link ChatModel} 的**装饰器**，而不是改 {@code AiAssistantService} ★★
 * <p>
 * {@code AiAssistantService} 的类注释里早就写明了它的设计意图：
 * 「依赖 {@link ChatModel} 接口而不是 {@code OpenAiChatModel} 具体类 ——
 * 有另一个 {@code ChatModel} 实现即可」。这个类就是那个「另一个实现」。
 * <p>
 * 于是换模型这件事**对业务代码完全透明**：
 * <ul>
 *   <li>{@code AiAssistantService} 一行不改 —— 它注入的仍是 {@code ChatModel}；</li>
 *   <li>闸门位置（{@code quotaGuard.acquire} 在拼 prompt 之前、降级 try 之外）不变；</li>
 *   <li>提示词结构（{@code SystemMessage} + {@code UserMessage} 两条独立消息）不变；</li>
 *   <li>「模型不可用 → 返回模板文案」这条兜底完全不需要改 —— 全链都失败时本类**抛异常**，
 *       异常照旧被 {@code AiAssistantService} 的 catch 接住。</li>
 * </ul>
 * <p>
 * ★★ 降级只降「外部依赖故障」，不降「输入非法」与「被限流」★★
 * 那两类异常在 {@code AiAssistantService} 里位于 try 之外，**不会**流到本类。
 * 本类只处理「模型调用失败/返回空」这一种情形。
 * <p>
 * ★★ 为什么「返回空」也要落到下一个供应商 ★★
 * 一个供应商返回空白文案，对用户来说等同于失败（界面会显示一段空话术）。
 * 若只在「抛异常」时才切换，就会漏掉这类「HTTP 200 但没有内容」的软失败 ——
 * 而它恰恰是网关限流、内容审核拦截最常见的表现。
 * <p>
 * ★★ 全链失败时抛出的异常消息必须**能直接定位**★★
 * 因为 {@code AiAssistantService} 只会把 {@code getMessage()} 打进一条 WARN。
 * 所以消息里带上：链上顺序、每个供应商各自失败的原因。
 * 最可能的失败是「一个都没配 key」—— 那种情况下消息直接点名「均未配置 api-key」，
 * 而不是让运维去猜为什么每句话都是模板。
 */
@Slf4j
public class AiProviderChain implements ChatModel {

    /** 链上的一环：供应商名 + 该供应商的模型客户端 */
    public record Entry(String name, ChatModel model) {
    }

    private final List<Entry> entries;

    public AiProviderChain(List<Entry> entries) {
        this.entries = List.copyOf(entries);
    }

    /** 链上实际注册成功的供应商名（按尝试顺序）。空列表表示一个都没配好 */
    public List<String> providerNames() {
        List<String> out = new ArrayList<>(entries.size());
        for (Entry e : entries) {
            out.add(e.name());
        }
        return out;
    }

    /**
     * 是否为「空链」（一个供应商都没注册）。
     * <p>
     * 空链不是错误：本地开发与未配 key 的部署都应当照常启动，
     * 只是每条回复都走模板文案。调用方据此打一条**启动期 WARN**把这件事说清楚，
     * 而不是让「AI 怎么老说套话」变成一个无人能查的现象。
     */
    public boolean isEmpty() {
        return entries.isEmpty();
    }

    @Override
    public ChatResponse call(Prompt prompt) {
        return attempt(
                "call(Prompt)",
                entry -> entry.model().call(prompt),
                resp -> resp != null);
    }

    /**
     * ★ 必须显式覆写这个重载 ★
     * <p>
     * {@code ChatModel} 里 {@code call(Message...)} 是一个 **default 方法**
     * （默认实现是把消息包成 {@link Prompt} 再调 {@code call(Prompt)}）。
     * 业务代码走的正是这个重载，而 default 方法是否会绕到本类的 {@code call(Prompt)}、
     * 取决于接口默认实现的具体写法 —— 那是个不该被依赖的细节。
     * 这里显式覆写，把「多供应商轮询」这件事钉死在本类自己的逻辑里。
     */
    @Override
    public String call(Message... messages) {
        return attempt(
                "call(Message...)",
                entry -> entry.model().call(messages),
                text -> text != null && !text.isBlank());
    }

    /** 默认选项取链首那一环的（本接口的 default 实现会直接抛不支持，所以必须覆写） */
    @Override
    public ChatOptions getDefaultOptions() {
        return entries.isEmpty() ? ChatOptions.builder().build() : entries.get(0).model().getDefaultOptions();
    }

    /**
     * 流式：目前业务不用流式，但也不该直接抛不支持。
     * <p>
     * 只委给链首一环，**不做降级** —— 流的失败发生在订阅之后，
     * 那时已经吐了一部分内容给调用方，「换一家重来」会拼出两段不同来源的话。
     * 与其做一半，不如明确只走链首，并在为空链时给出可读错误。
     */
    @Override
    public Flux<ChatResponse> stream(Prompt prompt) {
        if (entries.isEmpty()) {
            return Flux.error(exhausted(List.of(), "stream(Prompt)"));
        }
        return entries.get(0).model().stream(prompt);
    }

    /**
     * 依次尝试各供应商，返回第一个「成功且非空」的结果。
     *
     * @param op   出站操作名（仅用于日志与异常消息）
     * @param call 真正调用某个供应商的方式
     * @param ok   判定「这个结果算成功」的谓词；返回 false 会继续尝试下一个
     * @throws AiChainExhaustedException 全链失败（含空链）
     */
    private <T> T attempt(String op, Function<Entry, T> call, Predicate<T> ok) {
        List<String> failures = new ArrayList<>();

        for (Entry entry : entries) {
            try {
                T value = call.apply(entry);
                if (ok.test(value)) {
                    if (failures.size() > 0) {
                        // 前几环失败、这一环成功 —— 必须留痕，否则「某个供应商悄悄挂了」永远没人发现
                        log.warn("[ai-chain] fell back to a later provider. op={} used={} earlierFailures={}",
                                op, entry.name(), failures);
                    }
                    return value;
                }
                failures.add(entry.name() + "=空响应");
                log.warn("[ai-chain] provider returned blank, trying next. provider={} op={}", entry.name(), op);
            } catch (Exception ex) {
                failures.add(entry.name() + "=" + ex.getMessage());
                log.warn("[ai-chain] provider failed, trying next. provider={} op={} reason={}",
                        entry.name(), op, ex.getMessage());
            }
        }

        throw exhausted(failures, op);
    }

    private AiChainExhaustedException exhausted(List<String> failures, String op) {
        if (entries.isEmpty()) {
            return new AiChainExhaustedException(
                    "AI 降级链上没有任何已配置的供应商（缺 api-key 或已停用），op=" + op
                            + "；请检查 APP_AI_DEEPSEEK_API_KEY / APP_AI_QWEN_API_KEY");
        }
        return new AiChainExhaustedException(
                "AI 供应商全部失败，已尝试 " + providerNames() + "，op=" + op + "；明细 " + failures);
    }

    /** 全链失败。抛出去由 {@code AiAssistantService} 接住并回退模板文案 */
    public static class AiChainExhaustedException extends RuntimeException {
        public AiChainExhaustedException(String message) {
            super(message);
        }
    }
}
