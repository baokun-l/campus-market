package com.campus.market.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.campus.market.common.BusinessException;
import com.campus.market.common.InstanceSeqGenerator;
import com.campus.market.common.Validators;
import com.campus.market.dto.ActivityDiscountClaim;
import com.campus.market.dto.ActivityDisplay;
import com.campus.market.entity.Activity;
import com.campus.market.entity.AuditLog;
import com.campus.market.mapper.ActivityMapper;
import com.campus.market.mapper.AuditLogMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 限时活动业务逻辑层
 * <p>
 * ★ 与前端 `src/api/activity.ts` 的分工（这是本轮对接的核心变更）★
 * <p>
 * 之前活动**完全活在前端 localStorage 里**：后端没有任何活动表与接口，
 * 于是 ① 换浏览器/换设备就看不到活动；② `/admin/overview` 的
 * {@code activeActivities} 只能是硬编码 0；③ 卖家报名时的让利力度
 * 由客户端自己算，服务端无从校验。现在活动成为**服务端数据**：
 * 活动 CRUD 落库、状态由服务端时钟判定、GMV 归属以库里的 {@code fundSource} 为准。
 * <p>
 * ★ 状态为什么必须由服务端算 ★
 * <p>
 * 客户端时间可以改。若前端自己用 `Date.now()` 判断「活动是否已开始」，
 * 把系统时间往前拨一天就能让一个还没开始的活动提前上线卖货。
 * 所以状态、到期时间、剩余毫秒统一在这里算好下发（见 {@link ActivityDisplay}）。
 */
@Service
@RequiredArgsConstructor
public class ActivityService {

    private static final long DAY_MS = 86_400_000L;

    /** 与前端 `DEFAULT_ACTIVITY_DAYS` 保持一致 */
    private static final int DEFAULT_ACTIVITY_DAYS = 14;

    /** 与前端 `ACTIVITY_THEMES` 保持一致，越界值一律回落 orange，避免出现「随机彩虹」 */
    private static final Set<String> THEMES = Set.of("orange", "blue", "green", "purple");

    private static final List<String> ALL_STATES = List.of("pending", "active", "expired", "cancelled");

    private final ActivityMapper activityMapper;
    private final AuditLogMapper auditLogMapper;

    /**
     * 活动业务主键发号器：{@code act_ + 17 位时间戳 + 1 位实例号 + 2 位毫秒内序号}。
     * <p>
     * ★ L10（2026-09-22 修）★ 旧实现是 {@code private static final AtomicLong ID_SEQ}
     * ＋ {@code "act_" + base36(毫秒) + base36(seq)}，三个毛病：
     * <ol>
     *   <li><b>纯进程内状态</b>：多实例各从 0 起，同毫秒建活动就撞号 ——
     *       {@code t_activity.id} 是 {@code VARCHAR(64) PRIMARY KEY}，撞号 = 主键冲突 = 500；</li>
     *   <li><b>base36 两段无分隔符拼接</b>：{@code base36(a) + base36(b)} 无法唯一切分，
     *       不同 (毫秒, 序号) 组合理论上能拼出同一个串；</li>
     *   <li><b>与订单号是同族却两份实现</b>：L5 重写了 {@code OrderService} 的发号器，
     *       这处没被扫到 —— 典型的「改一处没查另一处」。</li>
     * </ol>
     * 现在与订单号**共用同一个** {@link InstanceSeqGenerator}：发号逻辑全项目只有一份，
     * 以后再加业务 id 也只会调它，写不出第二份错误实现。
     */
    private final InstanceSeqGenerator activityIds = new InstanceSeqGenerator(2);

    /**
     * 实例号（与订单号共用同一个键 {@code app.instance-id}，0..9，单实例保持默认 0）。
     * 字段注入而非构造器参数：本类是 Lombok {@code @RequiredArgsConstructor}，
     * 加构造器参数 = 改它生成的签名 = 全仓单测跟着补参。
     */
    @Value("${app.instance-id:0}")
    private int instanceId;

    // ==================== 查询 ====================

    /**
     * 全部活动（含已下架 / 已到期），按优先级降序 —— 管理后台列表用。
     * <p>
     * 表为空时自动补出厂活动：新库、换库、误清空之后首页 Banner 不会凭空消失。
     * 「清空活动」在这个业务里没有意义（至少总有一条展示型活动），
     * 所以这个自愈行为是安全的；要停掉一条活动请用「下架」而不是删除。
     */
    public List<ActivityDisplay> listAll() {
        seedIfEmpty();
        long now = System.currentTimeMillis();
        return sorted().stream().map(a -> displayOf(a, now)).toList();
    }

