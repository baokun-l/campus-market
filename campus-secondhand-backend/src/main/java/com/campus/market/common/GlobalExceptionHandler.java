package com.campus.market.common;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 全局异常处理：统一异常 → Result JSON 响应
 * <p>
 * 约定：所有错误一律 **HTTP 200 + body 里的业务码**，前端 {@code api/request.ts}
 * 按 {@code res.code} 分流（401 → 去登录、403 → 无权限提示、其余 → 弹 message）。
 * <p>
 * ★ 本类修过三处 ★
 * <ol>
 *   <li><b>信息泄露</b>：原来兜底分支把 {@code e.getMessage()} 原样返回给前端，
 *       等于把 SQL 语句片段、表名、空指针的类名行号这类内部细节直接吐给调用方。
 *       现在改为「日志记全量、响应给通用文案」。</li>
 *   <li><b>错误码错位</b>：{@code GET /orders/abc/logs} 这类路径变量类型不符、
 *       请求体不是合法 JSON，原先都会落到兜底分支变成 500「服务器异常」，
 *       让人以为是后端挂了。现在这两类归为 1001 参数错误。</li>
 *   <li><b>错误码错位的另一半（09-21 补）</b>：<b>HTTP 方法不对</b>
 *       （对只支持 GET 的接口发 POST）与 <b>Content-Type 不对</b> 同样曾落到兜底分支变 500。
 *       这一类在接口文档公开之后特别容易被撞上 —— 而「文档里有这个接口」会让 500
 *       显得更像后端故障。现在两者都归 1001，并在文案里带上「只支持 GET」这类提示。</li>
 * </ol>
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BusinessException.class)
    public Result<Void> handleBusiness(BusinessException e) {
        return Result.error(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<Void> handleValidation(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + ": " + f.getDefaultMessage())
                .reduce((a, b) -> a + "; " + b)
                .orElse("参数校验失败");
        return Result.error(BusinessCode.PARAM_ERROR, msg);
    }

    /** 路径变量 / 查询参数类型不符，如 {@code /orders/abc/logs}、{@code ?page=xyz} */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public Result<Void> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        log.warn("参数类型不匹配: {} = {}", e.getName(), e.getValue());
        return Result.error(BusinessCode.PARAM_ERROR, "参数 " + e.getName() + " 格式不正确");
    }

    /** 请求体不是合法 JSON / 字段类型对不上 */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public Result<Void> handleUnreadable(HttpMessageNotReadableException e) {
        log.warn("请求体解析失败: {}", e.getMessage());
        return Result.error(BusinessCode.PARAM_ERROR, "请求体格式不正确");
    }

    /** 静态资源 / 路由不存在：应回 404 语义，而不是当成服务器错误 */
    @ExceptionHandler(NoResourceFoundException.class)
    public Result<Void> handleNoResource(NoResourceFoundException e) {
        return Result.error(BusinessCode.NOT_FOUND, "接口不存在");
    }

    /**
     * 路径存在、但 HTTP 方法不对（例：对只支持 GET 的接口发 POST）。
     * <p>
     * ★ 这一类同样属「把客户端的错报成服务器的错」★
     * {@code HttpRequestMethodNotSupportedException} 原先没有专门的处理器，会落到兜底分支
     * 变成 500「服务器内部错误」—— 用户以为是后端挂了，实际是自己调错了方法；
     * 更糟的是监控里这类请求会混进真实故障（DB 断连、空指针）的同一个指标里，报警失去指向性。
     * 这与类注释里第 2 条修的是同一类问题（{@code /orders/abc/logs} 的类型不符），
     * 本轮补齐这一类。
     * <p>
     * ★ 为什么容易在接入接口文档之后暴露出来 ★
     * Swagger UI 公开之后，任何人都会去试着点/手敲两下，用错方法是最先撞上的一种；
     * 而且「文档里明明有这个接口」会让 500 显得更像后端故障。
     * <p>
     * 响应里带上**当前接口支持的方法**（如 GET），调用方一眼就知道该怎么改。
     * 按项目约定仍用 1001（与 404/500 的划分一致：这是「请求写错了」，不是「服务器坏了」）。
     */
    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public Result<Void> handleMethodNotSupported(
            org.springframework.web.HttpRequestMethodNotSupportedException e) {
        String[] supported = e.getSupportedMethods();
        String hint = (supported == null || supported.length == 0)
                ? "" : "，该接口只支持 " + String.join(" / ", supported);
        log.warn("请求方法不支持: {} {}", e.getMethod(), e.getMessage());
        return Result.error(BusinessCode.PARAM_ERROR,
                "请求方法 " + e.getMethod() + " 不被支持" + hint);
    }

    /**
     * Content-Type 不受支持（例：该传 JSON 却传了表单 / 纯文本）。
     * 同上：这是客户端的错，不该报成 500。
     */
    @ExceptionHandler(org.springframework.web.HttpMediaTypeNotSupportedException.class)
    public Result<Void> handleMediaTypeNotSupported(
            org.springframework.web.HttpMediaTypeNotSupportedException e) {
        log.warn("请求 Content-Type 不支持: {}", e.getContentType());
        return Result.error(BusinessCode.PARAM_ERROR,
                "请求 Content-Type 不支持，请使用 application/json");
    }

    /** 兜底：内部细节只进日志，响应给通用文案 */
    @ExceptionHandler(Exception.class)
    public Result<Void> handleOther(Exception e) {
        log.error("未捕获异常", e);
        return Result.error(BusinessCode.SERVER_ERROR, "服务器内部错误，请稍后再试");
    }
}
