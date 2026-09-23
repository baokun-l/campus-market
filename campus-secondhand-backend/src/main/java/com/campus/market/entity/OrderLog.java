package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 订单操作日志实体（操作日志表：订单-谁-何时-从哪到哪）
 * <p>
 * 每次状态流转都追加一条日志：操作人 + 身份 + from→to + 说明。
 * <p>
 * ★ 字段名与库列的对应：库里是 {@code from_status / to_status}（避免用 SQL 保留字 from），
 * 而前端 `types/index.ts` 的 `OrderLog` 契约是 {@code from / to}。
 * 这里用 {@code @JsonProperty} 把**对外 JSON 名**改成 from/to，
 * 实体字段名仍是 fromStatus/toStatus —— MyBatis 照旧按驼峰映射列，
 * 只影响序列化，不会碰到持久层。
 */
@Data
@TableName("t_order_log")
public class OrderLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String orderId;
    private LocalDateTime time;
    /** create / pay / ship / receive / complete / cancel / refund / note / adjust */
    private String action;
    private String actionLabel;
    /** 流转前状态（note 类动作为空）；对前端输出为 `from` */
    @JsonProperty("from")
    private String fromStatus;
    /** 流转后状态；对前端输出为 `to` */
    @JsonProperty("to")
    private String toStatus;
    private String operator;
    /** buyer / seller / admin / system */
    private String operatorRole;
    private String note;
}
