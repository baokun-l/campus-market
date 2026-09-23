package com.campus.market.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 错误码语义与响应体契约测试。
 * <p>
 * 这一组守的是**可观测性**：{@code BusinessException} 的单参默认码曾经是 500，
 * 导致「不能购买自己发布的商品」「库存不足」这类业务拒绝全部被报成服务端故障。
 * 后果是真故障被淹没 —— 光靠用户输错密码就能在监控里刷出一堆「服务端异常」告警。
 */
class BusinessExceptionTest {

    @Test
    @DisplayName("单参工厂默认 1001（业务规则拒绝），不再是 500")
    void singleArgShouldDefaultToParamError() {
        BusinessException ex = BusinessException.of("不能购买自己发布的商品");
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
        assertEquals(1001, ex.getCode());
        assertTrue(ex.getCode() != BusinessCode.SERVER_ERROR,
                "业务拒绝绝不能是 500 —— 否则日志里真假故障分不开");
    }

    @Test
    @DisplayName("语义化工厂各自映射到正确码：403 / 404 / 1001")
    void semanticFactoriesShouldMapToRightCodes() {
        assertEquals(BusinessCode.FORBIDDEN, BusinessException.forbidden("无权操作他人商品").getCode());
        assertEquals(BusinessCode.NOT_FOUND, BusinessException.notFound("商品不存在").getCode());
        assertEquals(BusinessCode.PARAM_ERROR, BusinessException.paramError("参数不合法").getCode());
    }

    @Test
    @DisplayName("双参工厂可自定义码（用于 1002 这类特殊语义）")
    void twoArgShouldKeepCustomCode() {
        BusinessException ex = BusinessException.of(BusinessCode.DATA_NOT_FOUND, "数据已不存在");
        assertEquals(BusinessCode.DATA_NOT_FOUND, ex.getCode());
        assertEquals(1002, ex.getCode());
    }

    @Test
    @DisplayName("必须继承 RuntimeException —— 否则 @Transactional 不会回滚")
    void shouldBeRuntimeExceptionSoTransactionRollsBack() {
        // ★ 这条是事务正确性的前提：Spring 默认只在 RuntimeException / Error 上回滚。
        //   若改成受检异常，下单扣了库存再抛错就会留下脏数据。
        assertTrue(RuntimeException.class.isAssignableFrom(BusinessException.class));
        assertTrue(new BusinessException("x") instanceof RuntimeException);
    }

    @Test
    @DisplayName("message 原样透传给前端")
    void shouldCarryMessage() {
        assertEquals("商品不存在", BusinessException.notFound("商品不存在").getMessage());
    }

    // ==================== Result / PageResult 契约 ====================

    @Test
    @DisplayName("Result.success() 码 0、message=success")
    void successShape() {
        Result<Void> r = Result.success();
        assertEquals(BusinessCode.SUCCESS, r.getCode());
        assertEquals(0, r.getCode());
        assertEquals("success", r.getMessage());
        assertNull(r.getData());
    }

    @Test
    @DisplayName("Result.success(data) 原样携带数据")
    void successWithData() {
        Result<String> r = Result.success("hello");
        assertEquals(0, r.getCode());
        assertEquals("hello", r.getData());
    }

    @Test
    @DisplayName("Result.error(code,msg) 按指定码返回，data 为 null")
    void errorShape() {
        Result<Void> r = Result.error(BusinessCode.PARAM_ERROR, "参数错误");
        assertEquals(1001, r.getCode());
        assertEquals("参数错误", r.getMessage());
        assertNull(r.getData());
    }

    @Test
    @DisplayName("分页体字段名必须是 list / total / page / pageSize（前端按此声明类型）")
    void pageResultShape() {
        PageResult<String> p = PageResult.of(java.util.List.of("a", "b"), 42L, 2, 10);
        assertEquals(java.util.List.of("a", "b"), p.getList());
        assertEquals(42L, p.getTotal());
        assertEquals(2, p.getPage());
        assertEquals(10, p.getPageSize());
        // 前端读的是 list，历史上后端曾用过 records —— 改回去会让所有列表页空白
        assertNotNull(p.getList());
    }

    @Test
    @DisplayName("BusinessCode 常量与前端约定一一对齐")
    void businessCodeContract() {
        assertEquals(0, BusinessCode.SUCCESS);
        assertEquals(401, BusinessCode.UNAUTHORIZED);
        assertEquals(403, BusinessCode.FORBIDDEN);
        assertEquals(404, BusinessCode.NOT_FOUND);
        assertEquals(500, BusinessCode.SERVER_ERROR);
        assertEquals(1001, BusinessCode.PARAM_ERROR);
        assertEquals(1002, BusinessCode.DATA_NOT_FOUND);
    }

    @Test
    @DisplayName("异常可安全跨线程传递（RuntimeException 语义）")
    void shouldBeSafeToRethrow() {
        BusinessException origin = BusinessException.notFound("x");
        assertSame(origin, assertThrows(BusinessException.class, () -> {
            throw origin;
        }));
    }
}
