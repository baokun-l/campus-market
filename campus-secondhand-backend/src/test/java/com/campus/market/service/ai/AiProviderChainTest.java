package com.campus.market.service.ai;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.MessageType;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 多供应商降级链的行为测试（P1-14）
 * <p>
 * ★ 这个类测的是「链的判别力」，不是「某个供应商能答对」★
 * 真实模型的效果依赖网络与账号，不能也不该进单测；这里只钉住四件事：
 * <ol>
 *   <li><b>顺序即优先级</b>：链首成功就不再调后面的（否则每次请求都在烧两家的钱）；</li>
 *   <li><b>异常要落下一家</b>：这是本功能的全部意义；</li>
 *   <li><b>空响应也算失败</b>：HTTP 200 但内容为空（限流/审核拦截的常见表现）必须换下一家，
 *       否则界面会显示一段空白话术，而日志里一条错都没有；</li>
 *   <li><b>全链失败要抛异常</b>：只有这样 {@code AiAssistantService} 的 catch 才会接住并回退模板。
 *       若这里反而返回空串，业务代码会认为「模型答了，只是答的是空的」，
 *       于是**既没有模型回答、也不会走模板**——最坏的一种半可用。</li>
 * </ol>
 */
class AiProviderChainTest {

    private static final UserMessage QUESTION = new UserMessage("怎么退款？");

    // ---------- 顺序与优先级 ----------

    @Test
    @DisplayName("链首成功时直接返回，且不再调用后面的供应商")
    void firstProviderWinsAndOthersAreNotCalled() {
        Stub first = new Stub("deepseek 的回答", null);
        Stub second = new Stub("qwen 的回答", null);

        AiProviderChain chain = chainOf(e("deepseek", first), e("qwen", second));

        assertEquals("deepseek 的回答", chain.call(QUESTION));
        assertEquals(1, first.calls.get(), "链首应被调用一次");
        assertEquals(0, second.calls.get(), "链首成功时不该再调下一家（否则每次请求烧两份钱）");
    }

    @Test
    @DisplayName("providerNames 按链序返回，供自查接口回显")
    void providerNamesKeepChainOrder() {
        AiProviderChain chain = chainOf(
                e("deepseek", new Stub("a", null)),
                e("qwen", new Stub("b", null)),
                e("openai", new Stub("c", null)));

        assertEquals(List.of("deepseek", "qwen", "openai"), chain.providerNames());
        assertFalse(chain.isEmpty());
    }

    // ---------- 降级 ----------

    @Test
    @DisplayName("链首抛异常时落到下一家，并返回下一家的回答")
    void fallsBackWhenFirstProviderThrows() {
        Stub first = new Stub(null, new RuntimeException("Connection timed out"));
        Stub second = new Stub("qwen 顶上了", null);

        AiProviderChain chain = chainOf(e("deepseek", first), e("qwen", second));

        assertEquals("qwen 顶上了", chain.call(QUESTION));
        assertEquals(1, first.calls.get());
        assertEquals(1, second.calls.get());
    }

    @Test
    @DisplayName("链首返回空白也算失败，必须落到下一家")
    void fallsBackWhenFirstProviderReturnsBlank() {
        Stub first = new Stub("   ", null);
        Stub second = new Stub("qwen 顶上了", null);

        AiProviderChain chain = chainOf(e("deepseek", first), e("qwen", second));

        assertEquals("qwen 顶上了", chain.call(QUESTION));
        assertEquals(1, second.calls.get(), "空白响应必须触发降级（限流/审核拦截的常见表现）");
    }

    @Test
    @DisplayName("链首返回 null 同样算失败")
    void fallsBackWhenFirstProviderReturnsNull() {
        Stub first = new Stub(null, null);
        Stub second = new Stub("qwen 顶上了", null);

        AiProviderChain chain = chainOf(e("deepseek", first), e("qwen", second));

        assertEquals("qwen 顶上了", chain.call(QUESTION));
    }

    // ---------- 全链失败 ----------

    @Test
    @DisplayName("全链失败时抛异常，且消息里点名每一家的失败原因")
    void throwsWithProviderNamesAndReasonsWhenAllFail() {
        AiProviderChain chain = chainOf(
                e("deepseek", new Stub(null, new RuntimeException("Connect timed out"))),
                e("qwen", new Stub(null, new RuntimeException("401 Unauthorized"))));

        AiProviderChain.AiChainExhaustedException ex = assertThrows(
                AiProviderChain.AiChainExhaustedException.class, () -> chain.call(QUESTION));

        String msg = ex.getMessage();
        assertTrue(msg.contains("deepseek"), "必须点名失败的供应商，否则日志里只看到一句'都失败了'");
        assertTrue(msg.contains("qwen"), "必须点名失败的供应商");
        assertTrue(msg.contains("Connect timed out"), "必须带上链首的具体原因");
        assertTrue(msg.contains("401 Unauthorized"), "必须带上第二家的具体原因");
    }

