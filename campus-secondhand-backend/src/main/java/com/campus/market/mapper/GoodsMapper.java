package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.campus.market.entity.Goods;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

/**
 * 商品数据访问层
 * <p>
 * 分页查询走自定义 XML（支持关键字 / 分类 / 卖家 / 状态 / 排序等多条件），
 * 单条 CRUD 走 BaseMapper。
 */
@Mapper
public interface GoodsMapper extends BaseMapper<Goods> {
    /**
     * 多条件分页查询商品列表
     * @param page       分页参数
     * @param keyword    标题关键字
     * @param categoryId 分类 id
     * @param sellerId   卖家 id
     * @param status     单一状态（后台用）
     * @param statuses   多状态白名单（买家侧可见范围）
     * @param sort       排序：new / price_asc / price_desc / hot
     */
    IPage<Goods> selectGoodsPage(Page<Goods> page,
                                  @Param("keyword") String keyword,
                                  @Param("categoryId") Long categoryId,
                                  @Param("sellerId") Long sellerId,
                                  @Param("status") String status,
                                  @Param("statuses") List<String> statuses,
                                  @Param("sort") String sort);

    /** 统计某分类下的商品数（删除分类前校验用） */
    int countByCategory(Long categoryId);

    /** 批量修改商品状态 */
    int batchUpdateStatus(@Param("ids") List<Long> ids, @Param("status") String status);
}
