package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.campus.market.entity.Report;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.Map;

/**
 * 举报数据访问层
 */
@Mapper
public interface ReportMapper extends BaseMapper<Report> {
    IPage<Report> selectReportPage(Page<Report> page,
                                    @Param("status") String status,
                                    @Param("type") String type);

    Map<String, Object> selectReportStats();
}