    /** 前台可展示的活动：仅 active / pending，且 active 全部排在 pending 之前 */
    public List<ActivityDisplay> listActive() {
        List<ActivityDisplay> all = listAll();
        List<ActivityDisplay> out = new ArrayList<>();
        all.stream().filter(d -> "active".equals(d.getState())).forEach(out::add);
        all.stream().filter(d -> "pending".equals(d.getState())).forEach(out::add);
        return out;
    }

    /**
     * 主推活动：优先第一个进行中的，其次待开始的，
     * 都没有则取列表首位（后台要能继续看到「已到期 / 已下架」的那条，好一键重新上架）。
     */
    public ActivityDisplay current() {
        List<ActivityDisplay> active = listActive();
        if (!active.isEmpty()) return active.get(0);
        long now = System.currentTimeMillis();
        return displayOf(sorted().get(0), now);
    }

    /** 进行中的活动数量（管理后台看板的「进行中活动数」待办） */
    public int countActive() {
        seedIfEmpty();
        long now = System.currentTimeMillis();
        long count = sorted().stream().filter(a -> "active".equals(stateOf(a, now))).count();
        return (int) count;
    }

    /** 进行中活动 id → 让利声明（卖家报名与结算的口径来源） */
    public List<Activity> findActive() {
        seedIfEmpty();
        long now = System.currentTimeMillis();
        return sorted().stream().filter(a -> "active".equals(stateOf(a, now))).toList();
    }

    // ==================== 让利归属解析（报名 / 结算共用） ====================

    /**
     * 找出「指定活动 + 指定分类」的让利声明所属活动，找不到返回 null。
     * <p>
     * ★ 两个调用方、两种口径，靠 {@code onlyActive} 区分，不要合并 ★
     * <ul>
     *   <li><b>报名</b>（{@code onlyActive = true}）：只认进行中的活动。待开始的活动
     *       还没生效，一旦放行就会立刻在商品上写出让利价 —— 变成「活动还没开始，
     *       商品就在打折」；</li>
     *   <li><b>结算</b>（{@code onlyActive = false}，含 pending）：商品一旦报名成功就带着
     *       {@code activityId}，这条线索比分类更精确，不该因为活动从 active 走到
     *       时间窗边缘就查不到 —— 那会把卖家实收算错。</li>
     * </ul>
     * 已下架（cancelled）与已到期（expired）的活动两边都不认：前者的让利承诺已被撤回，
     * 后者已经结束，都不该再生效。
     */
    public Activity claimActivity(String activityId, Long categoryId, boolean onlyActive) {
        if (activityId == null || activityId.isBlank() || categoryId == null) return null;
        seedIfEmpty();
        Activity a = activityMapper.selectById(activityId);
        if (a == null || rateOf(a, categoryId) == null) return null;
        String state = stateOf(a, System.currentTimeMillis());
        if (onlyActive) return "active".equals(state) ? a : null;
        return ("active".equals(state) || "pending".equals(state)) ? a : null;
    }

    /** 某活动对某分类的折扣率；未声明该分类返回 null（与前端 `claims.find(...)` 等价） */
    public Double rateOf(Activity a, Long categoryId) {
        if (a == null || categoryId == null) return null;
        for (ActivityDiscountClaim c : a.getClaims()) {
            if (categoryId.equals(c.getCategoryId())) return c.getRate();
        }
        return null;
    }

