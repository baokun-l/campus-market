package com.campus.market.service.pay;

import com.campus.market.config.PayProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

/**
 * 支付宝沙箱**主动查单**的响应映射测试。
 * <p>
 * ★★ 为什么这一层必须单独钉住 ★★
 * <p>
 * 「回调丢了要主动去问渠道」这件事的价值全在这几行映射上。而它最容易错的地方不是
 * 网络、不是签名，而是**把渠道的回答翻译错**：
 * <ul>
 *   <li>把 {@code WAIT_BUYER_PAY}（用户还站在收银台前）当成失败 ⇒ 一笔正常支付被判死；</li>
 *   <li>把「查单请求本身失败」当成「这笔没成」⇒ 一次网络抖动就足以产生错误的业务结论；</li>
 *   <li>把 {@code 40004 ACQ.TRADE_NOT_EXIST}（查无此单）当成异常 ⇒ 每轮对账都在同一个
 *       「用户压根没点支付」的单子上白报错，真问题被噪音淹没。</li>
 * </ul>
 * 这三种错误都不会让编译失败、也不会让别的测试变红，只会在对账时表现为「钱和单对不上」。
 * <p>
 * ★ 用真实响应报文而不是自造字段 ★
 * 下面的 JSON 是 {@code alipay.trade.query} 的真实响应形状（2026-09-23 真机抓到的字段名），
 * 尤其是外层节点名 {@code alipay_trade_query_response} —— 写错这个节点名会得到
 * 「响应无法解析」，而那是 {@code UNAVAILABLE}（什么都不做），不是错误结论，
 * 于是整条兜底能力**静默失效**：日志里一句错都没有，只是永远不会结算任何一笔。
 */
class AlipaySandboxQueryTest {

    private final AlipaySandboxPayChannel channel = new AlipaySandboxPayChannel(new PayProperties());

    private static String queryResponse(String inner) {
        return "{\"alipay_trade_query_response\":" + inner + ",\"sign\":\"FAKE\"}";
    }

    private PayChannel.QueryResult map(String inner) {
        return channel.mapQueryResponse("pay_20260923233755539000", queryResponse(inner));
    }

    /* ============================================================
     * 四态：PAID
     * ============================================================ */

    @Nested
    @DisplayName("渠道确认钱已到账 → PAID")
    class Paid {

        @Test
        @DisplayName("★★ TRADE_SUCCESS → PAID，且流水号与金额都要取出来")
        void tradeSuccessIsPaid() {
            PayChannel.QueryResult r = map("""
                    {"code":"10000","msg":"Success",
                     "trade_no":"2026092322001453090509431001",
                     "out_trade_no":"pay_20260923233755539000",
                     "trade_status":"TRADE_SUCCESS","total_amount":"12.00"}""");
            assertEquals(PayChannel.QueryOutcome.PAID, r.outcome());
            assertEquals("2026092322001453090509431001", r.tradeNo(),
                    "流水号是对账的唯一钥匙，丢了这笔钱就无法与渠道核对");
            assertNotNull(r.paidAmount());
            assertEquals(0, new BigDecimal("12.00").compareTo(r.paidAmount()));
        }

        @Test
        @DisplayName("TRADE_FINISHED 也算到账（与回调路径同一个口径）")
        void tradeFinishedIsPaid() {
            assertEquals(PayChannel.QueryOutcome.PAID, map("""
                    {"code":"10000","trade_status":"TRADE_FINISHED",
                     "trade_no":"t1","total_amount":"12.00"}""").outcome());
        }

        @Test
        @DisplayName("★ 金额缺失/不可解析时**仍是 PAID**，但金额为 null —— 由 Service 层按「金额不可信」拒绝")
        void missingAmountStaysPaidButAmountNull() {
            PayChannel.QueryResult r = map("""
                    {"code":"10000","trade_status":"TRADE_SUCCESS","trade_no":"t1"}""");
            assertEquals(PayChannel.QueryOutcome.PAID, r.outcome());
            assertNull(r.paidAmount());
            // 关键：绝不能把「拿不到金额」悄悄退化成 0 再去比大小 —— 那会让 0.00 == 0.00 通过闸门
        }

        @Test
        @DisplayName("★ 金额是脏字符串时同样只让金额为 null，不让整条结论变味")
        void unparsableAmountIsNull() {
            PayChannel.QueryResult r = map("""
                    {"code":"10000","trade_status":"TRADE_SUCCESS","trade_no":"t1",
                     "total_amount":"abc"}""");
            assertEquals(PayChannel.QueryOutcome.PAID, r.outcome());
            assertNull(r.paidAmount());
        }
    }

    /* ============================================================
     * 四态：NOT_PAID —— 这三种都必须「确认没成」，而不是「问不到」
     * ============================================================ */

    @Nested
    @DisplayName("渠道确认还没成 → NOT_PAID（★ 不许标失败）")
    class NotPaid {

        @Test
        @DisplayName("★★ WAIT_BUYER_PAY：用户还站在收银台前 —— 这是**正常状态**，不是失败")
        void waitBuyerPayIsNotPaid() {
            PayChannel.QueryResult r = map("""
                    {"code":"10000","trade_status":"WAIT_BUYER_PAY",
                     "out_trade_no":"pay_20260923233755539000"}""");
            assertEquals(PayChannel.QueryOutcome.NOT_PAID, r.outcome());
            assertTrue(r.message().contains("WAIT_BUYER_PAY"),
                    "把状态原文带出来，排障时不必再去支付宝后台翻");
        }

