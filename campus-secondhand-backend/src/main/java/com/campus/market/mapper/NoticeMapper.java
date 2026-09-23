package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Notice;
import org.apache.ibatis.annotations.Mapper;

/**
 * 公告数据访问层
 */
@Mapper
public interface NoticeMapper extends BaseMapper<Notice> {
}
