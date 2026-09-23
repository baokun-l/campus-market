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
 * {@link AnalyticsService#autoOfflineDays()} 的取值口径测试。
 * <p>
 * 单独钉这一条，是因为它和 {@code maxPublishPerDay()} 一样有个**反直觉的边界**：
 * 列值为 {@code NULL} 时按「不自动下架」处理，而不是按 {@code defaultSettings()} 里的 30 处理。
 * <p>
 * 差别不在「功能少了一点」，而在**会不会造成真实数据损失**：
 * 定时任务会按这个天数把超期商品批量下架，一旦把误写的 NULL 当成 30，
 * 某个凌晨就会发生「全站 30 天前的在售商品集体消失」，而卖家与管理员对着后台那个空值
 * 完全看不出原因。配置缺失时放宽（不下架）最坏只是商品多挂几天，是安全的失败方向。
 */
class AnalyticsServiceAutoOfflineTest {

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

    private void givenRow(Integer autoOfflineDays) {
        Settings s = new Settings();
        s.setId(1L);
        s.setAutoOfflineDays(autoOfflineDays);
        when(settingsMapper.selectList(any())).thenReturn(List.of(s));
    }

    @Test
    @DisplayName("行存在且值为 30 → 返回 30")
    void readsConfiguredValue() {
        givenRow(30);
        assertEquals(30, service.autoOfflineDays());
    }

    @Test
    @DisplayName("★ 行存在但该列为 NULL → 返回 0（不自动下架），不是默认值 30 ★")
    void nullValueMeansDisabled() {
        givenRow(null);
        assertEquals(0, service.autoOfflineDays(),
                "NULL 必须按「关闭」处理：按 30 处理会让定时任务在某天凌晨把全站在售商品集体下架，" +
                        "而界面上那一栏是空的，谁都查不出原因");
    }

    @Test
    @DisplayName("值显式为 0 → 返回 0（与前端「0 表示不限」文案一致）")
    void explicitZeroMeansDisabled() {
        givenRow(0);
        assertEquals(0, service.autoOfflineDays());
    }

    @Test
    @DisplayName("值是非法负数 → 也按关闭处理，不允许出现「提前 -5 天」这种边界")
    void negativeValueIsTreatedAsDisabled() {
        givenRow(-5);
        assertEquals(0, service.autoOfflineDays(),
                "负数若原样返回，minusDays(-5) 会算成「5 天后」，把**所有**在售商品一次清空");
    }

    @Test
    @DisplayName("t_settings 整表为空 → 走默认配置（30）")
    void emptyTableFallsBackToDefault() {
        when(settingsMapper.selectList(any())).thenReturn(List.of());
        assertEquals(30, service.autoOfflineDays(),
                "整表为空说明从未初始化，此时按默认值走（与 defaultSettings 一致）");
    }
}