    /**
     * 一件商品的让利资金承担方 —— **结算与后台统计的唯一入口**。
     * <p>
     * 判定顺序（顺序本身就是约束，对应前端 `resolveFundSourceForGoods()`）：
     * <ol>
     *   <li>商品带 {@code activityId} → 认它，且只认它；解析不到就保守回落 {@code seller}；</li>
     *   <li>只有商品**完全没有** {@code activityId}（早期版本未落该字段的老数据）才按分类反查。</li>
     * </ol>
     * 为什么必须优先认 {@code activityId}：同一分类可挂多条活动，而它们的 fundSource
     * 可能不同（一个卖家让利、一个平台补贴）。一律按分类反查的话，商品报名的是
     * 「平台补贴」，结算却记成「卖家让利」→ 后台 GMV 把平台掏的钱算到卖家头上，
     * 卖家看到的实收也凭空变少。
     * <p>
     * 查不到时的回暖是 {@code seller}：宁可少声称「平台补贴」，
     * 也不能把卖家自己掏的钱记成平台掏的。
     */
    public String fundSourceFor(String activityId, Long categoryId) {
        Activity hit = claimActivity(activityId, categoryId, false);
        if (hit != null) return normalizeFundSource(hit.getFundSource());
        /*
         * ★ 商品「报过名」却已查不到那条活动时，绝不能退回去按分类反查 ★
         *
         * 同一个分类下可以同时挂着两条活动，且 fundSource 可能相反
         * （「开学季」卖家让利 + 「宿舍焕新」平台补贴，都覆盖分类 5）。
         * 原来的实现是「查不到就按分类找优先级最高的那条」，于是：
         *   商品报名的是 A（seller，0.8）→ 管理员把 A 删除 / 下架 / 到期后，
         *   回退逻辑命中仍然有效的 B（platform）→ fundSource 被判成 platform →
         *   结算付 85、platformSubsidy=15、sellerIncome=100。
         *   结果：平台凭空多出一笔它从未承诺的补贴支出，而这笔钱本该是卖家自己让的。
         * 反向同理（报名 platform、回退命中 seller）→ 卖家少收应得的补贴。
         *
         * 所以判据是：activityId 非空 = 「这单让利的归属已被那次报名锁定」。
         * 锁定的活动查不到（被删 / 下架 / 到期），只能保守地回落到 seller ——
         * 宁可少声称「平台补贴」，也不能替平台揽账。
         * 分类反查只留给真正的老数据：那种商品压根没有 activityId（早期版本未落该字段）。
         */
        if (activityId != null && !activityId.isBlank()) return "seller";
        if (categoryId == null) return "seller";
        // 老数据兜底：按分类在可展示活动里找优先级最高的那条（listActive 已按优先级降序）
        for (ActivityDisplay d : listActive()) {
            if (rateOf(d.getConfig(), categoryId) != null) {
                return normalizeFundSource(d.getConfig().getFundSource());
            }
        }
        return "seller";
    }

    /**
     * 商品当前**可解析到**的活动 id；解析不到（已被删除 / 下架 / 到期）时返回 null。
     * <p>
     * 订单要把「这一单属于哪次活动」作为溯源快照落库。但如果活动已经被删掉，
     * 还照着商品上残留的 {@code activityId} 写进订单，就会留下一条
     * 「订单自称属于某次活动、后台却查不到任何活动记录」的孤儿账 ——
     * 既点不开、也对不上，比不记更糟。所以只在**现在仍能解析**时才落这个 id。
     */
    public String resolvedActivityId(String activityId, Long categoryId) {
        Activity a = claimActivity(activityId, categoryId, false);
        return a != null ? a.getId() : null;
    }

    /** 只认 platform，其余一律 seller —— 与写入时的收敛规则保持同一口径 */
    private String normalizeFundSource(String fund) {
        return "platform".equals(fund) ? "platform" : "seller";
    }

    // ==================== 写操作 ====================

    /**
     * 新建活动。
     * <p>
     * 未传 startAt 视为「从此刻开始」，与前端 `createActivity` 的语义一致 ——
     * 管理员点「新建」时的心理预期就是「现在上线」，让他先选一个开始时间
     * 才能保存，等于强迫他填一个自己也没想好的值。
     */
    @Transactional
    public Activity create(Map<String, Object> body, String operator) {
        long now = System.currentTimeMillis();
        Activity a = new Activity();
        // t_activity.id 是 varchar(64)：管理员手工指定 id 时超长会撞 Data too long
        // （label 用「活动ID」不加空格：校验文案是 label + "最多 N 个字"，中间隔开会出现空档）
        String rawId = Validators.optional(str(body.get("id")), ACTIVITY_ID_MAX, "活动ID");
        a.setId(rawId != null ? rawId : nextId());
        /*
         * ★ 业务主键必须先查重 ★
         * t_activity.id 是业务字符串主键（非自增）。重复时 MySQL 抛的是
         * DuplicateKeyException —— 它不是 BusinessException，会一路冒到
         * GlobalExceptionHandler 的兜底分支，变成 500「服务器内部错误」。
         * 管理员看到的是「保存失败但不知道错在哪」，而真实原因仅仅是
         * 「这个活动 id 已经用过了」（前端新建时若沿用了上一个活动的 id 就会踩到）。
         * 先查一次，给出 1001 + 具体是哪个 id 重复。
         */
        if (activityMapper.selectById(a.getId()) != null) {
            throw BusinessException.paramError("活动 ID「" + a.getId() + "」已存在，请换一个");
        }
        a.setCreateTime(now);
        a.setUpdateTime(now);
        a.setCancelledAt(null);
        a.setCancelledBy(null);
        applyPatch(a, body, now);
        activityMapper.insert(a);
        addLog("activity.create", "新建活动", "活动「" + a.getTitle() + "」",
                a.getDurationDays() + " 天 · 优先级 " + a.getPriority() + " · "
                        + (Boolean.FALSE.equals(a.getEnabled()) ? "存为草稿" : "立即上架"), operator);
        return a;
    }

