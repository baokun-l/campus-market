package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 会话 id 规则测试。
 * <p>
 * 这里守的是一条**跨端契约**：后端 {@code SessionId.of()} 与前端
 * {@code mock.ts} 的 {@code makeSessionId()} 必须算出同一个字符串，
 * 否则买卖双方的消息会裂成两条互不相干的会话（各说各话，都以为对方没回）。
 * <p>
 * 最容易被改坏的是「对称性」：只要有人把 {@code Math.min/max} 换成
 * 「发起方在前、接收方在后」，买家和卖家算出来的 id 就不同了，
 * 而这种 bug 在单账号测试里**永远看不出来**——只有两个账号对着同一商品
 * 各拉一次会话列表才会露头。
 */
class SessionIdTest {

    @Test
    @DisplayName("买卖双方交换参数顺序，必须算出同一个会话 id")
    void shouldBeSymmetricOnUserOrder() {
        String buyerFirst = SessionId.of(12L, 4L, 5L);
        String sellerFirst = SessionId.of(12L, 5L, 4L);

        assertEquals(buyerFirst, sellerFirst, "会话 id 必须与谁先发起无关");
        assertEquals("s_12_4_5", buyerFirst);
    }

    @Test
    @DisplayName("id 大小顺序颠倒也要归一化到 min_max")
    void shouldNormalizeLargeSmallToMinMax() {
        assertEquals("s_7_3_9", SessionId.of(7L, 9L, 3L));
        assertEquals("s_7_3_9", SessionId.of(7L, 3L, 9L));
    }

    @Test
    @DisplayName("同一对用户在不同商品下是不同的会话")
    void shouldIsolateByGoods() {
        assertEquals("s_1_4_5", SessionId.of(1L, 4L, 5L));
        assertEquals("s_2_4_5", SessionId.of(2L, 4L, 5L));
        // 与前端「平台警告」约定一致：goodsId 缺省时按 0 处理
        assertEquals("s_0_4_5", SessionId.of(null, 4L, 5L));
    }

    @Test
    @DisplayName("null 用户按 0 兜底，不抛异常")
    void shouldTolerateNullUsers() {
        assertEquals("s_5_0_4", SessionId.of(5L, null, 4L));
        assertEquals("s_5_0_0", SessionId.of(5L, null, null));
        assertEquals("s_0_0_0", SessionId.of(null, null, null));
    }

    @Test
    @DisplayName("能从会话 id 反解出商品 id")
    void shouldParseGoodsIdBack() {
        assertEquals(12L, SessionId.goodsIdOf("s_12_4_5").longValue());
        assertEquals(0L, SessionId.goodsIdOf("s_0_4_5").longValue());
        // 平台警告会话同样能反解，前端据此判断「这不是商品会话」
        assertEquals(0L, SessionId.goodsIdOf(SessionId.of(null, 4L, 5L)).longValue());
    }

    @Test
    @DisplayName("无法解析的会话 id 返回 null 而不是抛异常")
    void shouldReturnNullOnMalformedSessionId() {
        assertNull(SessionId.goodsIdOf(null));
        assertNull(SessionId.goodsIdOf(""));
        assertNull(SessionId.goodsIdOf("s_4_5"));
        assertNull(SessionId.goodsIdOf("s_abc_4_5"));
    }

    @Test
    @DisplayName("与前端 mock.ts makeSessionId 的规则逐字符一致")
    void shouldMatchFrontendRule() {
        // 前端实现：`s_${goodsId ?? 0}_${Math.min(a,b)}_${Math.max(a,b)}`
        // 这里用等价算式独立推一遍，避免「改了后端、忘了前端」
        long goodsId = 12L, ua = 5L, ub = 4L;
        String frontend = "s_" + goodsId + "_" + Math.min(ua, ub) + "_" + Math.max(ua, ub);
        assertEquals(frontend, SessionId.of(goodsId, ua, ub));
    }
}
