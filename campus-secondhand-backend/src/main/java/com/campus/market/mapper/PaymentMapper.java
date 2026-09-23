package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Payment;
import org.apache.ibatis.annotations.Mapper;

/**
 * 支付单数据访问层
 * <p>
 * 只声明 {@link BaseMapper}：本表的全部写入都是**条件 UPDATE**
 * （见 {@code PaymentService} 与 {@code WalletPayChannel}），
 * 用 {@code LambdaUpdateWrapper} 表达比写 XML 更贴近「条件写在当处」的意图 ——
 * 幂等与并发安全全靠 WHERE 里的状态断言，把它拆到 XML 里反而看不清。
 */
@Mapper
public interface PaymentMapper extends BaseMapper<Payment> {}
