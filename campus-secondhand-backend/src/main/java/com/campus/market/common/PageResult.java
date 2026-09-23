package com.campus.market.common;

import lombok.Data;

import java.util.List;

/**
 * 分页响应体（与前端 PageResult 对齐）
 * <p>
 * ★ 回显值必须等于「数据库实际生效的值」★
 * <p>
 * 原先是「请求什么就回显什么」：{@code GET /goods?pageSize=100000} 会原样回显 100000，
 * 而 MyBatis-Plus 的 {@code PaginationInnerInterceptor}（{@code MaxLimit}）早把它钳到了
 * {@link #MAX_PAGE_SIZE}，真正查回来的只有 500 条。前端拿回显值算总页数
 * （{@code Math.ceil(total / pageSize)}）→ 以为有 200 页，翻到第 2 页却什么都拿不到，
 * 表现成「翻页错位 / 后半段空白」。这类不一致不报错，只在页码边界露头，最难查。
 * <p>
 * 所以统一在这里收敛一次，并且上限**复用同一个常量** ——
 * {@code MybatisPlusConfig} 的 {@code MaxLimit} 也读 {@link #MAX_PAGE_SIZE}，
 * 两处不可能再对不上（改一处即同步）。
 * <p>
 * 之所以选在 {@code of()} 里做而不是逐个 Controller 钳：本项目 13 处分页接口**全部**经由
 * 本方法构造响应，改一处即全覆盖。原先只有 {@code OrderController} 自己钳了一次
 * （:156 的 {@code clamp(pageSize)}），其余 12 处直接回显原值，口径不一致才是缺陷的根源。
 */
@Data
public class PageResult<T> {

    /**
     * 单页最大条数。
     * <p>
     * 必须与 {@code MybatisPlusConfig} 里 {@code PaginationInnerInterceptor.setMaxLimit(...)}
     * 的取值一致 —— 只改这里即可（那边直接引用本常量），不要在两处各写一个数字。
     */
    public static final int MAX_PAGE_SIZE = 500;

    private List<T> list;
    private long total;
    private int page;
    private int pageSize;

    public static <T> PageResult<T> of(List<T> list, long total, int page, int pageSize) {
        PageResult<T> r = new PageResult<>();
        r.list = list;
        r.total = total;
        /*
         * 页码：下限 1。
         * Page.offset() 对 current <= 0 是按 0 偏移算的（等价于第 1 页），所以回显 1 与
         * 真实结果一致；而回显 0 / 负数会让前端算出「共 0 页 / 负页数」。
         */
        r.page = Math.max(1, page);
        /*
         * 页长：先钳上限（与 MaxLimit 对齐），再兜下限。
         * size <= 0 说明调用方没给有效值，按「单页上限」处理 —— 这与 MyBatis-Plus
         * MaxLimit 对非法 size 的兜底口径一致（实测日志中 LIMIT 为 500，见
         * docs/后端设计说明.md「附八 分页回显口径」）。
         */
        r.pageSize = pageSize > 0 ? Math.min(MAX_PAGE_SIZE, pageSize) : MAX_PAGE_SIZE;
        return r;
    }
}
