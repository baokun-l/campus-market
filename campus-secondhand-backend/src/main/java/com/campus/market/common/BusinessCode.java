package com.campus.market.common;

/**
 * 业务错误码枚举（与前端 BusinessCode 对齐）
 */
public class BusinessCode {
    public static final int SUCCESS = 0;
    public static final int UNAUTHORIZED = 401;
    public static final int FORBIDDEN = 403;
    public static final int NOT_FOUND = 404;
    public static final int SERVER_ERROR = 500;
    public static final int PARAM_ERROR = 1001;
    public static final int DATA_NOT_FOUND = 1002;
}
