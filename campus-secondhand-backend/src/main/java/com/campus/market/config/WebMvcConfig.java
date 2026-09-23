package com.campus.market.config;

import com.campus.market.interceptor.AuthInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.StringHttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

/**
 * ---- ③ Spring MVC 配置 ----
 * <p>
 * 1. 注册 JWT 认证拦截器，保护需要登录的接口；
 * 2. 配置 CORS 跨域，允许前端 Vue 开发服务器（默认 5173 端口）访问；
 * 3. 统一响应字符集为 UTF-8，让响应头带上 {@code charset=UTF-8}。
 * <p>
 * 拦截器覆盖全部路径，公开路由的判定下沉到 {@link AuthInterceptor} 内部 ——
 * 因为 {@code excludePathPatterns} 只看路径、不看 HTTP 方法，
 * 用它放行 {@code GET /goods/{id}} 会连 {@code DELETE /goods/{id}} 一起放出去。
 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;

    @Value("${cors.allowed-origins}")
    private String[] allowedOrigins;

    /** 与 {@code cors.allowed-methods} 绑定，避免配置里写了却不生效 */
    @Value("${cors.allowed-methods}")
    private String[] allowedMethods;

    /** 图片落盘根目录，与 {@code UploadController} 读的是同一个配置键 */
    @Value("${app.upload.dir:uploads}")
    private String uploadDir;

    public WebMvcConfig(AuthInterceptor authInterceptor) {
        this.authInterceptor = authInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // 公开路由（含登录注册、游客可读的 GET 接口）由 AuthInterceptor 内部按方法判定
        registry.addInterceptor(authInterceptor).addPathPatterns("/**");
    }

    /**
     * ★ 把上传目录挂成静态资源 ★
     * <p>
     * 商品图落盘后，浏览器要能按 {@code /api/uploads/2026/09/xxx.jpg} 直接取到，
     * 否则 {@code <img src>} 全是 404。这里把 URL 前缀 {@code /uploads/**} 映射到磁盘目录。
     * <p>
     * 三个易踩的点：
     * <ol>
     *   <li><b>URL 结尾必须带 {@code /}</b>：{@code toUri()} 对目录不一定补斜杠，
     *       少了这一笔，Spring 会把它当文件路径去拼接，所有图片 404；</li>
     *   <li><b>必须用绝对路径</b>：相对路径按进程工作目录解析，IDEA 里跑和
     *       {@code java -jar} 跑的解析结果不同，会出现「本地能看、换启动方式就裂」；</li>
     *   <li><b>访问权限</b>：静态资源同样会过拦截器，所以
     *       {@code GET /uploads/**} 必须写进 {@code AuthInterceptor.PUBLIC_GET} ——
     *       {@code <img>} 标签带不了 Authorization 头，不放行就是整站图片裂开。</li>
     * </ol>
     */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        String location = Paths.get(uploadDir).toAbsolutePath().normalize().toUri().toString();
        if (!location.endsWith("/")) {
            location = location + "/";
        }
        registry.addResourceHandler("/uploads/**").addResourceLocations(location);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                // ★ 用 allowedOriginPatterns 而不是 allowedOrigins ★
                // 精确来源列表漏一个变体就是一场排查灾难：浏览器认为
                // http://localhost:5173 与 http://127.0.0.1:5173 是**两个不同来源**，
                // 白名单只写 localhost 时，用 127.0.0.1 打开的页面所有请求都被
                // Spring 以 403 "Invalid CORS request" 拒绝（实测复现过）。
                // 改成模式匹配后，localhost / 127.0.0.1 的任意端口都放行。
                .allowedOriginPatterns(allowedOrigins)
                // 从配置读取：原先这里硬编码了一份方法列表，而 application.yml 里的
                // cors.allowed-methods 没人用 —— 配置写了不生效是最容易误导后来者的坑。
                .allowedMethods(allowedMethods)
                .allowedHeaders("*")
                /*
                 * ★ allowCredentials 保持 false —— D9 之后这条更需要解释，因为它不再"显然" ★
                 *
                 * D9 把会话凭据从 localStorage 搬进了 **HttpOnly Cookie**，
                 * 于是一个自然的疑问是：Cookie 鉴权不是需要 allowCredentials(true) 吗？
                 * 答案：**只有跨源才需要，而同源根本不过 CORS**。
                 * 本项目的部署模型是同源（`AuthCookie` 的 SameSite=Lax + Path=/）：
                 *   · 开发：前端 `VITE_API_BASE=/api`，由 Vite dev server 代理到 8080 ⇒ 同源；
                 *   · 生产：`.env.production` 约定 Nginx 把 `/api` 反代到后端 ⇒ 同源。
                 * 同源请求浏览器必然携带 Cookie，且**不参与 CORS 协商**，
                 * 所以这里的配置对 Cookie 通道毫无影响。
                 *
                 * 那为什么不开成 true 图个"将来能用"？因为「通配来源 + 允许携带凭据」
                 * 是公认的危险组合：allowedOriginPatterns 现在放的是 localhost/127.0.0.1
                 * 这类模式，一旦允许凭据，**任意本地端口的页面**都能带着用户的会话
                 * Cookie 打这个后端（CSRF 的完美温床）。同源的部署模型下，
                 * 关掉它是零成本的最优解。
                 *
                 * ⚠️ 因此「跨源部署」在本项目是**不支持**的组合，不是"配一下就行"：
                 * 真要跨源，必须同时做到 ① 把 allowedOriginPatterns 收成精确白名单、
                 * ② 这里开 true、③ 前端 axios 开 withCredentials。三者缺一，
                 * 症状都是「登录成功 → 立刻被弹回登录页」（Cookie 没被带上或响应被浏览器拒收），
                 * 不是密码问题。前端 `api/request.ts` 的 axios 实例注释里有同一份说明。
                 */
                .allowCredentials(false)
                .maxAge(3600);
    }

    /**
     * ★ 给响应补上 {@code charset=UTF-8} ★
     * <p>
     * Spring 默认把 JSON 响应写成 {@code Content-Type: application/json}（**不带 charset**）。
     * 按 RFC 8259，{@code application/json} 的默认字符集就是 UTF-8，所以浏览器 / axios / fetch
     * 解析中文完全正常 —— **本项目前端从未因此出问题**。
     * <p>
     * 但严格按「响应头声明的字符集」解析的客户端会踩坑，实测已确认：
     * PowerShell 5.1 的 {@code Invoke-RestMethod} 会回退到系统 ANSI（GBK）解析，
     * 中文全部变乱码，排查时极易误判成后端编码坏了。
     * <p>
     * 这里把 Jackson 与 String 两个转换器的默认字符集显式钉成 UTF-8，
     * 响应头就会变成 {@code application/json;charset=UTF-8}，消除这类歧义。
     */
    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jacksonConverter) {
                jacksonConverter.setDefaultCharset(StandardCharsets.UTF_8);
            } else if (converter instanceof StringHttpMessageConverter stringConverter) {
                stringConverter.setDefaultCharset(StandardCharsets.UTF_8);
            }
        }
    }
}
