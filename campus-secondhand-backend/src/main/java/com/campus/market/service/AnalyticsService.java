package com.campus.market.service;

import com.campus.market.common.BusinessException;
import com.campus.market.common.Validators;
import com.campus.market.dto.GoodsSalesStat;
import com.campus.market.dto.HotGoodsRow;
import com.campus.market.dto.NameValue;
import com.campus.market.dto.TrendPoint;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.Goods;
import com.campus.market.entity.Settings;
import com.campus.market.mapper.AnalyticsMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.ReportMapper;
import com.campus.market.mapper.SettingsMapper;
import com.campus.market.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 统计分析 + 系统设置 + 操作日志业务逻辑层
 * <p>
 * 所有统计口径都来自真实库表，不使用任何硬编码/放大的假数据：
 * 趋势图的 PV/UV 就是浏览足迹表的流水，热销榜就是订单表的成交聚合。
 */
@Service
@RequiredArgsConstructor
public class AnalyticsService {

    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    private final GoodsMapper goodsMapper;
    private final UserMapper userMapper;
    private final OrderMapper orderMapper;
    private final ReportMapper reportMapper;
    private final AuditLogMapper auditLogMapper;
    /** 看板「进行中活动数」需要真实的活动数据（此前该字段硬编码 0） */
    private final ActivityService activityService;
    private final SettingsMapper settingsMapper;
    private final AnalyticsMapper analyticsMapper;

    // ==================== 仪表盘 / 总览 ====================

    public Map<String, Object> fetchDashboardSummary() {
        Map<String, Object> result = new HashMap<>();
        result.put("goodsTotal", goodsMapper.selectCount(null));
        result.put("userTotal", userMapper.selectCount(null));
        result.put("orderTotal", orderMapper.selectCount(null));
        result.put("recentOrders", orderMapper.selectCount(
                new LambdaQueryWrapper<com.campus.market.entity.Order>()
                        .ge(com.campus.market.entity.Order::getCreateTime, LocalDate.now().atStartOfDay())));
        return result;
    }

