package com.campus.market.common;

/**
 * 会话 id 规则：{@code s_{goodsId}_{minUserId}_{maxUserId}}
 * <p>
 * 关键点是**对称**：买卖双方各自算出来的 id 必须一模一样，
 * 否则同一段对话会在两个人的消息中心裂成两条互不相干的会话。
 * 所以两个 userId 先排序再拼接，且不区分谁先发起。
 * <p>
 * 与前端 {@code mock.ts} 的 {@code makeSessionId()} 保持同一规则，
 * 保证 Mock 数据与真实后端数据可以无感切换。
 */
public final class SessionId {

    private SessionId() {
    }

    public static String of(Long goodsId, Long userA, Long userB) {
        long g = goodsId == null ? 0L : goodsId;
        long a = userA == null ? 0L : userA;
        long b = userB == null ? 0L : userB;
        return "s_" + g + "_" + Math.min(a, b) + "_" + Math.max(a, b);
    }

    /** 从会话 id 反解商品 id；解析失败返回 null */
    public static Long goodsIdOf(String sessionId) {
        if (sessionId == null) return null;
        String[] parts = sessionId.split("_");
        if (parts.length < 4) return null;
        try {
            return Long.valueOf(parts[1]);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
