package com.campus.market.config;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;

/**
 * JWT 配置：生成与解析 Token 的密钥和过期时间。
 * <p>
 * 前端在请求头中携带 {@code Authorization: Bearer <token>}，
 * {@link com.campus.market.interceptor.AuthInterceptor} 拦截后解析出 userId。
 */
@Configuration
public class JwtConfig {

    private static final Logger log = LoggerFactory.getLogger(JwtConfig.class);

    /**
     * {@code application.yml} 里的兜底密钥。**仅供本地开发**。
     * 它的值写在开源仓库里，等于公开 —— 谁都能拿它自签一个 {@code role=admin} 的 token 进后台。
     */
    private static final String DEV_FALLBACK_SECRET = "campus-secondhand-market-jwt-secret-key-2024";

    @Value("${jwt.secret}")
    private String secret;

    @Value("${jwt.expiration}")
    private long expiration;

    /**
     * 启动自检：还在用仓库里的兜底密钥就大声告警。
     * <p>
     * 不能直接启动失败 —— 本地开发与课堂演示就是靠这个默认值零配置跑起来的。
     * 但**必须留下痕迹**，否则「用默认密钥上了生产」这件事会一路无人察觉，
     * 直到有人拿公开密钥签了个管理员 token 进来。
     */
    @PostConstruct
    public void warnIfUsingFallbackSecret() {
        if (DEV_FALLBACK_SECRET.equals(secret)) {
            log.warn("""
                    ====================================================================
                     [安全告警] jwt.secret 正在使用源码里的默认兜底值，任何拿到本仓库的人
                     都能伪造任意角色（含 admin）的 token。生产部署请务必设置环境变量：
                         JWT_SECRET=<至少 32 字节的随机串>
                    ====================================================================""");
        }
    }

    @Bean
    public SecretKey jwtSecretKey() {
        // 显式指定 UTF-8：secret.getBytes() 会用**平台默认字符集**，
        // Windows 中文环境下是 GBK。当前密钥恰好是纯 ASCII，两种编码结果相同，
        // 所以还没暴露问题；但一旦密钥里出现中文，就会出现
        // 「A 机器签发的 token，B 机器验签失败」这类极难定位的故障。
        return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
    }

    public long getExpiration() {
        return expiration;
    }

    /**
     * 生成 JWT Token
     * <p>
     * ★ 必须带上 {@code ver}（用户表 token_version）★
     * 这个声明是「改密码后旧令牌立刻失效」的锚点：AuthInterceptor 每请求
     * 拿它与 t_user.token_version 比对，不等即 401。
     * 之所以不用 token 里的 {@code iat} 去比「口令最后修改时间」，
     * 是因为 iat 只有秒级精度，同一秒内的「改密 + 用旧令牌」会漏判；
     * 单调递增的版本号没有精度问题。
     *
     * @param tokenVersion 该用户当前的 token_version（null 视为 0）
     */
    public String generateToken(Long userId, String username, String role, Integer tokenVersion) {
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .claim("role", role)
                .claim("ver", tokenVersion == null ? 0 : tokenVersion)
                .issuedAt(new java.util.Date())
                .expiration(new java.util.Date(System.currentTimeMillis() + expiration))
                .signWith(jwtSecretKey())
                .compact();
    }

    /**
     * 读取 Token 里的 token_version 声明。
     * <p>
     * <b>缺失时返回 0，不抛异常</b>：升级前签发的令牌没有这个声明，
     * 若当作非法令牌处理，一次发版就会把所有在线用户踢下线。
     * 返回 0 与「老用户的 token_version 恰好是 0」等价，平滑过渡。
     */
    public int tokenVersionOf(io.jsonwebtoken.Claims claims) {
        Object raw = claims.get("ver");
        if (raw instanceof Number n) return n.intValue();
        if (raw instanceof String s) {
            try {
                return Integer.parseInt(s.trim());
            } catch (NumberFormatException ignored) {
                // 伪造/损坏的声明按 0 处理：下面与库里的值比对时自然会被判为不一致
            }
        }
        return 0;
    }

    /**
     * 解析 Token，返回 Claims
     */
    public io.jsonwebtoken.Claims parseToken(String token) {
        return Jwts.parser()
                .verifyWith(jwtSecretKey())
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }
}
