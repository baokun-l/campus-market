package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.campus.market.entity.Comment;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.Map;

/**
 * 留言数据访问层
 */
@Mapper
public interface CommentMapper extends BaseMapper<Comment> {
    List<Comment> selectByGoods(@Param("goodsId") Long goodsId);

    IPage<Map<String, Object>> selectAdminComments(Page<Map<String, Object>> page,
                                                      @Param("keyword") String keyword,
                                                      @Param("goodsId") Long goodsId);

    /** 删除顶层留言时连带删除其回复 */
    int deleteByParentId(@Param("parentId") Long parentId);
}
