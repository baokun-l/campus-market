package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 全局异常处理器「客户端的错 vs 服务器的错」边界测试。
 * <p>
 * ★ 为什么要单独守这条边界 ★
 * <p>
 * 本项目 500 的语义被刻意收窄成「**真正的未捕获故障**」：它不是「出错了」的通用码，
 * 而是「后端坏了」的专用码 —— 监控与值班都以此为准。这条边界一旦被磨掉，
 * 就会出现一批假的「服务端异常」把真故障淹没（历史上 {@code BusinessException}
 * 就是这么把 21 处业务拒绝报成 500 的，见 {@link Result#error(String)} 的废弃说明）。
 * <p>
 * 本轮补的是这条边界上**最后两个缺口**：HTTP 方法不对、Content-Type 不对。
 * 它们原先都没有专门的处理器，直接落到兜底分支 ⇒ 500。
 * 在接口文档公开之后这类误用特别容易发生（文档里明明有那个接口，用户就想点一下），
 * 而「文档里有」这个事实会让 500 显得更像后端故障。
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    @DisplayName("★ HTTP 方法不对 → 1001 并提示支持的方法，绝不能是 500")
    void methodNotSupportedIsClientError() {
        // 注：带 String[] 的构造器是 private，公开的是 Collection<String> 那个
        Result<Void> r = handler.handleMethodNotSupported(
                new HttpRequestMethodNotSupportedException("POST", java.util.List.of("GET")));

        assertNotEquals(BusinessCode.SERVER_ERROR, r.getCode(),
                "方法不对是客户端写错了请求，报成 500 会让监控里混进假的「服务端异常」");
        assertEquals(BusinessCode.PARAM_ERROR, r.getCode());
        assertTrue(r.getMessage().contains("POST"), "要告诉调用方他用的是哪个方法，实际=" + r.getMessage());
        assertTrue(r.getMessage().contains("GET"), "还要告诉他该用哪个方法，实际=" + r.getMessage());
    }

    @Test
    @DisplayName("拿不到支持方法列表时也要给出可用文案，且仍然是 1001")
    void methodNotSupportedWithoutSupportedList() {
        Result<Void> r = handler.handleMethodNotSupported(
                new HttpRequestMethodNotSupportedException("DELETE"));

        assertEquals(BusinessCode.PARAM_ERROR, r.getCode());
        assertTrue(r.getMessage().contains("DELETE"), "实际=" + r.getMessage());
        assertFalse(r.getMessage().contains("null"),
                "拼接时不能漏出 null，实际=" + r.getMessage());
    }

    @Test
    @DisplayName("★ Content-Type 不对 → 1001，不是 500")
    void mediaTypeNotSupportedIsClientError() {
        // 注：没有 (MediaType) 单参构造器，公开的是 (MediaType, List<MediaType>)
        Result<Void> r = handler.handleMediaTypeNotSupported(
                new HttpMediaTypeNotSupportedException(
                        MediaType.TEXT_PLAIN, java.util.List.of(MediaType.APPLICATION_JSON)));

        assertEquals(BusinessCode.PARAM_ERROR, r.getCode());
        assertTrue(r.getMessage().contains("application/json"),
                "要直接告诉调用方该用什么，实际=" + r.getMessage());
    }

    @Test
    @DisplayName("路径不存在 → 404（已有行为，别在补新分支时改坏）")
    void noResourceIsNotFound() {
        Result<Void> r = handler.handleNoResource(
                new NoResourceFoundException(org.springframework.http.HttpMethod.GET, "/nope"));

        assertEquals(BusinessCode.NOT_FOUND, r.getCode());
    }

    @Test
    @DisplayName("★ 兜底分支仍然是 500，且不把内部细节回传给调用方")
    void fallbackStaysServerErrorWithoutLeakingDetail() {
        Result<Void> r = handler.handleOther(
                new IllegalStateException("Table 'campus_market.t_goods' doesn't exist"));

        assertEquals(BusinessCode.SERVER_ERROR, r.getCode(),
                "兜底仍然是 500 —— 上面几条新增分支不能把这条也一起放宽");
        assertFalse(r.getMessage().contains("t_goods"),
                "内部细节（表名 / SQL / 类名行号）只进日志，不能出现在响应里，实际=" + r.getMessage());
        assertFalse(r.getMessage().contains("IllegalState"),
                "异常类名也不能回传，实际=" + r.getMessage());
    }
}
