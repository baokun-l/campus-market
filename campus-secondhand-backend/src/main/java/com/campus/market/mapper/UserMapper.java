package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.User;
import org.apache.ibatis.annotations.Mapper;

/**
 * 用户数据访问层
 * <p>
 * 继承 MyBatis-Plus 的 {@code BaseMapper<User>}，
 * 自动获得 insert / deleteById / updateById / selectById / selectList 等基础 CRUD。
 * 自定义查询写在 XML 中。
 */
@Mapper
public interface UserMapper extends BaseMapper<User> {
    /** 按用户名精确查询（登录用） */
    User selectByUsername(String username);
}
