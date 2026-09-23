package com.campus.market.common;

import java.math.BigDecimal;
import java.util.List;

/**
 * 文本长度 / 数值区间 / 枚举取值的边界校验工具
 * <p>
 * ★ 为什么必须在这一层拦 ★
 * <p>
 * MySQL 跑在 STRICT_TRANS_TABLES 下，写入超过列宽的值不会静默截断，而是直接抛
 * {@code Data too long for column 'xxx' at row 1}。这个异常从 Mapper 一路抛到
 * {@link GlobalExceptionHandler} 的兜底分支，用户看到的是 <b>code=500「服务器内部错误」</b>。
 * <p>
 * 后果有两层：
 * <ol>
 *   <li><b>用户看不懂</b>：明明是「昵称打了 80 个字」，却提示服务器内部错误，用户只会反复重试；</li>
 *   <li><b>监控失真</b>：真实的服务故障（DB 断连、空指针、第三方超时）也是 500，
 *       两者混在同一个指标里，报警就失去了指向性。</li>
 * </ol>
 * 所以每个「字符串要落进窄列」的入口都必须在业务层先量一次长度，超限时抛
 * {@link BusinessException#paramError}（1001），把「用户输错了」与「服务器坏了」分开。
 * <p>
 * <b>上限口径与 schema.sql 的列宽严格一致</b>（varchar(n) → n，TEXT → {@link #TEXT}）。
 * 列宽改动时这里必须同步改，否则又会出现「校验放行、DB 报错」的断层。
 */
public final class Validators {

    private Validators() {
    }

    /** TEXT 列的业务上限：列本身能存 64KB，但站内没有哪个输入框需要那么长 */
    public static final int TEXT = 2000;

    /**
     * 必填文本：null / 空白 → 1001；超长 → 1001。
     *
     * @return 去掉首尾空白后的值（落库的是 trim 过的文本，避免「空格占位」通过必填校验）
     */
    public static String required(String value, int max, String label) {
        if (value == null || value.isBlank()) {
            throw BusinessException.paramError(label + "不能为空");
        }
        String text = value.trim();
        if (text.length() > max) {
            throw BusinessException.paramError(label + "最多 " + max + " 个字（当前 " + text.length() + "）");
        }
        return text;
    }

    /**
     * 可选文本：null / 空白原样放行（用于局部更新里「没传这个字段」的场景）；超长 → 1001。
     *
     * @return 去掉首尾空白后的值；入参为空时返回原值（通常是 null）
     */
    public static String optional(String value, int max, String label) {
        if (value == null || value.isBlank()) {
            return value;
        }
        String text = value.trim();
        if (text.length() > max) {
            throw BusinessException.paramError(label + "最多 " + max + " 个字（当前 " + text.length() + "）");
        }
        return text;
    }

    /**
     * 必填文本 + <b>长度下限</b> + 上限。
     * <p>
     * ★ 为什么单独有下限 ★
     * {@link #required(String, int, String)} 只管「非空 + 不超列宽」，
     * 于是「1 个字符的口令」也能注册成功。而 {@code changePassword} 明确要求 ≥ 6 位 ——
     * 两条入口口径不一致的后果是：用户能注册一个**永远改不成**的弱口令账号
     * （改密时要 ≥6，而他手上只有 1 位）。
     * 下限是业务规则（防弱口令），上限是存储约束（防 Data too long），两者都要量。
     */
    public static String required(String value, int min, int max, String label) {
        String text = required(value, max, label);
        if (text.length() < min) {
            throw BusinessException.paramError(label + "至少 " + min + " 位（当前 " + text.length() + "）");
        }
        return text;
    }

    /**
     * 正则格式校验；null / 空白放行，非空时必须完全匹配。
     * <p>
     * 与 {@link #phone(String, String)} 同一套「可选字段」语义：调用方若要求必填，
     * 应先过 {@link #required}，再用本方法收敛格式。
     * <p>
     * ★ 为什么格式约束必须放在后端 ★
     * 前端的 {@code rules} 是**用户体验**而不是**边界**：任何人绕过页面直接调接口，
     * 前端校验就不存在了。用户名是登录凭据的一部分，允许任意字符（换行、emoji、
     * 零宽字符）会让「同名多条记录」这类问题无从排查。
     */
    public static String matches(String value, String regex, String label) {
        if (value == null || value.isBlank()) {
            return value;
        }
        String text = value.trim();
        if (!text.matches(regex)) {
            throw BusinessException.paramError(label + "格式不正确");
        }
        return text;
    }

    /** 整数区间校验；null 放行（局部更新语义）。返回原值以便链式使用 */
    public static Integer range(Integer value, int min, int max, String label) {
        if (value == null) {
            return null;
        }
        if (value < min || value > max) {
            throw BusinessException.paramError(label + "应在 " + min + " ~ " + max + " 之间（当前 " + value + "）");
        }
        return value;
    }

    /** 小数区间校验；null 放行。边界用字符串传入，避免 double 精度噪音 */
    public static BigDecimal range(BigDecimal value, String min, String max, String label) {
        if (value == null) {
            return null;
        }
        if (value.compareTo(new BigDecimal(min)) < 0 || value.compareTo(new BigDecimal(max)) > 0) {
            throw BusinessException.paramError(label + "应在 " + min + " ~ " + max + " 之间（当前 " + value + "）");
        }
        return value;
    }

    /**
     * 枚举白名单校验；null 放行。
     * <p>
     * 数据库层对 varchar 枚举列没有任何约束能力：{@code status='随便写的'} 照样能存进去，
     * 之后所有按枚举值筛选的查询都会静默漏掉这一行（列表里看不到、统计里也不算）。
     */
    public static String oneOf(String value, List<String> allowed, String label) {
        if (value == null) {
            return null;
        }
        if (!allowed.contains(value)) {
            throw BusinessException.paramError(label + "取值不合法：" + value);
        }
        return value;
    }

    /** 11 位手机号（也放行 3~4 位区号 + 7~8 位座机，中间可带 - ） */
    private static final java.util.regex.Pattern PHONE =
            java.util.regex.Pattern.compile("^1[3-9]\\d{9}$|^0\\d{2,3}-?\\d{7,8}$");

    /**
     * 手机号 / 座机号格式校验；null 或空白放行。
     * <p>
     * 收货电话是快递员唯一能联系到买家的方式，写错的代价是包裹退件；
     * 原先只校验长度，`abcdefghijk` 也能存进库（探针实测通过）。
     */
    public static String phone(String value, String label) {
        if (value == null || value.isBlank()) {
            return value;
        }
        String text = value.trim();
        if (text.length() > 20) {
            throw BusinessException.paramError(label + "最多 20 个字符（当前 " + text.length() + "）");
        }
        if (!PHONE.matcher(text).matches()) {
            throw BusinessException.paramError(label + "格式不正确，请填 11 位手机号或带区号的座机号");
        }
        return text;
    }

    /** 长度校验（不做非空判断，返回布尔）—— 供需要「先判空后判长」的特殊场景使用 */
    public static boolean tooLong(String value, int max) {
        return value != null && value.length() > max;
    }
}
