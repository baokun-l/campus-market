package com.campus.market.controller;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.Result;
import com.campus.market.service.HealthService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.junit.jupiter.api.Assertions.*;

/**
 * P1-5 的「响应契约」守卫：健康检查的 {@code code} 恒为 0，状态在 {@code data.status}。
 * <p>
 * ★ 为什么这条值得单独钉住 ★
 * 直觉上「服务不健康」应该给个非 0 的 code（甚至 HTTP 503）。但本项目的错误码表里
 * {@code 500} 的语义被明确限定为「**真正的未捕获故障**，只应由兜底分支产出」——
 * 它曾被业务拒绝滥用，导致监控里出现一批假的「服务端异常」，把真故障淹掉
 * （见 {@code Result#error(String)} 的废弃说明）。
 * <p>
 * 健康检查不属于那种情况：**这次请求本身是成功的**（成功测出了依赖的状态），
 * 依赖不健康是「被测对象的属性」，属于 data。谁要是把它改成非 0，就等于把
 * 「探针请求成功」和「服务不可用」两件事混成一个信号，本用例应当当场报红。
 */
class HealthControllerTest {

    @Test
    @DisplayName("★ 即使依赖 DOWN，code 仍为 0、HTTP 仍为 200，不健康只体现在 data.status ★")
    void keepsCodeZeroEvenWhenDown() {
        HealthService service = mock(HealthService.class);
        when(service.report()).thenReturn(Map.of("status", HealthService.DOWN, "build", "test-build"));

        HealthController controller = new HealthController(service);
        Result<Map<String, Object>> res = controller.health();

        assertEquals(BusinessCode.SUCCESS, res.getCode(),
                "code 必须是 0：500 在本项目的语义是「未捕获故障」，用它表示依赖不健康会让监控出现假故障");
        assertEquals("success", res.getMessage());
        assertEquals(HealthService.DOWN, res.getData().get("status"),
                "健康信号必须完整地出现在 data.status，不能被 code=0 吃掉");
    }

    @Test
    @DisplayName("健康时同样走统一响应体（前端/监控只需认一套结构）")
    void returnsUnifiedBodyWhenUp() {
        HealthService service = mock(HealthService.class);
        when(service.report()).thenReturn(Map.of("status", HealthService.UP, "build", "test-build"));

        Result<Map<String, Object>> res = new HealthController(service).health();

        assertEquals(0, res.getCode());
        assertEquals(HealthService.UP, res.getData().get("status"));
    }

    /** 排障第一问是「线上跑的是哪一版」，所以这个字段必须原样透出、不被包装或改名 */
    @Test
    @DisplayName("build 字段原样透出（形如 campus-market-1.0.0-<源码指纹>-<时间>）")
    void passesThroughBuildId() {
        HealthService service = mock(HealthService.class);
        when(service.report()).thenReturn(Map.of("status", HealthService.UP,
                "build", "campus-market-1.0.0-dd76412d72e6-202609221420"));

        Result<Map<String, Object>> res = new HealthController(service).health();

        assertEquals("campus-market-1.0.0-dd76412d72e6-202609221420", res.getData().get("build"),
                "构建标识来自发版产物文件名（见 HealthService#resolveBuildId），必须原样带出");
    }
}
