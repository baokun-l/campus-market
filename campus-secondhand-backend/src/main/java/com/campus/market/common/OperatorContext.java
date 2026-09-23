package com.campus.market.common;

import com.campus.market.interceptor.AuthInterceptor;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 当前操作人解析 —— 审计日志落款用。
 * <p>
 * ★ 为什么不再写死 {@code operator = "admin"} ★
 * <p>
 * 审计日志的价值在于「出了事能查到是谁做的」。原先除活动模块外，
 * 各 Service 的审计流水一律落 {@code admin}：管理员重置了谁的密码、
 * 哪个卖家删了商品、用户自己改了密码 —— 全都记成 admin，
 * 出争议时（「我没改过这个价格」「不是我删的」）拿不出证据。
 * <p>
 * 实现上走 {@link RequestContextHolder}：拦截器已经把用户名放进了请求属性
 * （{@link AuthInterceptor#ATTR_USERNAME}），Service 层不必为此改方法签名，
 * 从请求上下文里取即可。取不到（单元测试 / 定时任务等无请求上下文的场景）
 * 返回 {@code "system"}，绝不能因为取操作人把正常业务打断。
 */
public final class OperatorContext {

    private OperatorContext() {
    }

    /** 当前登录用户的用户名；无请求上下文时返回 "system" */
    public static String currentOperator() {
        RequestAttributes ra = RequestContextHolder.getRequestAttributes();
        if (ra instanceof ServletRequestAttributes sra) {
            Object name = sra.getRequest().getAttribute(AuthInterceptor.ATTR_USERNAME);
            if (name instanceof String s && !s.isBlank()) return s;
        }
        return "system";
    }
}