    /**
     * 管理后台总览（待办 + GMV + 待审）
     * <p>
     * ★ 字段与前端 `api/analytics.ts` 的 `AdminOverview` 一一对应，一个都不能少。
     * 少一个，界面上那个数字就是 `undefined` —— 可能显示成空白，也可能进到
     * 「¥NaN」这种更糟的结果。
     * <p>
     * ★ GMV 必须拆成五项，只报一个总数说不清「这笔交易的钱从哪来、到哪去」：
     * <ul>
     *   <li>{@code gmv}                 买家实付合计（平台真实收到的钱）</li>
     *   <li>{@code gmvListPrice}        挂牌价合计（卖家标价口径）</li>
     *   <li>{@code sellerCutTotal}      卖家让利合计（卖家自己掏的钱）</li>
     *   <li>{@code platformSubsidyTotal} 平台补贴合计（平台真金白银贴出去的）</li>
     *   <li>{@code sellerIncomeTotal}   卖家实收合计（= 挂牌价 − 卖家让利）</li>
     * </ul>
     * 恒等式：{@code gmv + sellerCutTotal + platformSubsidyTotal == gmvListPrice}。
     * 平台补贴取「倒算」而不是读列：老订单没有价格拆分快照，
     * 直接读 {@code platform_subsidy} 会恒为 0，恒等式当场被打破。
     */
    public Map<String, Object> fetchAdminOverview() {
        Map<String, Object> result = new HashMap<>();
        result.put("goodsTotal", goodsMapper.selectCount(null));
        result.put("onSaleTotal", goodsMapper.selectCount(
                new LambdaQueryWrapper<Goods>().eq(Goods::getStatus, "on_sale")));
        result.put("pendingGoods", goodsMapper.selectCount(
                new LambdaQueryWrapper<Goods>().eq(Goods::getStatus, "pending")));
        result.put("userTotal", userMapper.selectCount(null));
        // pendingUsers 已随 D11 拆除（2026-09-23）：用户不再有待审核态，看板待办只含商品与举报
        result.put("bannedUsers", userMapper.selectCount(
                new LambdaQueryWrapper<com.campus.market.entity.User>()
                        .eq(com.campus.market.entity.User::getStatus, "banned")));
        result.put("orderTotal", orderMapper.selectCount(null));

        LocalDateTime todayStart = LocalDate.now().atStartOfDay();
        result.put("recentOrders", orderMapper.selectCount(
                new LambdaQueryWrapper<com.campus.market.entity.Order>()
                        .ge(com.campus.market.entity.Order::getCreateTime, todayStart)));

        // ---- 成交金额：只统计已成交状态 ----
        List<com.campus.market.entity.Order> paid = orderMapper.selectList(
                new LambdaQueryWrapper<com.campus.market.entity.Order>()
                        .in(com.campus.market.entity.Order::getStatus, PAID_STATUS));

        java.math.BigDecimal gmv = sum(paid, o -> o.getAmount());
        java.math.BigDecimal gmvListPrice = sum(paid, o ->
                o.getListPrice() != null ? o.getListPrice() : o.getAmount());
        java.math.BigDecimal sellerCutTotal = sum(paid, o ->
                o.getSellerCut() != null ? o.getSellerCut() : java.math.BigDecimal.ZERO);
        java.math.BigDecimal platformSubsidyTotal = gmvListPrice.subtract(gmv).subtract(sellerCutTotal);
        java.math.BigDecimal sellerIncomeTotal = gmvListPrice.subtract(sellerCutTotal);
        java.math.BigDecimal todayGmv = sum(
                paid.stream().filter(o -> o.getCreateTime() != null
                        && !o.getCreateTime().isBefore(todayStart)).toList(),
                o -> o.getAmount());

        result.put("gmv", gmv);
        result.put("gmvListPrice", gmvListPrice);
        result.put("sellerCutTotal", sellerCutTotal);
        result.put("platformSubsidyTotal", platformSubsidyTotal);
        result.put("sellerIncomeTotal", sellerIncomeTotal);
        result.put("todayGmv", todayGmv);

        long pendingReports = reportMapper.selectCount(
                new LambdaQueryWrapper<com.campus.market.entity.Report>()
                        .eq(com.campus.market.entity.Report::getStatus, "pending"));
        result.put("pendingReports", pendingReports);

        /*
         * 进行中活动数 —— 真实统计，不再是 0。
         *
         * 这个字段此前被写成常量 0，理由写在当时的注释里：「本项目没有活动的持久化表」。
         * 那个前提在活动模块补齐后已经不成立（活动已落 `t_activity`，状态由服务端时钟判定），
         * 继续返回 0 就成了**假数据**：后台明明跑着 3 个活动，看板却说 0 个。
         * 注意统计口径只算 **active**（进行中）—— 待开始、已到期、已下架都不计入。
         */
        result.put("activeActivities", activityService.countActive());

        // 待办合计：两项之和（pendingUsers 已随 D11 拆除），看板首屏直接展示
        long pendingGoods = ((Number) result.get("pendingGoods")).longValue();
        result.put("todoTotal", pendingGoods + pendingReports);
        return result;
    }

    /** 按给定取值函数累加，null 一律当 0（金额列允许为空，不能因此整行算爆） */
    private java.math.BigDecimal sum(List<com.campus.market.entity.Order> orders,
                                     Function<com.campus.market.entity.Order, java.math.BigDecimal> pick) {
        return orders.stream()
                .map(pick)
                .filter(java.util.Objects::nonNull)
                .reduce(java.math.BigDecimal.ZERO, java.math.BigDecimal::add);
    }

    /** 计入成交的订单状态（与前端 PAID_STATUS 一致） */
    private static final List<String> PAID_STATUS =
            List.of("pending_ship", "shipped", "received", "completed");

    // ==================== 数据大屏 ====================

    /**
     * 趋势折线：近 N 天 PV / UV / 订单数
     * <p>
     * 没有任何互动的那一天也要给点（补 0），否则折线会在 x 轴上跳日期，
     * 看图的人会误以为「那天平台关了」。
     */
    public List<TrendPoint> fetchTrend(int days) {
        int span = Math.min(90, Math.max(1, days));
        LocalDate from = LocalDate.now().minusDays(span - 1L);
        LocalDateTime fromTime = from.atStartOfDay();

        Map<String, TrendPoint> byDate = new LinkedHashMap<>();
        for (int i = 0; i < span; i++) {
            String d = from.plusDays(i).format(DAY);
            byDate.put(d, new TrendPoint(d, 0L, 0L, 0L));
        }

        Function<List<TrendPoint>, Map<String, TrendPoint>> index = list -> list.stream()
                .filter(p -> p.getDate() != null)
                .collect(Collectors.toMap(TrendPoint::getDate, p -> p, (a, b) -> a));

        Map<String, TrendPoint> views = index.apply(analyticsMapper.selectDailyViews(fromTime));
        Map<String, TrendPoint> orders = index.apply(analyticsMapper.selectDailyOrders(fromTime));

        byDate.forEach((date, point) -> {
            TrendPoint v = views.get(date);
            if (v != null) {
                point.setPv(v.getPv() == null ? 0L : v.getPv());
                point.setUv(v.getUv() == null ? 0L : v.getUv());
            }
            TrendPoint o = orders.get(date);
            if (o != null) {
                point.setOrders(o.getOrders() == null ? 0L : o.getOrders());
            }
        });

        return new ArrayList<>(byDate.values());
    }

