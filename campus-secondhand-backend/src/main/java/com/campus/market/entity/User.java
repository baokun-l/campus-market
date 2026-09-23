package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 用户实体（用户表：用户-商品-订单-消息-评价-举报）
 * <p>
 * 角色即权限边界：
 *  - user      普通用户
 *  - admin     全能管理员
 *  - merchant  商家
 *  - goods_admin   商品审核员
 *  - report_admin  举报审核员
 */
@Data
@TableName("t_user")
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String username;
    /**
     * 密码（BCrypt 哈希）。
     * <p>
     * ★ 标记为 WRITE_ONLY：**永不进 JSON 响应**。
     * 各个 Service 里都手工写了 `setPassword(null)`，但那是「记得改」的约定 ——
     * 只要有一个新接口忘了抹，口令就跟着用户列表/详情一起发给浏览器了。
     * 写在字段上是由序列化层兜底，漏不掉。
     */
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String password;
    private String nickname;
    private String avatar;
    private String phone;
    /**
     * 平台钱包余额（校园币，单位：元）。
     * <p>
     * ★ 用 {@code READ_ONLY} 而不是普通字段 ★
     * <p>
     * 余额必须**返回给前端**（收银台要显示「余额 ¥500.00」、余额不足时要提示还差多少），
     * 所以不能 {@code @JsonIgnore}。
     * <p>
     * 但入参方向必须彻底关死。本项目有若干 {@code @RequestBody User} 直接绑定的写接口
     * （改资料、管理员改用户等），若允许反序列化，客户端只要在任意请求体里塞一个
     * {@code "balance": 999999} 就能给自己加钱 —— 这是**直接就变成钱的**漏洞，
     * 比越权读数据严重一个量级。
     * <p>
     * READ_ONLY 表示「只序列化出去、永不从入参读入」，语义上等价于
     * 「这一列只能由受控的资金路径（支付 / 退款 / 充值）变更」。
     * 注意：这只是**第一道**防线，真正的防线在 {@code WalletPayChannel} 里 ——
     * 余额增减一律走数据库条件 UPDATE，应用层从不「读出来、算一下、写回去」。
     */
    @JsonProperty(access = JsonProperty.Access.READ_ONLY)
    private BigDecimal balance;
    private Integer creditScore;
    /** active / banned / pending */
    private String status;
    /** user / admin / merchant / goods_admin / report_admin */
    private String role;
    /**
     * JWT 版本号（改密码后 +1，使旧令牌立即失效）。
     * <p>
     * ★ 用 {@code @JsonIgnore} 而不是「只是不返回」★
     * 版本号是服务端的安全实现细节，前端拿到没有任何用途；更要紧的是
     * 入参方向也必须关死 —— `POST /goods` 这类接口是 `@RequestBody User` 直接绑定的，
     * 若允许反序列化，客户端就能在请求体里塞一个 {@code tokenVersion}
     * 把自己那一行改小，等于给旧令牌「续命」。
     * 这里两个方向一起关掉，语义上等价于「这列不参与任何对外契约」。
     */
    @JsonIgnore
    private Integer tokenVersion;
    /**
     * 最后活跃时间（客户端心跳刷新，在线判定基准）。
     * <p>
     * ★ 用 {@code @JsonIgnore} 而不是「是 null 就不返回」★
     * 这一列能在 {@link #showOnline} 之外**独立泄露「你几点在不在线」的时间线**：
     * 关掉隐私开关的同学，本意就是不想让人知道自己什么时候在线；
     * 而 {@code /users/{id}/profile}、{@code /admin/users} 都会直接序列化 User，
     * 一旦漏出去，开关就形同虚设 —— 对外只需要「是否在线」这一个布尔，由接口现场算。
     */
    @JsonIgnore
    private LocalDateTime lastActiveAt;
    /**
     * 是否对外展示在线状态（列 show_online，默认 1 = 展示）。
     * <p>
     * 与 {@link #lastActiveAt} 相反，这个值**必须**返回给前端：设置页要拿它恢复开关状态，
     * 而且换设备/换浏览器时开关得跟着账号走。
     * <p>
     * ★ 用 READ_ONLY 而不是普通字段 ★
     * 本项目有若干 {@code @RequestBody User} 直接绑定的写接口，若允许反序列化，
     * 客户端就能顺手在任意请求体里塞一个 {@code showOnline} 绕过「隐私设置」接口。
     * READ_ONLY 表示「只序列化出去、永不从入参读入」——语义上等价于
     * 「这列只能由 {@code PATCH /user/privacy} 改」。
     */
    @JsonProperty(access = JsonProperty.Access.READ_ONLY)
    private Boolean showOnline;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