        @Test
        @DisplayName("TRADE_CLOSED：支付宝侧已关单 → 还没成（后续由超时关单任务收口）")
        void tradeClosedIsNotPaid() {
            assertEquals(PayChannel.QueryOutcome.NOT_PAID,
                    map("""
                            {"code":"10000","trade_status":"TRADE_CLOSED","trade_no":"t1"}""").outcome());
        }

        @Test
        @DisplayName("★★ 40004 ACQ.TRADE_NOT_EXIST（查无此单）是**结论**不是错误 —— 归 NOT_PAID 而非 UNAVAILABLE")
        void tradeNotExistIsNotPaid() {
            PayChannel.QueryResult r = map("""
                    {"code":"40004","msg":"Business Failed",
                     "sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在"}""");
            assertEquals(PayChannel.QueryOutcome.NOT_PAID, r.outcome(),
                    "归成 UNAVAILABLE 会让「用户根本没点支付」的单子被无限重问并刷满 WARN");
            assertNull(r.tradeNo());
        }
    }

    /* ============================================================
     * 四态：UNAVAILABLE —— 结论未知，不许据此改任何状态
     * ============================================================ */

    @Nested
    @DisplayName("问不到 → UNAVAILABLE（结论未知）")
    class Unavailable {

        @Test
        @DisplayName("★ 不认识的业务码 → UNAVAILABLE（不敢下结论，绝不猜成 PAID/NOT_PAID）")
        void unknownCodeIsUnavailable() {
            assertEquals(PayChannel.QueryOutcome.UNAVAILABLE,
                    map("""
                            {"code":"20000","msg":"Service Currently Unavailable",
                             "sub_code":"aop.unknown"}""").outcome());
        }

        @Test
        @DisplayName("★ 响应缺少 alipay_trade_query_response 节点 → UNAVAILABLE，且消息要点名缺的是哪个节点")
        void missingNodeIsUnavailable() {
            PayChannel.QueryResult r = channel.mapQueryResponse("pay_x",
                    "{\"wrong_node_name\":{\"code\":\"10000\",\"trade_status\":\"TRADE_SUCCESS\"}}");
            assertEquals(PayChannel.QueryOutcome.UNAVAILABLE, r.outcome(),
                    "节点名对不上却给出业务结论 ⇒ 整条兜底会静默失效或误判");
            /*
             * ★ 这条断言是红绿探针逼出来的 ★
             * 第一版只断言 outcome，而它是**蹭着「不认识的业务码」那条分支**通过的：
             * Jackson 的 path(key) 缺键时返回 MissingNode 而不是 null，所以原先的
             * `node == null` 守卫永远不成立，消息被拼成「code= sub_code=」（两个空串）。
             * 探针把「不认识的业务码」改成 NOT_PAID 时，这条用例**跟着一起红了** ——
             * 一个断言若和另一条能力共用一个出口，它的名字就名不副实。
             * 现在它锚在**自己那条分支的消息**上，两者可以各自被单独证伪。
             */
            assertTrue(r.message().contains("alipay_trade_query_response"),
                    "消息必须点名期望的节点名，否则这条日志回答不了「该去改哪儿」。实际：" + r.message());
        }

        @Test
        @DisplayName("★ 报文根本不是 JSON → UNAVAILABLE（不是「这笔没成」）")
        void malformedBodyIsUnavailable() {
            assertEquals(PayChannel.QueryOutcome.UNAVAILABLE,
                    channel.mapQueryResponse("pay_x", "<html>502 Bad Gateway</html>").outcome());
        }

        @Test
        @DisplayName("UNAVAILABLE 的工厂方法不带任何业务字段 —— 避免调用方拿半截数据去用")
        void unavailableCarriesNoBusinessFields() {
            PayChannel.QueryResult r = PayChannel.QueryResult.unavailable("boom");
            assertEquals(PayChannel.QueryOutcome.UNAVAILABLE, r.outcome());
            assertNull(r.tradeNo());
            assertNull(r.paidAmount());
            assertNull(r.outTradeNo());
        }
    }

    /* ============================================================
     * 渠道契约：谁可查单、谁不可
     * ============================================================ */

    @Nested
    @DisplayName("queryable()：筛选前置条件（不许靠调用 query 去试）")
    class Queryable {

        @Test
        @DisplayName("★ 支付宝沙箱：可查单")
        void alipayIsQueryable() {
            assertTrue(channel.queryable());
        }

        @Test
        @DisplayName("★★ 接口默认「不可查单」—— 同步渠道不该让对账任务去打渠道请求")
        void defaultIsNotQueryable() {
            PayChannel bare = mock(PayChannel.class, CALLS_REAL_METHODS);
            assertFalse(bare.queryable(),
                    "默认返回 true 会让对账任务对钱包/演示渠道发出没有意义的查单请求");
        }

        @Test
        @DisplayName("★★ 接口默认 query() 返回 UNSUPPORTED，而不是抛异常 / 返回 null")
        void defaultQueryIsUnsupported() {
            PayChannel bare = mock(PayChannel.class, CALLS_REAL_METHODS);
            PayChannel.QueryResult r = bare.query("pay_x");
            assertEquals(PayChannel.QueryOutcome.UNSUPPORTED, r.outcome(),
                    "抛异常或返回 null 会让调用方分不清「渠道不支持」与「渠道没查到」，"
                            + "而这两种情况的处置完全相反（跳过 vs 下一轮再问）");
        }

        @Test
        @DisplayName("★ 查单与回调是两条独立的能力，支付宝两条都要有")
        void alipaySupportsBothPaths() {
            assertTrue(channel.asyncNotify());
            assertTrue(channel.queryable());
            assertTrue(channel.refundable());
        }
    }
}