    /** 编辑活动（局部更新，未传的字段保持原值） */
    @Transactional
    public Activity update(String id, Map<String, Object> body, String operator) {
        Activity a = require(id);
        boolean enabledChanged = body.get("enabled") != null
                && !Boolean.valueOf(String.valueOf(body.get("enabled"))).equals(a.getEnabled());
        applyPatch(a, body, System.currentTimeMillis());
        if (enabledChanged) writeCancelledMark(a, Boolean.FALSE.equals(a.getEnabled()), operator);
        a.setUpdateTime(System.currentTimeMillis());
        activityMapper.updateById(a);
        /*
         * ★ 两种清空路径都要兜住 ★
         *  ① 重新启用（enabledChanged 且 enabled=true）→ writeCancelledMark 已把实体置 null；
         *  ② 前端在 patch 里显式传 cancelledAt=null（applyPatch 会把实体置 null）。
         * 两者共同点是「实体为 null」，而 updateById 写不进 NULL ⇒ 统一在这里显式清列。
         * 反过来说：实体非 null 时（本次是下架）绝不能清，否则会把刚写的下架记录抹掉。
         */
        if (a.getCancelledAt() == null) clearCancelledMark(a.getId());
        addLog("activity.update", "编辑活动", "活动「" + a.getTitle() + "」",
                "更新字段：" + String.join("、", body.keySet()), operator);
        return a;
    }

    /** 上架 / 下架活动（下架即 cancelled，前台立即消失，记录保留） */
    @Transactional
    public Activity setEnabled(String id, boolean enabled, String operator) {
        Activity a = require(id);
        a.setEnabled(enabled);
        a.setUpdateTime(System.currentTimeMillis());
        writeCancelledMark(a, !enabled, operator);
        activityMapper.updateById(a);
        // ★ 重新上架 = 清空取消标记，必须显式写 NULL（updateById 跳 null）★
        if (a.getCancelledAt() == null) clearCancelledMark(a.getId());
        addLog(enabled ? "activity.online" : "activity.offline",
                enabled ? "上架活动" : "下架活动",
                "活动「" + a.getTitle() + "」", "ID " + id, operator);
        return a;
    }

    /** 删除活动 */
    @Transactional
    public boolean delete(String id, String operator) {
        Activity a = activityMapper.selectById(id);
        if (a == null) return false;
        activityMapper.deleteById(id);
        addLog("activity.delete", "删除活动", "活动「" + a.getTitle() + "」", "ID " + id, operator);
        return true;
    }

    /**
     * 提前结束「主推活动」（兼容旧入口）。
     * <p>
     * 语义上就是「把当前主推的那条下架」，单独开一个入口是为了让前端
     * 旧版按钮不必先查 id —— 但**服务端自己解析主推**，不接受客户端传 id，
     * 否则「结束主推活动」会变成「结束任意活动」。
     */
    @Transactional
    public Activity closeFeatured(String operator) {
        return setEnabled(current().getConfig().getId(), false, operator);
    }

    /**
     * 重新开启「主推活动」（默认 14 天，倒计时重置）。
     * <p>
     * 重置 startAt 是刻意的：只把 enabled 打开的话，一个 40 天前就开始的活动
     * 打开瞬间就是「已到期」，按钮看起来没反应。
     */
    @Transactional
    public Activity restartFeatured(Integer durationDays, String operator) {
        int days = durationDays != null && durationDays > 0 ? durationDays : DEFAULT_ACTIVITY_DAYS;
        Activity a = require(current().getConfig().getId());
        long now = System.currentTimeMillis();
        a.setEnabled(true);
        a.setStartAt(now);
        a.setDurationDays(days);
        a.setCancelledAt(null);
        a.setCancelledBy(null);
        a.setUpdateTime(now);
        activityMapper.updateById(a);
        /*
         * ★ 必须显式清空，不能只靠上面两行 setCancelledAt(null) ★
         * 重开的活动如果留着上一轮的 cancelledAt，前端 `ActivityPanel.vue` 的
         * `v-if="cancelledAt"` 会把它渲染成「已下架于 …」—— 一个正在跑的活动显示成已下架。
         */
        clearCancelledMark(a.getId());
        addLog("activity.online", "上架活动", "活动「" + a.getTitle() + "」",
                "重新开启 " + days + " 天，倒计时已重置", operator);
        return a;
    }