    /** 分类占比饼图 */
    public List<NameValue> fetchCategoryDistribution() {
        return analyticsMapper.selectCategoryDistribution();
    }

    /**
     * 热门商品（按浏览量）—— 大屏排行榜
     * <p>
     * 与后台「热销榜」（按成交单数）是两个不同口径，不要混用：
     * 浏览量高只说明有人围观，成交才算真实带货。
     */
    public List<Goods> fetchTopGoods(int limit) {
        int size = Math.min(50, Math.max(1, limit));
        IPage<Goods> p = goodsMapper.selectPage(new Page<>(1, size),
                new LambdaQueryWrapper<Goods>()
                        .gt(Goods::getViewCount, 0)
                        .orderByDesc(Goods::getViewCount));
        return p.getRecords();
    }

    /** 管理端热销榜：按成交单数排序，并回填商品档案 */
    public List<HotGoodsRow> fetchHotGoods(int limit) {
        int size = Math.min(50, Math.max(1, limit));
        List<GoodsSalesStat> stats = analyticsMapper.selectHotGoods(size);
        if (stats.isEmpty()) return List.of();

        List<Long> ids = stats.stream().map(GoodsSalesStat::getGoodsId).toList();
        Map<Long, Goods> goodsById = goodsMapper.selectBatchIds(ids).stream()
                .collect(Collectors.toMap(Goods::getId, g -> g, (a, b) -> a));

        return stats.stream()
                .filter(s -> goodsById.containsKey(s.getGoodsId()))
                .map(s -> {
                    HotGoodsRow row = new HotGoodsRow();
                    row.setGoods(goodsById.get(s.getGoodsId()));
                    row.setSoldCount(s.getSoldCount() == null ? 0 : s.getSoldCount());
                    row.setAmount(s.getAmount() == null ? java.math.BigDecimal.ZERO : s.getAmount());
                    return row;
                })
                .toList();
    }

    // ==================== 操作日志 ====================

    public IPage<AuditLog> fetchAuditLogs(int page, int pageSize, String type, String keyword) {
        return auditLogMapper.selectPage(new Page<>(page, pageSize), auditLogWrapper(type, keyword));
    }

    /** 导出上限：列表可以翻页，导出要「当前筛选的全部」（与订单导出同口径） */
    private static final int EXPORT_MAX = 5000;

    /**
     * 操作日志导出（全量，带分类 / 关键字过滤）。
     * <p>
     * 用关闭 count 的宽分页一条 SQL 拿全量，筛选与列表共用 {@link #auditLogWrapper} ——
     * 审计流水是「谁在什么时候做了什么」的唯一凭据，导出缺一行就是留痕断档。
     */
    public List<AuditLog> fetchAuditLogsForExport(String type, String keyword) {
        return auditLogMapper.selectPage(new Page<>(1, EXPORT_MAX, false), auditLogWrapper(type, keyword))
                .getRecords();
    }

    /** 列表与导出共用的筛选组装：两边条件必须同源，不会一个筛 A 一个筛 B */
    private LambdaQueryWrapper<AuditLog> auditLogWrapper(String type, String keyword) {
        LambdaQueryWrapper<AuditLog> wrapper = new LambdaQueryWrapper<>();
        if (type != null && !type.isBlank()) {
            wrapper.likeRight(AuditLog::getAction, type + ".");
        }
        if (keyword != null && !keyword.isBlank()) {
            wrapper.and(w -> w.like(AuditLog::getActionLabel, keyword)
                    .or().like(AuditLog::getTarget, keyword)
                    .or().like(AuditLog::getDetail, keyword)
                    .or().like(AuditLog::getOperator, keyword));
        }
        wrapper.orderByDesc(AuditLog::getCreateTime);
        return wrapper;
    }

