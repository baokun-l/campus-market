package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.GoodsAuditRecord;
import org.apache.ibatis.annotations.Mapper;

/**
 * 商品审核记录数据访问层
 */
@Mapper
public interface GoodsAuditRecordMapper extends BaseMapper<GoodsAuditRecord> {}