    /**
     * 恢复出厂活动：清掉全部活动后按内置模板重建。
     * <p>
     * 模板定义在 {@link #factorySeeds()}，与前端 `makeSeedActivities()` 逐字段对应 ——
     * 两边文案与 `claims` 必须一致（「N 折」↔ rate = N/10），
     * 否则恢复出厂后前端展示的力度声明会和库里对不上。
     */
    @Transactional
    public List<Activity> resetToFactory(String operator) {
        activityMapper.delete(null);
        List<Activity> seeds = factorySeeds();
        seeds.forEach(activityMapper::insert);
        addLog("activity.reset", "恢复出厂活动", seeds.size() + " 个活动", "清除对活动的全部改动", operator);
        return seeds;
    }

    // ==================== 内部：状态与展示 ====================

    /**
     * 计算活动状态。
     * <p>
     * 判定顺序不能变：**先看 enabled**。一条被管理员下架的活动，
     * 即使还在时间窗内也必须是 cancelled —— 反过来的话，下架的第二天
     * 它又会因为「仍在有效期内」自己回到前台。
     */
    public String stateOf(Activity a, long now) {
        if (!Boolean.TRUE.equals(a.getEnabled())) return "cancelled";
        long expiresAt = expiresAt(a);
        if (now < a.getStartAt()) return "pending";
        if (now >= expiresAt) return "expired";
        return "active";
    }

    private long expiresAt(Activity a) {
        return a.getStartAt() + (long) a.getDurationDays() * DAY_MS;
    }

    private ActivityDisplay displayOf(Activity a, long now) {
        long expiresAt = expiresAt(a);
        String state = stateOf(a, now);
        ActivityDisplay d = new ActivityDisplay();
        d.setConfig(a);
        d.setState(state);
        d.setExpiresAt(expiresAt);
        // 已过期时剩余为 0，不能给负数 —— 前端会直接把它渲染成倒计时
        d.setRemainingMs(Math.max(0L, expiresAt - now));
        d.setShouldShow("active".equals(state) || "pending".equals(state));
        return d;
    }

    /** 优先级降序；同优先级时开始时间新的排前面 */
    private List<Activity> sorted() {
        List<Activity> list = new ArrayList<>(activityMapper.selectList(new LambdaQueryWrapper<>()));
        list.sort(Comparator.comparingInt((Activity a) -> nz(a.getPriority()))
                .thenComparingLong(a -> nz(a.getStartAt()))
                .reversed());
        return list;
    }

    private Activity require(String id) {
        Activity a = id == null ? null : activityMapper.selectById(id);
        if (a == null) throw BusinessException.notFound("活动不存在：" + id);
        return a;
    }

    /**
     * 下架时记时间与操作者；重新上架时清掉，避免「已上架却带着下架记录」。
     * <p>
     * ★ 只负责**内存对象**；落库由调用方在 {@code updateById} 之后按需调用
     * {@link #clearCancelledMark(String)} 完成 ★
     * <p>
     * 原因：写入路径里 {@code a.setCancelledAt(null)} 配 {@code updateById} 是**清不掉的** ——
     * MyBatis-Plus 默认 {@code FieldStrategy.NOT_NULL}，null 字段根本不进 SET 子句
     * （本项目 {@code application.yml} 未覆盖 {@code update-strategy}）。
     * 所以「重新上架」必须**显式 SET 成 NULL**，见下。
     */
    private void writeCancelledMark(Activity a, boolean cancelled, String operator) {
        if (cancelled) {
            a.setCancelledAt(System.currentTimeMillis());
            a.setCancelledBy(operator);
        } else {
            a.setCancelledAt(null);
            a.setCancelledBy(null);
        }
    }

    /**
     * 显式把 {@code cancelled_at} / {@code cancelled_by} 置 NULL。
     * <p>
     * ★ 为什么不能用 {@code updateById} ★
     * MP 默认 {@code FieldStrategy.NOT_NULL} ⇒ null 字段不进 SET ⇒ 实体上的
     * {@code setCancelledAt(null)} 在库上**等于什么都没做**，重新上架的活动会一直
     * 挂着上一轮的取消时间；而前端 {@code ActivityPanel.vue} 有
     * {@code v-if="cancelledAt"}，于是**正在跑的活动会被渲染成「已下架于 …」**。
     * {@code LambdaUpdateWrapper.set(col, null)} 走的是 {@code formatParam}，
     * **一定会拼进 SET 子句**，这才是真正的清空。
     */
    private void clearCancelledMark(String activityId) {
        if (activityId == null) return;
        activityMapper.update(null, new LambdaUpdateWrapper<Activity>()
                .eq(Activity::getId, activityId)
                .set(Activity::getCancelledAt, null)
                .set(Activity::getCancelledBy, null));
    }