    /** 各类动作条数（页签上的小计数） */
    public Map<String, Integer> fetchAuditStats() {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (NameValue nv : analyticsMapper.countAuditLogsByType()) {
            if (nv.getName() != null) {
                out.put(nv.getName(), nv.getValue() == null ? 0 : nv.getValue().intValue());
            }
        }
        return out;
    }

    /** 清空操作日志的确认口令：调用方必须显式写出它，才算「真的说了要清空」 */
    private static final String CLEAR_CONFIRM = "CLEAR";

    /**
     * 清空全部操作日志
     * <p>
     * ★ 全表无条件删除，必须补上服务端的显式确认 ★
     * <p>
     * 前端确实有一道 {@code ElMessageBox} 二次确认，但那只是页面体验层：
     * <ul>
     *   <li>任何一次误发/错发的 {@code DELETE /admin/audit-logs}（脚本、调试、将来某个新入口）
     *       都会把全部审计流水一次抹干净，没有任何挽回余地；</li>
     *   <li>更要紧的是——删完之后**连「谁删的、删了多少条」都查不到了**：
     *       审计的最后一个动作把自己的痕迹一并删掉，这是审计表最不该出现的形态。</li>
     * </ul>
     * 因此这里做两件事：
     * <ol>
     *   <li>要求调用方显式带上 {@code confirm=CLEAR}，缺失或对不上就**一条都不删**直接拒绝；</li>
     *   <li>清空后立刻补写一条「清空操作日志」留痕（含操作人与删除条数）。</li>
     * </ol>
     * ⚠️ 所以清空之后列表里**会剩这 1 条**，是刻意的留痕，不是没删干净。
     */
    @Transactional
    public void clearAuditLogs(String confirm, String operator) {
        if (!CLEAR_CONFIRM.equals(confirm)) {
            throw BusinessException.paramError("清空操作日志需要显式确认（confirm=CLEAR）");
        }
        long removed = auditLogMapper.selectCount(null);
        auditLogMapper.delete(null);

        AuditLog trace = new AuditLog();
        trace.setAction("audit.clear");
        trace.setActionLabel("清空操作日志");
        trace.setTarget("全部操作日志（" + removed + " 条）");
        trace.setDetail("该动作本身留痕：清空了 " + removed + " 条历史审计流水，此条不可被无声抹除");
        trace.setOperator(operator != null && !operator.isBlank() ? operator : "admin");
        trace.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(trace);
    }

    // ==================== 系统设置 ====================

    public Settings fetchSettings() {
        List<Settings> list = settingsMapper.selectList(null);
        return list.isEmpty() ? defaultSettings() : list.get(0);
    }

    /**
     * 每日发布上限（供业务层读取，目前唯一真正生效的一项系统配置）。
     * <p>
     * ★ 语义：返回 0 表示**不限制** ★
     * 这与前端表单「0 表示不限」的文案一致（{@code SettingsPanel.vue}）。
     * <p>
     * ★ 为什么 null 也当成 0（不限）而不是当成 10 ★
     * {@code t_settings.max_publish_per_day} 列可空。若某次写入把该列置成 NULL，
     * 「按默认值 10 处理」会让所有卖家在毫无预兆的情况下突然发不出第 11 件商品，
     * 而且从界面上看那个值明明是空的 —— 这种「配置缺失反而收紧限制」的行为最难排查。
     * 配置缺失时放宽（不限）是安全的：它不会误伤用户，也不会造成数据损坏。
     * <p>
     * ★ 与 {@link #defaultSettings()} 的分工 ★
     * 那张表整行为空时才走默认值 10（见 {@code defaultSettings}）；
     * 这里处理的是「行在、但这一列是 NULL」的情形，两者不是一回事。
     */
    public int maxPublishPerDay() {
        Integer limit = fetchSettings().getMaxPublishPerDay();
        return (limit == null || limit <= 0) ? 0 : limit;
    }

