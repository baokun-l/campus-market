package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 商品审核记录实体（审核表：审核记录-商品-审核员）
 * <p>
 * 审核记录只增不改，商品可在驳回后修改重新提交（再次生成 pending）。
 */
@Data
@TableName("t_goods_audit_record")
public class GoodsAuditRecord {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long goodsId;
    private String goodsTitle;
    /** approve / reject */
    private String action;
    private String reason;
    private String operator;
    private LocalDateTime time;
}