    @Test
    @DisplayName("全部返回空白时也抛异常（而不是返回空串）")
    void throwsWhenAllProvidersReturnBlank() {
        AiProviderChain chain = chainOf(
                e("deepseek", new Stub("  ", null)),
                e("qwen", new Stub("", null)));

        AiProviderChain.AiChainExhaustedException ex = assertThrows(
                AiProviderChain.AiChainExhaustedException.class, () -> chain.call(QUESTION));
        assertTrue(ex.getMessage().contains("deepseek"));
    }

    @Test
    @DisplayName("空链抛出的消息要能直接指出该配哪个环境变量")
    void emptyChainMessageIsActionable() {
        AiProviderChain chain = chainOf();

        assertTrue(chain.isEmpty());
        AiProviderChain.AiChainExhaustedException ex = assertThrows(
                AiProviderChain.AiChainExhaustedException.class, () -> chain.call(QUESTION));

        String msg = ex.getMessage();
        // 这是「一个都没配 key」时唯一能看到的线索，必须自解释
        assertTrue(msg.contains("APP_AI_DEEPSEEK_API_KEY"), "空链消息必须直接给出要配的变量名");
        assertTrue(msg.contains("APP_AI_QWEN_API_KEY"), "空链消息必须直接给出要配的环境变量名");
    }

    // ---------- 另一个重载与默认选项 ----------

    @Test
    @DisplayName("call(Message...) 传下去的就是原样的两条独立消息（角色隔离不被本类破坏）")
    void messagesArePassedThroughUntouched() {
        Stub only = new Stub("好的", null);
        AiProviderChain chain = chainOf(e("deepseek", only));

        UserMessage user = new UserMessage("卖家不发货怎么办");
        chain.call(new org.springframework.ai.chat.messages.SystemMessage("你是客服"), user);

        assertEquals(2, only.seenMessages.size(), "必须是两条消息，不能拼成一条字符串");
        assertEquals(MessageType.SYSTEM, only.seenMessages.get(0).getMessageType());
        assertEquals(MessageType.USER, only.seenMessages.get(1).getMessageType());
    }

    @Test
    @DisplayName("call(Prompt) 重载同样会降级：返回 null 的一环不能让整次调用提前短路")
    void promptOverloadAlsoFallsBackOnNull() {
        Stub first = new Stub("x", null);
        first.nullForPrompt = true;
        Stub second = new Stub("y", null);

        AiProviderChain chain = chainOf(e("deepseek", first), e("qwen", second));

        Object result = chain.call(new Prompt(new UserMessage("在吗")));

        assertNotNull(result, "链首对 call(Prompt) 返回 null 时必须继续尝试下一家");
        assertEquals(1, second.calls.get());
    }

    @Test
    @DisplayName("getDefaultOptions 在空链上不抛异常（接口的 default 实现会抛不支持）")
    void getDefaultOptionsIsSafeOnEmptyChain() {
        assertNotNull(chainOf().getDefaultOptions());
    }

    // ---------- 脚手架 ----------

    private static AiProviderChain.Entry e(String name, ChatModel model) {
        return new AiProviderChain.Entry(name, model);
    }

    private static AiProviderChain chainOf(AiProviderChain.Entry... entries) {
        return new AiProviderChain(List.of(entries));
    }

    /** 可控的假模型：能指定「返回什么 / 抛什么错」，并记录被调用次数与收到的消息 */
    private static final class Stub implements ChatModel {

        private final String reply;
        private final RuntimeException failure;
        private final AtomicInteger calls = new AtomicInteger();
        private final List<Message> seenMessages = new ArrayList<>();
        private boolean nullForPrompt;

        Stub(String reply, RuntimeException failure) {
            this.reply = reply;
            this.failure = failure;
        }

        @Override
        public ChatResponse call(Prompt prompt) {
            calls.incrementAndGet();
            if (failure != null) {
                throw failure;
            }
            return nullForPrompt ? null : new ChatResponse(List.of());
        }

        @Override
        public String call(Message... messages) {
            calls.incrementAndGet();
            seenMessages.addAll(List.of(messages));
            if (failure != null) {
                throw failure;
            }
            return reply;
        }
    }
}
