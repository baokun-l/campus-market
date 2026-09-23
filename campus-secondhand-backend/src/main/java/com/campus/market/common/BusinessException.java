package com.campus.market.common;

import lombok.Getter;

/**
 * 自定义业务异常
 * <p>
 * ★ 语义约定（改过一次，别改回去）★
 * <p>
 * 单参构造 {@link #of(String)} 的默认码原来是 {@code SERVER_ERROR(500)}，
 * 结果「商品不存在」「库存不足」「不能购买自己发布的商品」这类**业务规则拒绝**
 * 全部被报成 500。危害有两层：
 * <ul>
 *   <li><b>可观测性</b>：{@code GlobalExceptionHandler} 会把 500 按 error 级记日志并断言，
 *       一个用户输错密码就能在监控里造出一堆「服务端异常」告警，真正的故障反而被淹没。</li>
 *   <li><b>契约错位</b>：{@code BusinessCode} 里明明定义了 1001 / 1002 / 403，
 *       却几乎没有出口用到，前端拿到的永远是 500，没法按码分流。</li>
 * </ul>
 * 现在单参默认归为 {@link BusinessCode#PARAM_ERROR}（业务规则不满足），
 * <b>500 只由 {@code GlobalExceptionHandler} 的兜底分支产出</b>，代表真正的未捕获故障。
 */
@Getter
public class BusinessException extends RuntimeException {
    private final int code;

    public BusinessException(String message) {
        super(message);
        this.code = BusinessCode.PARAM_ERROR;
    }

    public BusinessException(int code, String message) {
        super(message);
        this.code = code;
    }

    public static BusinessException of(String message) {
        return new BusinessException(message);
    }

    public static BusinessException of(int code, String message) {
        return new BusinessException(code, message);
    }

    /** 越权：登录了，但操作的不是自己的资源 */
    public static BusinessException forbidden(String message) {
        return new BusinessException(BusinessCode.FORBIDDEN, message);
    }

    /** 入参不合法 */
    public static BusinessException paramError(String message) {
        return new BusinessException(BusinessCode.PARAM_ERROR, message);
    }

    /** 目标资源不存在 */
    public static BusinessException notFound(String message) {
        return new BusinessException(BusinessCode.NOT_FOUND, message);
    }
}
