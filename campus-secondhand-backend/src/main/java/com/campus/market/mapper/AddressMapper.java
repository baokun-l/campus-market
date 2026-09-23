package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Address;
import org.apache.ibatis.annotations.Mapper;

/**
 * 收货地址数据访问层
 */
@Mapper
public interface AddressMapper extends BaseMapper<Address> {}