    /**
     * 商品自动下架天数（供定时维护任务 {@code GoodsMaintenanceService} 读取）。
     * <p>
     * ★ 语义：返回 0 表示**不自动下架** ★
     * 与 {@link #maxPublishPerDay()} 共用同一套收敛规则，理由也同源，但后果更重：
     * <p>
     * {@code t_settings.auto_offline_days} 列可空。若把 NULL 当成
     * {@link #defaultSettings()} 里的 30 来用，那么**一次误写 NULL** 就足以让定时任务在某个凌晨
     * 把所有 30 天前发布的商品集体下架 —— 卖家第二天醒来发现自己的商品「全没了」，
     * 而后台设置页那一栏看上去明明是空的，他改来改去也找不出原因。
     * 「配置缺失反而变严」是这套系统里唯一能造成**真实数据损失**的方向，必须先堵死。
     * <p>
     * 反过来，配置缺失时放宽（不自动下架）没有任何副作用：最坏结果只是商品多挂几天，
     * 而这条规则本来就是为了清理「挂了很久没人要」的存货，不是安全边界。
     * <p>
     * ★ 与 {@link #defaultSettings()} 的分工 ★
     * 整表为空（从未初始化）才走默认值 30；这里是「行在、但这一列为 NULL」，两者不是一回事。
     */
    public int autoOfflineDays() {
        Integer days = fetchSettings().getAutoOfflineDays();
        return (days == null || days <= 0) ? 0 : days;
    }

    /** 与 schema.sql 严格一致：t_settings.site_name varchar(100) */
    private static final int SITE_NAME_MAX = 100;
    /** 与 schema.sql 严格一致：t_settings.service_phone varchar(30) */
    private static final int SERVICE_PHONE_MAX = 30;
    /** 与 schema.sql 严格一致：t_settings.announce_text varchar(500) */
    private static final int ANNOUNCE_MAX = 500;

    /**
     * 保存系统设置（局部更新）
     * <p>
     * ★ 每个字段都要在落库前收敛 ★
     * t_settings 的列都很窄（site_name 100 / service_phone 30 / announce_text 500），
     * 叠加 MySQL 严格模式后，站点名写 150 个字会直接抛 Data too long →
     * 后台设置页弹「服务器内部错误」。管理员会以为整个设置模块坏了，其实只是名字太长。
     * <p>
     * 数值字段更隐蔽：max_publish_per_day / auto_offline_days 是 INT，
     * 写负数**不会报错**，会静默存进去 —— 之后「每日发布上限 -5 条」这类规则
     * 在业务判断里恒真恒假都说不准，用户发现自己发不出商品也找不到原因。
     * 佣金比例落进 decimal(5,4)：写 99 会溢出报错，写 -1 却会悄悄存下来。
     */
    @org.springframework.transaction.annotation.Transactional
    public Settings saveSettings(Settings patch) {
        patch.setSiteName(Validators.optional(patch.getSiteName(), SITE_NAME_MAX, "站点名称"));
        patch.setServicePhone(Validators.optional(patch.getServicePhone(), SERVICE_PHONE_MAX, "客服电话"));
        patch.setAnnounceText(Validators.optional(patch.getAnnounceText(), ANNOUNCE_MAX, "公告文案"));
        patch.setMaxPublishPerDay(Validators.range(patch.getMaxPublishPerDay(), 0, 1000, "每日发布上限"));
        patch.setAutoOfflineDays(Validators.range(patch.getAutoOfflineDays(), 0, 3650, "自动下架天数"));
        if (patch.getCommissionRate() != null
                && (patch.getCommissionRate() < 0 || patch.getCommissionRate() > 1)) {
            throw BusinessException.paramError("平台佣金比例应在 0 ~ 1 之间（当前 " + patch.getCommissionRate() + "）");
        }

        Settings current = fetchSettings();
        if (current.getId() != null) {
            patch.setId(current.getId());
            settingsMapper.updateById(patch);
        } else {
            settingsMapper.insert(patch);
        }
        return patch;
    }

    @org.springframework.transaction.annotation.Transactional
    public Settings resetSettings() {
        settingsMapper.delete(null);
        Settings s = defaultSettings();
        settingsMapper.insert(s);
        return s;
    }

    private Settings defaultSettings() {
        Settings s = new Settings();
        s.setSiteName("校园二手集市");
        s.setServicePhone("400-000-0000");
        s.setAnnounceText("欢迎使用校园二手集市，请诚信交易！");
        s.setGoodsAuditRequired(true);
        s.setMaxPublishPerDay(10);
        s.setAutoOfflineDays(30);
        s.setReportAutoHide(false);
        s.setCommissionRate(0.0);
        return s;
    }
}
