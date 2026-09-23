package com.campus.market;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/**
 * 校园二手集市后端启动类
 * <p>
 * {@code @MapperScan} 扫描数据访问层 Mapper 接口；
 * {@code @EnableTransactionManagement} 开启声明式事务管理。
 */
@SpringBootApplication
@MapperScan("com.campus.market.mapper")
@EnableTransactionManagement
public class CampusMarketApplication {
    public static void main(String[] args) {
        SpringApplication.run(CampusMarketApplication.class, args);
    }
}