    /** 与 schema.sql 严格一致：t_activity 的窄列宽度 */
    private static final int ACTIVITY_ID_MAX = 64;
    private static final int TITLE_MAX = 100;
    private static final int SUBTITLE_MAX = 200;
    private static final int CTA_TEXT_MAX = 50;
    private static final int CTA_LINK_MAX = 200;
    private static final int ICON_MAX = 50;
    private static final int NOTE_MAX = 500;

    /** 活动天数上限（10 年）：下限由 applyPatch 兜底成默认值，这里只挡明显不合理的超大值 */
    private static final int DURATION_DAYS_MAX = 3650;

    /**
     * 把请求体里的字段合并进活动实体，顺带做结构校验与默认值兜底
     * （与前端 `normalizeActivity()` 同规则，两边不能各写一套默认值）。
     * <p>
     * ★ 活动表全是 30~200 的窄 varchar，一处都不能漏 ★
     * t_activity: title(100) / subtitle(200) / cta_text(50) / cta_link(200) /
     * icon(50) / theme(30) / note(500)。原先这些字段直接 set 进实体，
     * 运营在后台把标题写长一点就会撞 MySQL 严格模式抛 Data too long，
     * 页面只弹一句「服务器内部错误」—— 运营只会以为是系统坏了，反复重试。
     * theme / fundSource 已有白名单收敛（见 {@link #THEMES}），这里补的是文本长度。
     */
    private void applyPatch(Activity a, Map<String, Object> body, long now) {
        if (body.get("enabled") != null) {
            a.setEnabled(Boolean.valueOf(String.valueOf(body.get("enabled"))));
        } else if (a.getEnabled() == null) {
            a.setEnabled(true);
        }

        Long startAt = longOf(body.get("startAt"));
        a.setStartAt(startAt != null && startAt > 0 ? startAt : (a.getStartAt() != null ? a.getStartAt() : now));

        Integer days = intOf(body.get("durationDays"));
        if (days == null) days = a.getDurationDays();
        Validators.range(days, 1, DURATION_DAYS_MAX, "活动持续天数");
        a.setDurationDays(days != null && days > 0 ? days : DEFAULT_ACTIVITY_DAYS);

        String safeTitle = Validators.optional(str(body.get("title")), TITLE_MAX, "活动标题");
        String safeSubtitle = Validators.optional(str(body.get("subtitle")), SUBTITLE_MAX, "活动副标题");
        if (body.containsKey("title")) a.setTitle(safeTitle);
        if (body.containsKey("subtitle")) a.setSubtitle(safeSubtitle);
        if (a.getTitle() == null) a.setTitle("");
        String safeCtaText = Validators.optional(str(body.get("ctaText")), CTA_TEXT_MAX, "按钮文案");
        a.setCtaText(safeCtaText != null ? safeCtaText
                : (a.getCtaText() != null ? a.getCtaText() : "立即参与"));
        String safeCtaLink = Validators.optional(str(body.get("ctaLink")), CTA_LINK_MAX, "跳转链接");
        a.setCtaLink(safeCtaLink != null ? safeCtaLink
                : (a.getCtaLink() != null ? a.getCtaLink() : "/goods"));
        String safeIcon = Validators.optional(str(body.get("icon")), ICON_MAX, "活动图标");
        a.setIcon(safeIcon != null ? safeIcon
                : (a.getIcon() != null ? a.getIcon() : "🎯"));

        if (body.get("highlights") != null) {
            a.setHighlights(stringList(body.get("highlights")));
        } else if (a.getHighlights() == null) {
            a.setHighlights(new ArrayList<>());
        }

        String theme = str(body.get("theme"));
        if (theme == null) theme = a.getTheme();
        a.setTheme(theme != null && THEMES.contains(theme) ? theme : "orange");

        Integer priority = intOf(body.get("priority"));
        a.setPriority(priority != null ? priority : (a.getPriority() != null ? a.getPriority() : 50));

        String fund = str(body.get("fundSource"));
        if (fund == null) fund = a.getFundSource();
        // 只认 platform，其余一律 seller：宁可少声称「平台补贴」，也不能把卖家掏的钱记成平台掏的
        a.setFundSource("platform".equals(fund) ? "platform" : "seller");

        if (body.get("claims") != null) {
            a.setClaims(claimsOf(body.get("claims")));
        } else if (a.getClaims() == null) {
            a.setClaims(new ArrayList<>());
        }

        if (body.containsKey("note")) {
            // t_activity.note 是 varchar(500)：运营写的活动备注超长同样会在落库时抛 500
            String safeNote = Validators.optional(str(body.get("note")), NOTE_MAX, "活动备注");
            a.setNote(safeNote == null || safeNote.isBlank() ? null : safeNote);
        }

        if (body.containsKey("cancelledAt")) {
            Long cancelledAt = longOf(body.get("cancelledAt"));
            a.setCancelledAt(cancelledAt);
            if (cancelledAt == null) a.setCancelledBy(null);
        }
    }

