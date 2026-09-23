package com.campus.market.config;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * ---- ④ 数据访问层配置 ----
 * <p>
 * MyBatis-Plus 分页插件：自动拦截分页查询，将 {@code Page} 对象
 * 转换为物理分页 SQL（MySQL LIMIT/OFFSET）。
 * <p>
 * 配合 Mapper 层的 {@code IPage<T> selectPage(Page<>, Wrapper<>)}
 * 实现零手写分页，与前端 PageQuery / PageResult 对齐。
 */
@Configuration
public class MybatisPlusConfig {

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        PaginationInnerInterceptor pageInterceptor = new PaginationInnerInterceptor(DbType.MYSQL);
        /*
         * 单页上限**只在这里和 PageResult.MAX_PAGE_SIZE 定义一次**，且直接引用同一个常量。
         * 两处各写一个数字就必然会出现「查询被钳到 500、响应却回显 100000」这类
         * 不一致（前端按回显值算总页数会翻页错位），所以不写字面量。
         */
        pageInterceptor.setMaxLimit((long) com.campus.market.common.PageResult.MAX_PAGE_SIZE);
        interceptor.addInnerInterceptor(pageInterceptor);
        return interceptor;
    }
}
