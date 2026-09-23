package com.campus.market.service;

import com.campus.market.entity.Settings;
import com.campus.market.mapper.AnalyticsMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.ReportMapper;
import com.campus.market.mapper.SettingsMapper;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * {@link AnalyticsService#maxPublishPerDay()} 的取值口径测试。
 * <p>
 * 单独钉这一条，是因为它有一个**反直觉的边界**：列值为 {@code NULL} 时按「不限」处理，
 * 而不是按「默认值 10」处理。
 * <p>
 * 直觉上「配置缺失就填默认值」是对的，但在这里会造成最难排查的一类故障：
 * 某次写入把该列置成 NULL 之后，所有卖家会在毫无预兆的情况下突然发不出第 11 件商品，
 * 而后台界面上那个值看上去明明是空的 —— 管理员改来改去都改不好，
 * 因为真正的原因（NULL 被当成 10）根本不在界面上。
 * <p>
 * 配置缺失时放宽是安全的：不会误伤用户，也不会造成数据损坏。
 */
class AnalyticsServicePublishLimitTest {

    private SettingsMapper settingsMapper;
    private AnalyticsService service;

    @BeforeEach
    void setUp() {
        settingsMapper = mock(SettingsMapper.class);
        service = new AnalyticsService(
                mock(GoodsMapper.class),
                mock(UserMapper.class),
                mock(OrderMapper.class),
                mock(ReportMapper.class),
                mock(AuditLogMapper.class),
                mock(ActivityService.class),
                settingsMapper,
                mock(AnalyticsMapper.class));
    }

    private void givenRow(Integer maxPublishPerDay) {
        Settings s = new Settings();
        s.setId(1L);
        s.setMaxPublishPerDay(maxPublishPerDay);
        when(settingsMapper.selectList(any())).thenReturn(List.of(s));
    }

    @Test
    @DisplayName("行存在且值为 10 → 返回 10")
    void readsConfiguredValue() {
        givenRow(10);
        assertEquals(10, service.maxPublishPerDay());
    }

    @Test
    @DisplayName("★ 行存在但该列为 NULL → 返回 0（不限），不是默认值 10 ★")
    void nullValueMeansUnlimited() {
        givenRow(null);
        assertEquals(0, service.maxPublishPerDay(),
                "NULL 必须按「不限」处理：按 10 处理会让卖家在界面上看不出原因的情况下发不出商品");
    }

    @Test
    @DisplayName("值显式为 0 → 返回 0（与前端「0 表示不限」文案一致）")
    void explicitZeroMeansUnlimited() {
        givenRow(0);
        assertEquals(0, service.maxPublishPerDay());
    }

    @Test
    @DisplayName("值是非法的负数 → 也按不限处理，不允许出现「上限 -5」这种规则")
    void negativeValueIsTreatedAsUnlimited() {
        givenRow(-5);
        assertEquals(0, service.maxPublishPerDay(),
                "负数若原样返回，业务侧的 dailyLimit > 0 判断会为假 → 静默变成不限；" +
                "这里显式收敛，避免「看起来设了限制、其实没有」");
    }

    @Test
    @DisplayName("t_settings 整表为空 → 走默认配置（10）")
    void emptyTableFallsBackToDefault() {
        when(settingsMapper.selectList(any())).thenReturn(List.of());
        assertEquals(10, service.maxPublishPerDay(),
                "整表为空说明从未初始化，此时按默认值走（与 defaultSettings 一致）");
    }
}
