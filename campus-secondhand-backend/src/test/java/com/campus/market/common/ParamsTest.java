package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 请求参数收敛工具测试。
 * <p>
 * 这一组守的是两个**曾经真实踩过的坑**：
 * <ol>
 *   <li><b>数组型查询参数绑不上</b>：axios 把数组序列化成 {@code statuses[]=on_sale}（带方括号），
 *       而 {@code @RequestParam List<String> statuses} 只按字面名匹配，结果**静默变 null** ——
 *       不报错、不抛异常，只是筛选条件悄悄失效，未过审商品直接混进买家广场。</li>
 *   <li><b>JSON 数组元素是 Integer 不是 Long</b>：Jackson 反序列化到 {@code Map<String,Object>}
 *       后是 Integer，泛型擦除让 {@code (List<Long>) raw} 编译期不报错，
 *       真正抛 ClassCastException 的时刻在**遍历取值**那一行。</li>
 * </ol>
 */
class ParamsTest {

    // ==================== multiValue：三种序列化形态都要能收 ====================

    @Test
    @DisplayName("形态一：name=a&name=b（重复键）")
    void shouldReadRepeatedKey() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setParameter("statuses", "on_sale", "sold");
        assertEquals(List.of("on_sale", "sold"), Params.multiValue(req, "statuses"));
    }

    @Test
    @DisplayName("形态二：name[]=a&name[]=b（axios 默认带方括号）—— 最容易漏的一种")
    void shouldReadBracketedKey() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setParameter("statuses[]", "on_sale", "sold");
        assertEquals(List.of("on_sale", "sold"), Params.multiValue(req, "statuses"));
    }

    @Test
    @DisplayName("形态三：name=a,b（逗号分隔）")
    void shouldReadCsvValue() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setParameter("statuses", "on_sale,sold");
        assertEquals(List.of("on_sale", "sold"), Params.multiValue(req, "statuses"));
    }

    @Test
    @DisplayName("混合形态去重且保持首次出现顺序")
    void shouldDedupeAcrossForms() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setParameter("statuses", "on_sale", "sold");
        req.setParameter("statuses[]", "sold", "pending");
        assertEquals(List.of("on_sale", "sold", "pending"), Params.multiValue(req, "statuses"));
    }

    @Test
    @DisplayName("一个都没传 → 空列表（由 Service 决定退回默认可见范围）")
    void shouldReturnEmptyWhenAbsent() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        assertTrue(Params.multiValue(req, "statuses").isEmpty());
        // 脏值也必须被清掉，不能让空串混进 SQL 的 IN 列表
        req.setParameter("statuses", "  ,  ", "");
        assertTrue(Params.multiValue(req, "statuses").isEmpty());
    }

    @Test
    @DisplayName("入参为 null / 空白名不抛异常")
    void shouldTolerateNullInputs() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        assertTrue(Params.multiValue(null, "statuses").isEmpty());
        assertTrue(Params.multiValue(req, null).isEmpty());
        assertTrue(Params.multiValue(req, "   ").isEmpty());
    }

    // ==================== toLongList：Integer → Long 的坑 ====================

    @Test
    @DisplayName("JSON 数组反序列化出的 Integer 元素能被收敛成 Long")
    void shouldConvertIntegerElementsToLong() {
        List<Object> fromJackson = new ArrayList<>(List.of(1, 2, 3)); // Integer
        assertEquals(List.of(1L, 2L, 3L), Params.toLongList(fromJackson));
    }

    @Test
    @DisplayName("字符串数字同样能收敛（query 参数与 body 共用）")
    void shouldConvertStringElementsToLong() {
        assertEquals(List.of(10L, 20L), Params.toLongList(List.of("10", "20")));
    }

    @Test
    @DisplayName("非数组 / 空值 → 空列表，不抛异常")
    void shouldReturnEmptyForNonList() {
        assertTrue(Params.toLongList(null).isEmpty());
        assertTrue(Params.toLongList("1,2,3").isEmpty());
        assertTrue(Params.toLongList(List.of()).isEmpty());
    }

    @Test
    @DisplayName("null 元素被过滤掉")
    void shouldFilterNullElements() {
        List<Object> raw = new ArrayList<>();
        raw.add(1);
        raw.add(null);
        raw.add(2);
        assertEquals(List.of(1L, 2L), Params.toLongList(raw));
    }

    @Test
    @DisplayName("非法数字给出可读错误，而不是 NumberFormatException 打到 500")
    void shouldThrowBusinessErrorOnBadNumber() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> Params.requiredLong("abc", "goodsId"));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
    }

    @Test
    @DisplayName("requiredLong 缺参时报 1001 并带上字段名")
    void shouldReportMissingFieldName() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> Params.requiredLong(null, "goodsId"));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
        assertTrue(ex.getMessage().contains("goodsId"));
        assertEquals(7L, Params.requiredLong(7, "goodsId").longValue());
        assertEquals(7L, Params.requiredLong("7", "goodsId").longValue());
    }

    // ==================== toStringList / splitCsv ====================

    @Test
    @DisplayName("订单号这类字符串主键：数字数组也不会 ClassCastException")
    void shouldConvertToStringListSafely() {
        assertEquals(List.of("202600001", "202600002"),
                Params.toStringList(List.of(202600001, 202600002)));
        assertTrue(Params.toStringList(null).isEmpty());
    }

    @Test
    @DisplayName("toStringList 丢掉 null 与空白串")
    void shouldDropBlankInStringList() {
        List<Object> raw = new ArrayList<>();
        raw.add("A");
        raw.add(null);
        raw.add("  ");
        raw.add("B");
        assertEquals(List.of("A", "B"), Params.toStringList(raw));
    }

    @Test
    @DisplayName("splitCsv 去空格、丢空项")
    void shouldSplitCsv() {
        assertEquals(List.of("a", "b"), Params.splitCsv(" a , b "));
        assertEquals(List.of("a"), Params.splitCsv("a"));
        assertTrue(Params.splitCsv(null).isEmpty());
        assertTrue(Params.splitCsv(" , ").isEmpty());
    }
}
