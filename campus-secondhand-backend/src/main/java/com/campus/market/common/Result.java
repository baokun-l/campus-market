package com.campus.market.common;

import lombok.Data;

/**
 * 后端标准响应体（与前端 ApiResponse 对齐）
 * <pre>
 * { "code": 0, "message": "success", "data": {...} }
 * </pre>
 */
@Data
public class Result<T> {
    private int code;
    private String message;
    private T data;

    public static <T> Result<T> success(T data) {
        Result<T> r = new Result<>();
        r.code = BusinessCode.SUCCESS;
        r.message = "success";
        r.data = data;
        return r;
    }

    public static <T> Result<T> success() {
        return success(null);
    }

    public static <T> Result<T> error(int code, String message) {
        Result<T> r = new Result<>();
        r.code = code;
        r.message = message;
        return r;
    }

    /**
     * ★ 已废弃，不要再调用 ★
     * <p>
     * 它把错误码隐式固定为 {@code SERVER_ERROR(500)}。而 500 在本项目的语义约定里
     * 是「**真正的未捕获故障**」，只应由 {@code GlobalExceptionHandler} 的兜底分支产出。
     * 一旦有人用它返回「商品不存在」「参数不对」这类业务拒绝，
     * 监控里就会出现一批假的「服务端异常」，真故障被淹没
     * （{@code BusinessException} 历史上就是这么把 21 处业务拒绝报成 500 的）。
     * <p>
     * 现在它**没有任何调用方**，保留仅为二进制兼容。新代码请用：
     * {@link #error(int, String)}，错误码取 {@code BusinessCode} 中的语义值。
     */
    @Deprecated(since = "2026-09-17", forRemoval = false)
    public static <T> Result<T> error(String message) {
        return error(BusinessCode.SERVER_ERROR, message);
    }
}