    /**
     * 让利声明的结构收敛。
     * <p>
     * 过滤掉 {@code rate} 不在 (0,1) 区间或分类 id 非法的条目 ——
     * 一条 rate=1.5 的声明会让「让利价」比挂牌价还高，一条 rate=0 的声明
     * 等于白送。这类脏数据只要落库，结算时就会算出负的卖家实收，
     * 所以必须在入口挡掉，而不是等到对账时才发现。
     */
    private List<ActivityDiscountClaim> claimsOf(Object raw) {
        List<ActivityDiscountClaim> out = new ArrayList<>();
        if (!(raw instanceof List<?> list)) return out;
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m)) continue;
            Long categoryId = longOf(m.get("categoryId"));
            Double rate = doubleOf(m.get("rate"));
            if (categoryId == null || categoryId <= 0) continue;
            if (rate == null || rate <= 0 || rate >= 1) continue;
            out.add(new ActivityDiscountClaim(categoryId, rate));
        }
        return out;
    }

    private List<String> stringList(Object raw) {
        List<String> out = new ArrayList<>();
        if (!(raw instanceof List<?> list)) return out;
        for (Object o : list) {
            String s = str(o);
            if (s != null && !s.isBlank()) out.add(s);
        }
        return out;
    }

    /**
     * 首次访问时补出厂活动（表为空才补）。
     * <p>
     * 为什么不放在 {@code @PostConstruct}：那时数据源虽已就绪，
     * 但表可能还没建（换库、首次导入），启动即失败会让整个应用起不来。
     * 放在查询入口做惰性补种，最坏情况只是活动列表为空，不影响其它功能。
     */
    private void seedIfEmpty() {
        if (activityMapper.selectCount(new LambdaQueryWrapper<>()) > 0) return;
        factorySeeds().forEach(activityMapper::insert);
    }

    /**
     * 出厂活动模板 —— 与前端 `makeSeedActivities()` **逐字段对应**。
     * <p>
     * ⚠️ 文案与 claims 必须严格对应（「N 折」↔ rate = N/10），并且
     * 声称的力度必须在商品数据里真实存在；旧版「教材分类全场 5 折起」
     * 既不限定范围、也没声明资金归属，属虚假宣传，已修正。
     * <p>
     * 「生活用品」被开学季（卖家让利 8 折）与宿舍焕新（平台补贴 8.5 折）
     * **同时声明**，这是刻意保留的：现实里两个活动并行覆盖同一批商品很常见，
     * 但谁掏钱不一样，卖家必须二选一 —— 数据上它是「多活动共享分类」的实例。
     */
    private List<Activity> factorySeeds() {
        long now = System.currentTimeMillis();
        List<Activity> list = new ArrayList<>();

        Activity a1 = base("back-to-school-2026-fall", true, now, DEFAULT_ACTIVITY_DAYS, now - 3 * DAY_MS);
        a1.setTitle("卖家让利专区：教材 5 折起，宿舍电器 8 折起");
        a1.setSubtitle("折扣来自卖家自愿让利，平台不加价、不代卖家定价");
        a1.setCtaText("看看让利好物");
        a1.setCtaLink("/goods?categoryId=1");
        a1.setHighlights(List.of("卖家让利 · 教材 5 折起", "宿舍电器 8 折起", "参与活动商品", "平台担保交易"));
        a1.setIcon("🎓");
        a1.setTheme("orange");
        a1.setPriority(100);
        a1.setFundSource("seller");
        a1.setClaims(List.of(new ActivityDiscountClaim(1L, 0.5), new ActivityDiscountClaim(5L, 0.8)));
        a1.setNote("首页主推位 · 折扣由卖家自愿让利，平台不代卖家定价");
        list.add(a1);

        Activity a2 = base("digital-refresh-week", true, now, 7, now - 2 * DAY_MS);
        a2.setTitle("平台补贴日：数码好物 8 折起");
        a2.setSubtitle("补贴由平台承担，卖家实收不变，验机后再付款");
        a2.setCtaText("逛逛数码");
        a2.setCtaLink("/goods?categoryId=2");
        a2.setHighlights(List.of("平台补贴 · 数码 8 折起", "卖家实收不变", "当面验机"));
        a2.setIcon("🎧");
        a2.setTheme("blue");
        a2.setPriority(80);
        a2.setFundSource("platform");
        a2.setClaims(List.of(new ActivityDiscountClaim(2L, 0.8)));
        a2.setNote("与主推活动并行：平台补贴不减少卖家收入");
        a2.setUpdateTime(now - 1 * DAY_MS);
        list.add(a2);

        Activity a3 = base("dorm-upgrade-2026", true, now, 10, now - 1 * DAY_MS);
        a3.setTitle("宿舍焕新补贴周：生活好物 8.5 折");
        a3.setSubtitle("补贴由平台承担，卖家实收不变，宿舍楼下当面验货");
        a3.setCtaText("逛逛生活好物");
        a3.setCtaLink("/goods?categoryId=5");
        a3.setHighlights(List.of("平台补贴 · 生活好物 8.5 折", "卖家实收不变", "当面验货"));
        a3.setIcon("🛋️");
        a3.setTheme("purple");
        a3.setPriority(70);
        a3.setFundSource("platform");
        a3.setClaims(List.of(new ActivityDiscountClaim(5L, 0.85)));
        a3.setNote("与开学季特卖并行：同分类两个活动，卖家在发布页二选一");
        a3.setUpdateTime(now - 1 * DAY_MS);
        list.add(a3);

        // 已自然到期的一条：保留在列表里，管理员可一键重新上架
        Activity a4 = base("grad-clearance-2026", true, now - 40 * DAY_MS, DEFAULT_ACTIVITY_DAYS, now - 45 * DAY_MS);
        a4.setTitle("毕业清仓专场：校友离校行李电器特卖");
        a4.setSubtitle("毕业生离校甩卖，宿舍神器一律白菜价");
        a4.setCtaText("去捡漏");
        a4.setCtaLink("/goods?categoryId=5");
        a4.setHighlights(List.of("离校清仓", "宿舍神器", "当日面交"));
        a4.setIcon("🧳");
        a4.setTheme("green");
        a4.setPriority(60);
        a4.setFundSource("seller");
        // 无折扣声明：本活动只做展示与曝光，不改动任何商品价格
        a4.setClaims(new ArrayList<>());
        a4.setNote("已自然到期（保留在列表中，可一键重新上架）");
        a4.setUpdateTime(now - 40 * DAY_MS);
        list.add(a4);

        return list;
    }

    private Activity base(String id, boolean enabled, long startAt, int days, long createTime) {
        Activity a = new Activity();
        a.setId(id);
        a.setEnabled(enabled);
        a.setStartAt(startAt);
        a.setDurationDays(days);
        a.setTheme("orange");
        a.setPriority(50);
        a.setFundSource("seller");
        a.setHighlights(new ArrayList<>());
        a.setClaims(new ArrayList<>());
        a.setIcon("🎯");
        a.setCtaText("立即参与");
        a.setCtaLink("/goods");
        a.setTitle("");
        a.setCreateTime(createTime);
        a.setUpdateTime(createTime);
        return a;
    }

    /** 见 {@link #nextId()}：传固定毫秒即可确定性复现「同一毫秒内连发」。 */
    String nextId(long nowMillis) {
        return activityIds.id("act_", nowMillis, instanceId);
    }

    private String nextId() {
        return nextId(System.currentTimeMillis());
    }

    /** 操作日志：活动是有资金归属的业务数据，每个写操作都要留痕 */
    private void addLog(String action, String label, String target, String detail, String operator) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        log.setOperator(operator != null && !operator.isBlank() ? operator : "admin");
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }

    // ==================== 内部：类型收敛 ====================

    private String str(Object raw) {
        if (raw == null) return null;
        String s = String.valueOf(raw);
        return s.isBlank() ? null : s;
    }

    /** JSON 里数字可能是 Integer/Long/Double，统一按 Number 收，避免 ClassCastException */
    private Long longOf(Object raw) {
        if (raw instanceof Number n) return n.longValue();
        String s = str(raw);
        if (s == null) return null;
        try {
            return new java.math.BigDecimal(s).longValue();
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private Integer intOf(Object raw) {
        Long v = longOf(raw);
        return v == null ? null : v.intValue();
    }

    private Double doubleOf(Object raw) {
        if (raw instanceof Number n) return n.doubleValue();
        String s = str(raw);
        if (s == null) return null;
        try {
            return Double.valueOf(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private int nz(Integer v) {
        return v == null ? 0 : v;
    }

    private long nz(Long v) {
        return v == null ? 0L : v;
    }

    /** 与前端 `activityStateLabel` 共用同一套状态集合（供文档与测试引用） */
    public static List<String> allStates() {
        return ALL_STATES;
    }

    /** 便于测试：把状态集合映射成中文标签 */
    public static Map<String, String> stateLabels() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("active", "进行中");
        m.put("pending", "待开始");
        m.put("expired", "已到期");
        m.put("cancelled", "已取消");
        return m;
    }
}
