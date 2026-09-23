package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.service.HealthService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 健康检查端点（部署适配清单 P1-5） · {@code GET /api/health}
 * <p>
 * 只读、无参数、**匿名可读**（白名单见 {@code AuthInterceptor.PUBLIC_GET}：
 * 探针不会带 {@code Authorization} 头，要求登录就等于探针永远收 401，
 * 而本项目连 401 也是 HTTP 200 ⇒ 探针"看起来一切正常"）。探测逻辑与状态语义
 * 全在 {@link HealthService}，本类只做映射。
 *
 * <h3>★ 为什么自建端点，而不是引 actuator ★</h3>
 * 清单给的两个方案里选了自建，理由是**口径一致性**：
 * <ul>
 *   <li>actuator 的 {@code /actuator/health} 走它自己的一套响应结构（{@code {"status":"UP"}}，
 *       没有本项目统一的 {@code {code,message,data}}），且**依赖不可用时它会回 HTTP 503** ——
 *       本项目「错误一律 HTTP 200」的约定只在业务侧成立，于是同一个服务上会同时存在
 *       两种健康语义，监控配置得写两套判据；</li>
 *   <li>引入 actuator 还会顺带带来 {@code /actuator/env}、{@code /actuator/beans} 这类
 *       **会泄露配置与内部结构**的端点，必须再花精力去关闭它们
 *       （本项目已经踩过「接口文档公开 = 免费侦察资料」那一次，见 {@code AuthInterceptor} 注释）。</li>
 * </ul>
 * 自建端点的代价只是几十行代码，换来的是「一个服务一种健康口径」。
 *
 * <h3>★ 监控怎么用（两层，别混）★</h3>
 * <pre>
 *   # 就绪（依赖也健康）—— 报警用这条
 *   curl -fsS http://127.0.0.1:8080/api/health | jq -e '.data.status == "UP"'
 *
 *   # 存活（进程还在吗）—— Nginx/LB 的健康检查用这条，看 HTTP 200 即可
 *   curl -fsS -o /dev/null http://127.0.0.1:8080/api/health
 * </pre>
 * ⚠️ **不要只看 HTTP 状态码**：本端点按项目约定**恒返回 200**（数据库挂了也是 200，
 * 状态在 body 里）。这正是 P1-5 要修的那个坑 —— 「服务已经挂了，监控显示健康」。
 *
 * <h3>★ 匿名暴露的信息边界 ★</h3>
 * 响应只含：总状态、数据库状态与耗时、日志目录是否可写、构建标识（jar 文件名）、运行时长、当前时间。
 * **不含**：JDBC URL / 主机名 / 库名 / 绝对路径 / 异常堆栈 / 任何用户数据。
 * 构建标识（源码指纹）是刻意的取舍：排障时「线上跑的是哪一版」必须有确定答案，
 * 而它只是我们自己的源码指纹，不是第三方库版本号（后者才方便攻击者挑漏洞）。
 * 若希望连这一项也不对外，Nginx 上把 {@code /api/health} 限制到内网网段即可
 * （见 {@code deploy/nginx-campus-market.conf} 里的注释）。
 */
@RestController
public class HealthController {

    private final HealthService healthService;

    public HealthController(HealthService healthService) {
        this.healthService = healthService;
    }

    @GetMapping("/health")
    public Result<Map<String, Object>> health() {
        // 恒 success：状态在 data.status（语义见 HealthService 类注释「为什么 code 恒为 0」）
        return Result.success(healthService.report());
    }
}
