package com.campus.market.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 举报实体（举报表：用户-商品/用户/订单-举报-处理留痕）
 * <p>
 * 处理措施必须落到一个可复核的动作上（warn / off_shelf / remove / ban / none），
 * 不能只把状态改成「已处理」而没有任何处置。
 */
@Data
@TableName("t_report")
public class Report {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** goods / user / order */
    private String type;
    private Long targetId;
    private Long reporterId;
    private String reason;
    private String description;
    /** pending / handled / rejected */
    private String status;
    /** 处理措施：none / warn / off_shelf / remove / ban */
    private String measure;
    private String remark;
    /** 措施实际产生的处置说明 */
    private String outcome;
    private LocalDateTime handleTime;
    private String handledBy;
    private LocalDateTime createTime;
}
