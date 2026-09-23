package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.WalletLog;
import org.apache.ibatis.annotations.Mapper;

/**
 * 钱包流水数据访问层
 * <p>
 * 流水只增不改：没有任何 UPDATE / DELETE 的业务入口。
 * 「改余额」与「写流水」必须在同一个事务里（见 {@code WalletPayChannel}），
 * 否则会出现「钱扣了、账没有」或者反过来的对不上账。
 */
@Mapper
public interface WalletLogMapper extends BaseMapper<WalletLog> {}
