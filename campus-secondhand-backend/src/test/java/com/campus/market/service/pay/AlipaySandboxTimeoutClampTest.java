package com.campus.market.service.pay;

import com.campus.market.config.PayProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 沙箱 {@code timeout_express} 上限钳制。
 * <p>
 * ★ 为什么值得单独一条测试 ★
 * 这条上限（15 小时）只写在支付宝官方帮助文档的「注意事项」里，不在接口参数表里，
 * 越界时收银台报的是笼统的 {@code INVALID_PARAMETER「订单信息无法识别」}——
 * 从现象完全看不出是超时参数的问题（2026-09-23 真机踩过，签名/金额/notify_url 逐一排除后才定位）。
 * 有了这条断言，以后谁把 {@code app.pay.order-timeout-minutes} 配大到越界，
 * 单测当场能看见「会被钳制」，而不是等用户点开收银台才报错。
 */
class AlipaySandboxTimeoutClampTest {

    private AlipaySandboxPayChannel channelWith(int orderTimeoutMinutes) {
        PayProperties props = new PayProperties();
        ReflectionTestUtils.setField(props, "orderTimeoutMinutes", orderTimeoutMinutes);
        return new AlipaySandboxPayChannel(props);
    }

    @Nested
    @DisplayName("沙箱上限 15h：越界钳制 / 未越界透传")
    class Clamp {

        @Test
        @DisplayName("★★ 默认 1440 分钟（1d）越界 ⇒ 钳制为 14h（真机：1d 报 INVALID_PARAMETER）")
        void clampsDayLongTimeout() {
            assertEquals("14h", channelWith(1440).sandboxTimeout());
        }

        @Test
        @DisplayName("★ 钳制结果必须落在 15h 上限内（不锚字样，锚能力）")
        void clampedValueStaysWithinSandboxLimit() {
            String v = channelWith(1440).sandboxTimeout();
            assertEquals(14 * 60, minutesOf(v), "钳制后的小时数必须 ≤ 15h，且单位要让支付宝认得出");
            assertTrue(minutesOf(v) < 15 * 60);
        }

        @Test
        @DisplayName("840 分钟（14h）正好在上限内 ⇒ 原样透传")
        void keepsInRangeValue() {
            assertEquals("14h", channelWith(840).sandboxTimeout());
        }

        @Test
        @DisplayName("60 分钟 ⇒ 1h，钳制逻辑不该影响正常配置")
        void keepsSmallValue() {
            assertEquals("1h", channelWith(60).sandboxTimeout());
        }

        @Test
        @DisplayName("90 分钟 ⇒ 90m（非整小时走分钟单位）")
        void keepsMinuteUnit() {
            assertEquals("90m", channelWith(90).sandboxTimeout());
        }

        private static int minutesOf(String express) {
            char unit = express.charAt(express.length() - 1);
            int n = Integer.parseInt(express.substring(0, express.length() - 1));
            return switch (unit) {
                case 'd' -> n * 1440;
                case 'h' -> n * 60;
                default -> n;
            };
        }
    }
}
