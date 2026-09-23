package com.campus.market.common;

import jakarta.servlet.http.HttpServletRequest;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * 请求参数收敛工具
 * <p>
 * 前端批量接口传的是 JSON 数组（{@code {"ids": [1,2,3]} }），Jackson 反序列化到
 * {@code Map<String, Object>} 后元素类型是 **Integer**，直接
 * {@code (List<Long>) body.get("ids")} 会在遍历时抛 ClassCastException
 * （泛型擦除让强转本身不报错，报错发生在取值那一刻）。
 * 统一走这里按字符串再解析成 Long，顺带过滤 null。
 */
public final class Params {

    private Params() {
    }

    /** 把任意 JSON 数组收敛为 List&lt;Long&gt;；非数组/空返回空列表 */
    public static List<Long> toLongList(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        return list.stream()
                .filter(Objects::nonNull)
                .map(o -> Long.valueOf(o.toString()))
                .toList();
    }

    /** 取必填 Long（用于 body.get("goodsId") 这类可能为 Integer 的字段） */
    public static Long requiredLong(Object raw, String field) {
        if (raw == null) {
            throw BusinessException.paramError("缺少参数：" + field);
        }
        try {
            return Long.valueOf(raw.toString());
        } catch (NumberFormatException e) {
            throw BusinessException.paramError("参数格式错误：" + field);
        }
    }

    /**
     * 把任意 JSON 数组收敛为 List&lt;String&gt;；非数组/空返回空列表。
     * <p>
     * 用于订单号这类**字符串主键**的批量入参：前端传 {@code ["202600001","202600002"]}，
     * 直接 {@code (List<String>) body.get("ids")} 在泛型擦除下编译不报错，
     * 但若调用方传的是数字数组，遍历取值那一刻才会抛 ClassCastException。
     */
    public static List<String> toStringList(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        return list.stream()
                .filter(Objects::nonNull)
                .map(Object::toString)
                .filter(s -> !s.isBlank())
                .toList();
    }

    /**
     * 取可选的逗号分隔多值参数（如 {@code statusIn=refunding,cancelled}）。
     */
    public static List<String> splitCsv(Object raw) {
        if (raw == null) {
            return List.of();
        }
        String text = raw.toString().trim();
        if (text.isEmpty()) {
            return List.of();
        }
        return java.util.Arrays.stream(text.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    /**
     * 读取「数组型查询参数」—— 一次收下前端可能发出的所有形态。
     * <p>
     * ★ 为什么不能直接用 {@code @RequestParam List<String>}：
     * axios 默认把数组序列化成 {@code statuses[]=on_sale&statuses[]=sold}（带方括号），
     * 而 Spring 的 {@code @RequestParam} 只按**字面名**取参数值，
     * `statuses` 与 `statuses[]` 是两个不同的键 —— 绑不上就静默变成 null。
     * <p>
     * 后果不是报错，而是**筛选条件悄悄失效**：买家侧商品广场靠
     * {@code statuses=[on_sale, sold]} 这个白名单挡住「审核中 / 已下架」的商品，
     * 白名单一丢，未过审和已下架的商品就直接出现在广场里，点进去才发现买不了。
     * 这类 bug 不报错、只在特定入口露头，最难查。
     * <p>
     * 所以这里把三种形态一起收：{@code name=a&name=b}、{@code name[]=a&name[]=b}、
     * {@code name=a,b}，不依赖前端的序列化实现。
     *
     * @param name 参数名（不带方括号）
     * @return 去重后的取值列表；一个都没有则返回空列表
     */
    public static List<String> multiValue(HttpServletRequest request, String name) {
        if (request == null || name == null || name.isBlank()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String key : new String[]{name, name + "[]"}) {
            String[] values = request.getParameterValues(key);
            if (values == null) continue;
            for (String v : values) {
                out.addAll(splitCsv(v));
            }
        }
        return out.stream().distinct().toList();
    }
}
