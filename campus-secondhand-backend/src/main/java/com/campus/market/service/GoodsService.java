package com.campus.market.service;

import com.campus.market.common.BusinessException;
import com.campus.market.common.OperatorContext;
import com.campus.market.common.PromoPricing;
import com.campus.market.common.Validators;
import com.campus.market.entity.*;
import com.campus.market.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 商品业务逻辑层
 * <p>
 * 职责：商品 CRUD / 上下架 / 批量操作 / 分类管理
 */
@Service
@RequiredArgsConstructor
public class GoodsService {

    private final GoodsMapper goodsMapper;
    private final CategoryMapper categoryMapper;
    private final AuditLogMapper auditLogMapper;
    private final UserMapper userMapper;
    /** 商品被删除时连带清理收藏与浏览足迹 */
    private final FavoriteMapper favoriteMapper;
    private final HistoryMapper historyMapper;
    /** 商品被删除时连带清理留言与评价（否则它们会挂在已不存在的 goods_id 上） */
    private final CommentMapper commentMapper;
    private final ReviewMapper reviewMapper;
    /** 让利价必须由活动规则算出，所以发布流程要反查活动声明 */
    private final ActivityService activityService;
    /** 发布流程要读系统配置（每日发布上限），配置的读取口径收敛在 AnalyticsService 一处 */
    private final AnalyticsService analyticsService;

    /**
     * 买家侧（含匿名）在**不给任何状态条件**时的默认可见范围。
     * <p>
     * 与 {@code on_sale} / {@code sold} 这条详情可见性口径完全一致 ——
     * 列表能看见什么，详情就必须能打开什么，否则「列表有、点进去 404」。
     */
    private static final List<String> BUYER_VISIBLE_STATUS = List.of("on_sale", "sold");

    /**
     * 商品状态白名单 —— 只有这四种允许落库。
     * <p>
     * ★ 原先一个校验都没有 ★
     * <p>
     * {@code PATCH /goods/{id}/status} 与 {@code PATCH /user/goods/{id}/status} 都把
     * 客户端传来的 status 字符串**原样写进 status 列**（实测传 {@code teleport} 返回成功、
     * 库里真的变成 {@code teleport}）。而商品列表可见性、运营看板分类占比、
     * 活动让利判定全都按已知状态分支，幽灵状态会让这件商品
     * **在买家和后台两侧同时消失，却仍占着一条记录**，排查时极难定位。
     * <p>
     * 状态语义：{@code pending} 审核中 / {@code on_sale} 在售 / {@code sold} 已售出 / {@code off_shelf} 已下架。
     */
    private static final List<String> GOODS_STATUSES = List.of("pending", "on_sale", "sold", "off_shelf");

    /* ==================== 发布商品的入参边界 ==================== */

    /**
     * 金额上限：{@code t_goods.price} 是 {@code decimal(10,2)}，最大只能到 99999999.99。
     * 超出时 MySQL 抛 {@code Out of range value}，兜底成 500「服务器内部错误」。
     */
    private static final BigDecimal MAX_PRICE = new BigDecimal("99999999.99");

    /** 单件商品的可售数量上限 */
    private static final int MAX_STOCK = 9999;

    /** 图集最多张数，与发布页 9 个格子的上限对齐 */
    private static final int MAX_IMAGES = 9;

    /** 允许的交易方式，取值与 {@code t_goods.delivery_method} 的列注释一致 */
    private static final List<String> DELIVERY_METHODS = List.of("face", "express", "self");

    /** 以下长度上限一律对齐**列宽**，超出会被 MySQL 以 Data too long 拒绝 */
    private static final int MAX_TITLE = 200;
    private static final int MAX_LOCATION = 200;
    private static final int MAX_COVER = 255;
    private static final int MAX_IMAGE_URL = 255;

    /** 描述列是 text（64KB），这里按文案合理性收紧 */
    private static final int MAX_DESCRIPTION = 2000;

    /**
     * 商品列表查询（买家侧 / 后台共用）
     * <p>
     * ★ 可见范围由**服务端**判定，不信任调用方带来的筛选条件 ★
     * <p>
     * 列表返回的是整个 {@code Goods} 实体（含 title / price / description），
     * 一旦泄漏就等于把详情接口的可见性判定整个绕过去。历史上有两个口子：
     * <ol>
     *   <li>**不带任何状态条件时返回全量**。这本身是**后台**需要的能力 ——
     *       {@code GoodsPanel.vue}（商品管理）与 {@code SettingsPanel.vue}（导出 CSV）
     *       都不带状态条件，要看到含 pending / off_shelf / sold 的全量，这条不能动；
     *       但这个接口是**公开路由**，匿名同样能不带条件地调，于是「审核中」的商品
     *       对任何人可见。</li>
     *   <li>**显式传入的状态条件被原样执行**。买家侧的白名单
     *       （{@code statuses=[on_sale,sold]}）是由调用方自己声明的，服务端照单全收 ——
     *       匿名只要多带一个 {@code ?statuses=pending} 就能把口子重新打开。</li>
     * </ol>
     * 因此改为与详情侧 {@link #fetchGoodsDetail(Long, Long, String)} **同口径**按访问者身份收敛
     * （列表能看见什么，详情就必须能打开什么；反之亦然）：
     * <ul>
     *   <li>后台角色 → 条件原样执行，含不带条件拿全量；</li>
     *   <li>卖家查自己的发布（{@code sellerId} 等于自己的 id）→ 条件原样执行，
     *       否则「我的发布」里的待审 / 已下架商品会看不见；</li>
     *   <li>其余（买家 / 匿名）→ 只保留落在 {@link #BUYER_VISIBLE_STATUS} 内的条件；
     *       条件被剔除干净时**退回默认可见范围**，而不是返回空页
     *       （空页会让「筛选条件失效」看起来像「真的没有数据」，更难排查）。</li>
     * </ul>
     * 越界条件一律按「不存在」静默剔除，**不返回 403** —— 403 等于告诉对方
     * 「这个状态下有内容，只是不给你看」，反而泄露了信息。
     *
     * @param viewerId   当前登录用户 id；匿名访问为 {@code null}
     * @param viewerRole 当前登录用户角色；匿名访问为 {@code null}
     */
    public IPage<Goods> fetchGoods(int page, int pageSize, String keyword, Long categoryId,
                                     Long sellerId, String status, List<String> statuses, String sort,
                                     Long viewerId, String viewerRole) {
        String effectiveStatus = status;
        List<String> effectiveStatuses = statuses;

        if (!isUnrestrictedViewer(viewerId, viewerRole, sellerId)) {
            boolean statusAllowed = effectiveStatus != null
                    && BUYER_VISIBLE_STATUS.contains(effectiveStatus);
            List<String> kept = (effectiveStatuses == null ? List.<String>of() : effectiveStatuses)
                    .stream()
                    .filter(BUYER_VISIBLE_STATUS::contains)
                    .toList();
            if (statusAllowed) {
                // status 与 statuses 在 SQL 里是 AND 关系，两个同时下发会互相打架 —— 单状态优先
                effectiveStatuses = null;
            } else if (!kept.isEmpty()) {
                effectiveStatus = null;
                effectiveStatuses = kept;
            } else {
                effectiveStatus = null;
                effectiveStatuses = BUYER_VISIBLE_STATUS;
            }
        }
        return goodsMapper.selectGoodsPage(
                new Page<>(page, pageSize), keyword, categoryId, sellerId,
                effectiveStatus, effectiveStatuses, sort);
    }

    /**
     * 是否不受买家可见范围约束。
     * <p>
     * 两类人：后台角色（要能管理全量），以及**在查自己发布**的卖家
     * （{@code sellerId} 恰好等于自己的 id）—— 卖家得看得见自己那些待审 / 已下架的商品。
     * 注意这里必须是「查自己」，不能只看「登录了」，否则任意登录用户传个 sellerId
     * 仍会被当成后台处理。
     */
    private boolean isUnrestrictedViewer(Long viewerId, String viewerRole, Long sellerId) {
        return isBackendRole(viewerRole) || (viewerId != null && viewerId.equals(sellerId));
    }

    /** 后台角色：能看全量状态。与详情侧的 {@link #DETAIL_PRIVILEGED_ROLES} 同口径。 */
    private boolean isBackendRole(String role) {
        return role != null && DETAIL_PRIVILEGED_ROLES.contains(role);
    }

    /**
     * 商品详情（匿名视角）
     * <p>
     * 保留这个单参重载只为兼容内部调用；HTTP 入口必须走带身份的那个重载。
     */
    public Goods fetchGoodsDetail(Long id) {
        return fetchGoodsDetail(id, null, null);
    }

    /**
     * 商品详情（带访问者身份，做可见性判定）
     * <p>
     * ★ 为什么要判定 ★
     * <p>
     * 列表接口靠 {@code statuses} 白名单挡住了「审核中 / 已下架」的商品，
     * 但详情接口此前**没有任何对应判定** —— 广场里看不见，直接按 id 访问却读得到：
     * <ul>
     *   <li>「审核中」的内容能被提前曝光：把详情链接发出去就绕过了审核闸门；</li>
     *   <li>「已下架」的商品（含因违规被下架的）仍可被任何人访问，下架意图未真正生效。</li>
     * </ul>
     *
     * ★ 判定口径 ★
     * <ul>
     *   <li>{@code on_sale} / {@code sold} → **任何人**可见
     *       （买家要能浏览，已售出的也要能参考成交行情）</li>
     *   <li>{@code pending} / {@code off_shelf} → 仅**卖家本人**与{@link #DETAIL_PRIVILEGED_ROLES 后台角色}可见</li>
     * </ul>
     * 不可见时返回 **404 而不是 403**：403 等于告诉对方「这个 id 存在，只是你没权限看」，
     * 反而把商品的存在性泄露了出去。
     * <p>
     * ⚠️ 详情是**公开路由**（匿名可达，见 {@code AuthInterceptor.PUBLIC_GET} 里的 {@code /goods/*}），
     * 所以这里两个身份参数都**必须允许为 null**，不能假定拦截器一定注入了身份。
     * （拦截器对公开路径也会尽力解析 token，带了就注入，没带就是 null。）
     * <p>
     * ⚠️ 必须保住「卖家能看自己的 pending 商品」这条路径，否则前端
     * 「我的发布 → 查看」会直接 404 —— 那是个修过的老 bug，别让它回归。
     *
     * @param id         商品 id
     * @param viewerId   当前登录用户 id；匿名访问为 {@code null}
     * @param viewerRole 当前登录用户角色；匿名访问为 {@code null}
     */
    public Goods fetchGoodsDetail(Long id, Long viewerId, String viewerRole) {
        Goods g = goodsMapper.selectById(id);
        if (g == null) throw BusinessException.notFound("商品不存在");

        String st = g.getStatus();
        boolean openToAll = "on_sale".equals(st) || "sold".equals(st);
        if (!openToAll) {
            boolean isOwner = viewerId != null && viewerId.equals(g.getSellerId());
            boolean isBackend = viewerRole != null && DETAIL_PRIVILEGED_ROLES.contains(viewerRole);
            if (!isOwner && !isBackend) {
                throw BusinessException.notFound("商品不存在");
            }
        }

        // 增加浏览量：**只发一条单列 UPDATE**，绝不 updateById 整实体回写。
        //
        // ★ 这里曾经是「读整实体 → setViewCount(+1) → updateById 整体回写」★
        // 详情页是全站**写入最频繁**的接口（每看一次商品写一行），它与「下单扣库存」天然并发。
        // 整实体回写会把上面 selectById 读到的**旧快照**盖回整行，于是：
        //   买家 A 打开详情（读到 stock = 1）
        //   → 买家 B 下单（OrderService 用 `stock = stock - qty` 原子扣到 0，订单成立）
        //   → A 这次请求把 stock = 1 写回去 ⇒ **防超卖被旁路，库存凭空多出一件**
        // 同一瞬间卖家改过的 price、别人加上的 favorite_count 也会一并被还原成旧值。
        // 改成一条原子自增后，不读整行，就不可能覆盖别的列。
        // （同一个坑在 UserService.refreshFavoriteCount 已经踩过一次，见那里的注释。）
        //
        // COALESCE 是必须的：老数据没写 view_count（列为 NULL），`NULL + 1` 仍是 NULL，
        // 浏览量会永远停在空值上，而不是像原先 NPE 那样至少能看见报错。
        goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                .eq(Goods::getId, id)
                .setSql("view_count = COALESCE(view_count, 0) + 1"));
        // 返回给前端的展示值在内存里 +1 即可 —— 浏览量是展示性指标，
        // 不值得为了它在并发下再补一次读（多一次查询换 ±1 的精确度，不划算）
        g.setViewCount((g.getViewCount() == null ? 0 : g.getViewCount()) + 1);
        return g;
    }

    /**
     * 发布商品
     * <p>
     * ★ 账号状态闸门：封禁账号连登录都不行，故这里无需再查账号状态
     * （用户 pending 状态已随 D11 拆除，用户只剩 active / banned 两态）
     */
    @Transactional
    public Goods publishGoods(Goods goods, Long sellerId) {
        User seller = userMapper.selectById(sellerId);
        if (seller == null) throw BusinessException.notFound("用户不存在");

        // ★ 每日发布上限：t_settings.max_publish_per_day（0 = 不限）★
        //
        // 这一条先前只是后台设置页上的一个数字：存得进、读得出、**不产生任何行为**。
        // 管理员把「每日发布上限」改成 2 也拦不住任何人，改回 10 也没有变化 ——
        // 一个看起来能配置、实际不生效的开关，比没有这个开关更容易误导人。
        //
        // ★ 为什么在发布入口拦，而不是在商品列表/审核环节 ★
        // 限制的对象是「发布这个动作」，所以要在动作发生前拦；发布成功后再补删，
        // 会让「今天发了两件、其中一件被系统悄悄删掉」这种不可解释的结果出现在用户面前。
        //
        // ★ 竞态说明（有意接受）★
        // 「查数量 → 判断 → 插入」不是原子的，并发发布理论上可以略微超出上限。
        // 这是一条「防止刷屏」的软限制，不是资金约束，为此加唯一索引/计数表不划算。
        // 真正需要强一致的场景（下单扣库存）走的是另一条路（SQL 原子自减）。
        //
        // ★ 时区提醒 ★
        // LocalDate.now() 取的是 **JVM 时区**的「今天」。容器里 JVM 与 MySQL 时区不一致时，
        // 「今天」的边界会与预期不同 —— 这与部署清单里的时区项同根因，
        // 部署时用 -Duser.timezone=Asia/Shanghai 一起解决。
        int dailyLimit = analyticsService.maxPublishPerDay();
        if (dailyLimit > 0) {
            Long todayCount = goodsMapper.selectCount(new LambdaQueryWrapper<Goods>()
                    .eq(Goods::getSellerId, sellerId)
                    .ge(Goods::getCreateTime, LocalDate.now().atStartOfDay()));
            if (todayCount != null && todayCount >= dailyLimit) {
                throw BusinessException.of("今天最多发布 " + dailyLimit + " 件商品，请明天再来");
            }
        }
        // ★ 入参边界必须在落库前一次性收紧 ★
        // 原先这里没有任何校验，数据库约束（NOT NULL / varchar 长度 / decimal 精度）
        // 成了唯一的「校验器」：标题为空、价格为空、标题或交易地点超长、价格超出
        // decimal(10,2) 上限，全都会以 SQLException 冒到全局兜底分支，
        // 前端只看到「服务器内部错误，请稍后再试」，用户无从知道该改哪个字段。
        // 交给下面这个方法后，同样的输入会得到 1001 + 具体字段提示。
        validatePublishPayload(goods);

        goods.setSellerId(sellerId);
        goods.setSellerName(seller.getNickname());
        goods.setSellerAvatar(seller.getAvatar());
        goods.setStatus("pending"); // 新发布商品默认进入审核
        goods.setViewCount(0);
        goods.setFavoriteCount(0);
        goods.setCreateTime(LocalDateTime.now());
        goods.setUpdateTime(LocalDateTime.now());
        // 数量 / 交易方式的默认值统一在 validatePublishPayload 里落地，这里不再重复
        applyPromoPricing(goods);
        goodsMapper.insert(goods);
        addAuditLog("goods.publish", "发布商品", "商品 #" + goods.getId(), goods.getTitle()
                + (goods.getPromoPrice() != null
                ? "｜报名活动 " + goods.getActivityId() + "，让利价 ¥" + goods.getPromoPrice()
                : ""));
        return goods;
    }

    /**
     * 发布商品的入参校验（含默认值落地）
     * <p>
     * ★ 为什么校验放在 Service 而不是 Controller ★
     * <p>
     * {@code POST /goods} 的入参是 {@code @RequestBody Goods}，任何登录用户都能直接
     * 构造请求体绕过页面表单 —— 前端 Element Plus 的 {@code required} / {@code maxlength}
     * 只是体验层，挡不住 curl。校验必须落在能把住数据库的那一层。
     * <p>
     * ★ 错误码为什么是 1001 而不是 500 ★
     * <p>
     * 这些输入的共同点是「调用方喂了非法值」，属于**业务拒绝**而非服务端故障。
     * 按项目错误码约定走 {@code paramError}（1001），500 只留给
     * {@code GlobalExceptionHandler} 的真兜底，否则监控里会堆满假故障。
     * <p>
     * ★ 顺带修掉的两个口径问题 ★
     * <ol>
     *   <li><b>分类名改由服务端回填</b>：原先直接用请求体里的 {@code categoryName} 落库，
     *       客户端能把分类 1（教材）的商品标成任意名字。分类名属于
     *       「必须由服务端权威决定」的展示字段，与让利价同一性质。</li>
     *   <li><b>分类必须真实存在</b>：原先 {@code categoryId} 可以缺失或传不存在的 id，
     *       商品会以 null / 幽灵分类落库 —— 列表按分类筛选时它谁都筛不出来。</li>
     * </ol>
     */
    private void validatePublishPayload(Goods goods) {
        // ---- 标题：必填、去空白后非空、不超列宽 ----
        String title = goods.getTitle() == null ? "" : goods.getTitle().trim();
        if (title.isEmpty()) {
            throw BusinessException.paramError("请填写商品标题");
        }
        if (title.length() > MAX_TITLE) {
            throw BusinessException.paramError("商品标题不能超过 " + MAX_TITLE + " 个字");
        }
        goods.setTitle(title);

        // ---- 价格：必填、大于 0、不超 decimal(10,2) 上限 ----
        BigDecimal price = goods.getPrice();
        if (price == null) {
            throw BusinessException.paramError("请填写商品价格");
        }
        if (price.signum() <= 0) {
            throw BusinessException.paramError("商品价格必须大于 0 元");
        }
        if (price.compareTo(MAX_PRICE) > 0) {
            throw BusinessException.paramError("商品价格不能超过 " + MAX_PRICE.toPlainString() + " 元");
        }

        // ---- 数量：缺省 1；给了就必须在合理区间 ----
        Integer stock = goods.getStock();
        if (stock == null || stock <= 0) {
            goods.setStock(1);
        } else if (stock > MAX_STOCK) {
            throw BusinessException.paramError("商品数量不能超过 " + MAX_STOCK + " 件");
        }

        // ---- 分类：必填、必须存在、名称由服务端回填 ----
        if (goods.getCategoryId() == null) {
            throw BusinessException.paramError("请选择商品分类");
        }
        Category category = categoryMapper.selectById(goods.getCategoryId());
        if (category == null) {
            throw BusinessException.paramError("商品分类不存在，请重新选择");
        }
        goods.setCategoryName(category.getName());

        // ---- 交易地点：可空，但不超列宽 ----
        String location = goods.getLocation() == null ? "" : goods.getLocation().trim();
        if (location.length() > MAX_LOCATION) {
            throw BusinessException.paramError("交易地点不能超过 " + MAX_LOCATION + " 个字");
        }
        goods.setLocation(location.isEmpty() ? null : location);

        // ---- 描述：可空，但不超合理长度 ----
        String description = goods.getDescription() == null ? "" : goods.getDescription().trim();
        if (description.length() > MAX_DESCRIPTION) {
            throw BusinessException.paramError("商品描述不能超过 " + MAX_DESCRIPTION + " 个字");
        }
        goods.setDescription(description);

        /*
         * ---- 封面：只接受上传接口返回的短路径 ----
         * 这一条同时是「base64 直塞」的护栏：若前端还按旧写法把图片编成
         * data URL 提交，会在这里被友好拒绝，而不是落库时抛
         * Data too long 变成 500「服务器内部错误」。
         */
        String cover = goods.getCover();
        if (cover != null && cover.length() > MAX_COVER) {
            throw BusinessException.paramError("封面图地址过长，请通过上传接口重新选择图片");
        }

        // ---- 图集：张数与单条长度 ----
        List<String> images = goods.getImages();
        if (images != null) {
            if (images.size() > MAX_IMAGES) {
                throw BusinessException.paramError("最多上传 " + MAX_IMAGES + " 张图片");
            }
            for (String url : images) {
                if (url != null && url.length() > MAX_IMAGE_URL) {
                    throw BusinessException.paramError("图片地址过长，请通过上传接口重新选择图片");
                }
            }
            goods.setImages(images.stream()
                    .filter(u -> u != null && !u.isBlank())
                    .toList());
        }

        // ---- 交易方式：白名单，防「幽灵状态」 ----
        String delivery = goods.getDeliveryMethod();
        if (delivery == null || delivery.isBlank()) {
            goods.setDeliveryMethod("face");
        } else if (!DELIVERY_METHODS.contains(delivery)) {
            throw BusinessException.paramError("交易方式只能是：面交 / 快递 / 自提");
        }
    }

    /**
     * 让利价改由**服务端**按活动声明计算（收款口径的最后一道闸门）。
     * <p>
     * ★ 为什么必须在这里重算，而不是相信请求体 ★
     * <p>
     * 本方法的入参是 {@code @RequestBody Goods}，即客户端能直接写 {@code price}、
     * {@code promoPrice}、{@code activityId} 三个字段。若原样落库，
     * 任何登录用户都能 POST 一个 {@code {"price": 999, "promoPrice": 1}} ——
     * 平台从没答应过这个折扣，商品却挂着「让利」标签卖出去，
     * 而订单快照里卖家实收会直接变成 1 元。
     * <p>
     * 规则与前端 `settleJoin()` 完全一致（同一套阶梯与取整），
     * 保证「发布页预览的价格」与「落库的价格」不会出现两个值：
     * <ol>
     *   <li>先把请求体里的 {@code promoPrice} / {@code activityId} 全部丢弃；</li>
     *   <li>只有卖家**确实报名了某条进行中的活动**、且该活动声明覆盖了这件商品的分类，
     *       才按声明折扣率算出让利价；</li>
     *   <li>算出的价不低于挂牌价时视为「未参与」（不写 promoPrice，也不挂 activityId），
     *       与前端 `settlePrice()` 的 `onPromo` 判定同口径。</li>
     * </ol>
     * ★ 活动不可用时**静默按挂牌价落库**，这条不是遗漏 ★
     * <p>
     * 卖家从打开发布页到点提交之间，后台完全可能把活动下架或让它自然到期。
     * 此时抛错会让整次发布失败（草稿内容全丢），而商品本来按挂牌价也是可以卖的 ——
     * 所以这里按原价落库，并把「没有 promoPrice」这个结果如实返回，
     * 由前端提示「《XXX》已结束，本次按挂牌价提交」（见 {@code Publish.vue} 的三分支）。
     * **代价是卖家不能靠这个接口自己给自己打折**：折扣只可能来自活动声明。
     */
    private void applyPromoPricing(Goods goods) {
        String wanted = goods.getActivityId();
        // 无论客户端传了什么，先清空 —— 这两个字段只能由下面的规则重新赋值
        goods.setPromoPrice(null);
        goods.setActivityId(null);
        if (wanted == null || wanted.isBlank()) return;

        BigDecimal price = goods.getPrice();
        if (price == null || price.signum() <= 0) return;

        Activity claim = activityService.claimActivity(wanted, goods.getCategoryId(), true);
        if (claim == null) return;
        Double rate = activityService.rateOf(claim, goods.getCategoryId());
        if (rate == null) return;
        BigDecimal promo = PromoPricing.promoPriceFor(price, PromoPricing.rateFor(price, rate));
        if (promo.compareTo(price) < 0) {
            goods.setPromoPrice(promo);
            goods.setActivityId(claim.getId());
        }
    }

    /** 后台角色：可绕过归属校验，操作任意商品 */
    private static final List<String> ADMIN_ROLES = List.of("admin", "goods_admin");

    /**
     * 可查看**任意状态**商品详情的后台角色。
     * <p>
     * 刻意比 {@link #ADMIN_ROLES} 多一个 {@code report_admin}：
     * 审核台与举报台都需要打开「未上架 / 已下架」商品的详情才能履职
     * （前端 {@code ReportsPanel.vue} 就是用 {@code fetchGoodsDetail} 拉举报目标商品的），
     * 但举报管理员**不该**因此获得改状态 / 删商品的权限 —— 那是 {@code ADMIN_ROLES} 的事，
     * 两者语义不同，不要合并。
     */
    private static final List<String> DETAIL_PRIVILEGED_ROLES = List.of("admin", "goods_admin", "report_admin");

    /**
     * 切换上下架（唯一入口）
     *
     * @param operatorId 操作者 id（卖家侧必传）
     * @param role       操作者角色；admin / goods_admin 视为后台操作，可操作任意商品
     *                   <p>
     *                   ★ 这个方法补的是 GoodsController 的一个越权洞 ★：
     *                   {@code PATCH /goods/{id}/status} 原先调的是不带 operatorId 的重载，
     *                   归属校验形同虚设 —— 任何登录用户改一个 id 就能下架别人的在售商品。
     *                   <p>
     *                   ★ L8（2026-09-22）：那个「不带 operatorId」的重载已**删除** ★
     *                   留着它等于留一把上了膛的枪：谁不小心从 Controller 调过去，
     *                   归属校验就静默失效。判据与处理见 {@link #requireOwner}。
     */
    @Transactional
    public void updateGoodsStatus(Long id, String status, Long operatorId, String role) {
        Goods g = goodsMapper.selectById(id);
        if (g == null) throw BusinessException.notFound("商品不存在");
        requireOwner(g, operatorId, role);
        // ★ 先过白名单再谈其他规则 ★
        // 这一步不能省：后面所有判断都建立在 status 是个合法值的前提上，
        // 少了它，任意字符串都会直接落库（实测 teleport 能写进去）。
        Validators.oneOf(status, GOODS_STATUSES, "商品状态");
        if ("on_sale".equals(status) && "pending".equals(g.getStatus())) {
            throw BusinessException.of("商品还在审核中，通过审核后才可以上架");
        }
        if (status.equals(g.getStatus())) {
            // 状态没变就不写库、不留痕：否则重复点「下架」会刷出一串无意义审计记录
            return;
        }
        // ★ 只 SET「状态 + 更新时间」两列，不整实体回写 ★
        // 与详情页浏览量是同一条病根：上面 selectById 读到的是**快照**，
        // 若把它整行写回，「卖家下架」与「买家下最后一单」并发时，
        // 刚被 `stock = stock - qty` 扣掉的库存会被还原成下架前的旧值。
        LocalDateTime now = LocalDateTime.now();
        goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                .eq(Goods::getId, id)
                .set(Goods::getStatus, status)
                .set(Goods::getUpdateTime, now));
        g.setStatus(status);
        g.setUpdateTime(now);
        addAuditLog("goods.status", "修改商品状态", "商品 #" + g.getId(),
                g.getTitle() + " → " + status);
    }

    /** 兼容重载：只给 operatorId，按卖家归属校验（卖家侧 {@code /user/goods/{id}/status} 用） */
    @Transactional
    public void updateGoodsStatus(Long id, String status, Long operatorId) {
        updateGoodsStatus(id, status, operatorId, null);
    }

    /**
     * 删除商品（唯一入口）
     *
     * @param operatorId 操作者 id（卖家侧必传）
     * @param role       操作者角色；admin / goods_admin 视为后台操作，可删除任意商品
     *                   <p>
     *                   ★ L8（2026-09-22）：同样删掉了「不带 operatorId」的那个重载 ★
     *                   理由与 {@link #updateGoodsStatus} 一致 —— 它只能用来传 null，
     *                   也就是只能用来绕过归属校验。
     */
    @Transactional
    public void deleteGoods(Long id, Long operatorId, String role) {
        Goods g = goodsMapper.selectById(id);
        if (g == null) return;
        requireOwner(g, operatorId, role);
        goodsMapper.deleteById(id);
        /*
         * 连带清理所有「挂在 goods_id 上、但商品已经不在」的从属数据。
         * 原先只清了收藏与足迹，留言（t_comment）和评价（t_review）**原样留着** ——
         * 个人中心的「我的评价」会继续展示一条指向已删除商品的记录，点进去 404；
         * 更麻烦的是它们会被同分类的其它商品查询按 goods_id 串到，造成「评价串号」。
         * 判据很简单：这张表的主语是「某件商品」，主语没了，从属行就没有意义。
         */
        favoriteMapper.delete(new LambdaQueryWrapper<Favorite>().eq(Favorite::getGoodsId, id));
        historyMapper.delete(new LambdaQueryWrapper<History>().eq(History::getGoodsId, id));
        commentMapper.delete(new LambdaQueryWrapper<Comment>().eq(Comment::getGoodsId, id));
        reviewMapper.delete(new LambdaQueryWrapper<Review>().eq(Review::getGoodsId, id));
        addAuditLog("goods.delete", "删除商品", "商品 #" + id, g.getTitle());
    }

    /** 兼容重载：只给 operatorId，按卖家归属校验（卖家侧 {@code DELETE /user/goods/{id}} 用） */
    @Transactional
    public void deleteGoods(Long id, Long operatorId) {
        deleteGoods(id, operatorId, null);
    }

    /**
     * 归属校验：后台角色直接放行，否则必须是商品卖家本人。
     * <p>
     * ★ L8（2026-09-22）：{@code operatorId == null} 由「静默放行」改为「失败关闭」★
     * <p>
     * 原先这里是 {@code if (operatorId == null) return;}，理由写在注释里 ——
     * 「只保留给系统内部联动（如审核通过时改状态）」。复核后发现这条理由**根本不成立**：
     * <ul>
     *   <li>商品审核改状态走的是 {@code GoodsAuditService} 内的
     *       {@code goodsMapper.update(null, new LambdaUpdateWrapper<Goods>().set(Goods::getStatus, ...))}，
     *       压根不经过本类；</li>
     *   <li>全仓 grep {@code .updateGoodsStatus(} / {@code .deleteGoods(}，调用点只有 4 处
     *       Controller，且**每一处都传了 non-null 的 {@code currentUserId(request)}**。</li>
     * </ul>
     * 也就是说这条旁路在生产代码里**零调用者**，全仓唯一一次 {@code (id, null, null)}
     * 是单测图省事写的（已改为传真实卖家 id）。
     * <p>
     * 它为什么危险：安全性完全押在一条**注释约定**上，运行时没有任何东西保证它。
     * {@code currentUserId()} 是裸强转 {@code (Long) request.getAttribute(ATTR_USER_ID)} ——
     * 一旦拦截器改了属性名、或将来有人把这两个接口加进公开白名单，拿到的就是 null。
     * 那一刻「任何人删任何人的商品 / 下架任何人的在售商品」会**静默成立**：
     * 不报错、不留日志，归属校验凭空消失，跑一遍探针还是全绿（因为探针都带 token）。
     * <p>
     * 所以改成失败关闭：认不出操作者就拒绝。若将来系统内部确实需要绕过归属校验，
     * 请**新加一个名字里带 {@code AsSystem} 的显式入口**（让「这里故意不校验归属」
     * 在调用点一眼可见），不要再开 null 后门。
     */
    private void requireOwner(Goods g, Long operatorId, String role) {
        if (role != null && ADMIN_ROLES.contains(role)) return;
        if (operatorId == null) {
            // 失败关闭。用 403 而不是 404/1001：这不是「商品不存在」也不是「参数不合法」，
            // 而是「没认出你是谁」的鉴权问题 —— 与下面那条越权拒绝同类。
            throw BusinessException.forbidden("无法确认操作者身份，已拒绝该操作");
        }
        if (!operatorId.equals(g.getSellerId())) {
            throw BusinessException.forbidden("只能操作自己发布的商品");
        }
    }

    /**
     * 批量修改商品状态
     * <p>
     * ★ 这个方法补的是「批量上架绕过审核」的洞 ★
     * <p>
     * 入口有两道校验，顺序与单条通道 {@link #updateGoodsStatus(Long, String, Long, String)} 对齐：
     * <ol>
     *   <li><b>状态白名单</b>：{@code status} 不在 {@link #GOODS_STATUSES} 里直接抛 1001，
     *       防止像 {@code teleport} 这种幽灵值落库（单条通道已修，批量通道漏了这道）。</li>
     *   <li><b>不许批量绕过审核</b>：当目标是 {@code on_sale} 时，先 {@code selectBatchIds} 把这批商品的
     *       当前状态拉出来，<b>只要有一件是 {@code pending} 就整体拒绝（抛 1001），不静默跳过、也不部分成功</b>。
     *       理由：本方法带 {@code @Transactional}，批量操作必须「要么全做、要么不做」；
     *       静默跳过待审核商品会让管理员误以为都成功了，而把待审商品直接上架等于卖家自我审核，
     *       正是单条通道 477 行那条挡板要拦的行为。要上架待审商品，必须去「商品审核」页逐件通过。</li>
     * </ol>
     * 其它目标状态（{@code off_shelf} / {@code sold}）不加第 ② 条限制 —— 把待审核商品批量下架是正当处置。
     * <p>
     * 审计日志始终记录**真正更新的 id**（正常路径下等于入参 {@code ids}），返回值语义（更新条数）不变。
     *
     * @param ids    商品 id 列表
     * @param status 目标状态，必须在 {@link #GOODS_STATUSES} 内
     */
    @Transactional
    public int batchUpdateStatus(List<Long> ids, String status) {
        if (ids == null || ids.isEmpty()) return 0;
        // ① 先过白名单：后面所有判断都建立在 status 合法的前提上（与单条通道 476 行对齐）
        Validators.oneOf(status, GOODS_STATUSES, "商品状态");
        // ② 批量上架不允许绕过审核：拉出当前状态，含 pending 则整体拒绝
        if ("on_sale".equals(status)) {
            List<Goods> targets = goodsMapper.selectBatchIds(ids);
            long pendingCount = targets.stream()
                    .filter(g -> "pending".equals(g.getStatus()))
                    .count();
            if (pendingCount > 0) {
                throw BusinessException.of("选中的商品中有 " + pendingCount
                        + " 件还在审核中，请先到「商品审核」页通过审核，或取消勾选后再批量上架");
            }
        }
        goodsMapper.batchUpdateStatus(ids, status);
        addAuditLog("goods.batchStatus", "批量修改商品状态",
                ids.size() + " 件商品", "ID：" + ids);
        return ids.size();
    }

    /** 批量删除商品 */
    @Transactional
    public int batchDeleteGoods(List<Long> ids) {
        if (ids == null || ids.isEmpty()) return 0;
        List<Goods> targets = goodsMapper.selectBatchIds(ids);
        if (targets.isEmpty()) return 0;
        goodsMapper.deleteBatchIds(ids);
        // 与单条通道 deleteGoods 保持同一套连带清理口径（批量通道漏一处 = 漏一片）
        favoriteMapper.delete(new LambdaQueryWrapper<Favorite>().in(Favorite::getGoodsId, ids));
        historyMapper.delete(new LambdaQueryWrapper<History>().in(History::getGoodsId, ids));
        commentMapper.delete(new LambdaQueryWrapper<Comment>().in(Comment::getGoodsId, ids));
        reviewMapper.delete(new LambdaQueryWrapper<Review>().in(Review::getGoodsId, ids));
        addAuditLog("goods.batchDelete", "批量删除商品",
                targets.size() + " 件商品", "ID：" + ids);
        return targets.size();
    }

    // ==================== 分类管理 ====================

    public List<Category> fetchCategories() {
        return categoryMapper.selectList(new LambdaQueryWrapper<Category>().orderByAsc(Category::getId));
    }

    public List<Map<String, Object>> fetchCategoryStats() {
        return categoryMapper.selectCategoryStats();
    }

    /** 与 schema.sql 严格一致：t_category.name varchar(50) / t_category.icon varchar(20) */
    private static final int CATEGORY_NAME_MAX = 50;
    private static final int CATEGORY_ICON_MAX = 20;

    @Transactional
    public Category createCategory(String name, String icon) {
        // ★ 分类名 / 图标都是窄列，落库前必须量长度 ★
        // 超长会撞 MySQL 严格模式抛 Data too long → 分类管理页弹「服务器内部错误」，
        // 管理员完全看不出是「名字写太长」还是「后端挂了」
        String safeName = Validators.required(name, CATEGORY_NAME_MAX, "分类名称");
        String safeIcon = Validators.optional(icon, CATEGORY_ICON_MAX, "分类图标");
        long count = categoryMapper.selectCount(
                new LambdaQueryWrapper<Category>().eq(Category::getName, safeName));
        if (count > 0) throw BusinessException.of("该分类名称已存在");
        Category c = new Category();
        c.setName(safeName);
        c.setIcon(safeIcon != null && !safeIcon.isBlank() ? safeIcon : "📦");
        c.setCreateTime(LocalDateTime.now());
        /*
         * ★ 上面的 count 预检挡不住并发 ★
         * 两个请求同时通过 count 检查就会各插一条同名分类（check-then-act）。
         * 真正的防线是 t_category 上的唯一索引 uk_category_name（见 schema.sql）——
         * 这里把它触发的 DuplicateKeyException 翻成与预检**同一句话**的业务异常，
         * 这样「重名」无论走哪条路径，用户看到的提示都是一致的、也不会变成 500。
         */
        try {
            categoryMapper.insert(c);
        } catch (DuplicateKeyException e) {
            throw BusinessException.of("该分类名称已存在");
        }
        addAuditLog("category.create", "新增分类", "分类「" + c.getName() + "」", "ID " + c.getId());
        return c;
    }

    @Transactional
    public Category updateCategory(Long id, String name, String icon) {
        Category c = categoryMapper.selectById(id);
        if (c == null) throw BusinessException.notFound("分类不存在");
        String before = c.getName();
        if (name != null && !name.isBlank()) {
            String safeName = Validators.required(name, CATEGORY_NAME_MAX, "分类名称");
            long count = categoryMapper.selectCount(
                    new LambdaQueryWrapper<Category>()
                            .eq(Category::getName, safeName)
                            .ne(Category::getId, id));
            if (count > 0) throw BusinessException.of("该分类名称已存在");
            c.setName(safeName);
        }
        if (icon != null && !icon.isBlank()) c.setIcon(Validators.required(icon, CATEGORY_ICON_MAX, "分类图标"));
        categoryMapper.updateById(c);

        /*
         * ★ 分类名是**冗余**在商品上的（t_goods.category_name）—— 商品列表直接读这一列，
         * 不走 join。改名后不同步的话，商品广场/后台列表里的分类名会一直显示旧名，
         * 看起来像「改了没生效」，而实际上分类字典已经改好了。
         * 一条 UPDATE 全量同步，避免逐件商品 update 造成 N 次写库。
         */
        boolean renamed = name != null && !name.isBlank() && !name.equals(before);
        if (renamed) {
            goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                    .eq(Goods::getCategoryId, id)
                    .set(Goods::getCategoryName, name));
        }

        addAuditLog("category.update", "编辑分类", "分类「" + c.getName() + "」",
                renamed ? "名称：" + before + " → " + name : "更新图标");
        return c;
    }

    @Transactional
    public Map<String, Object> deleteCategory(Long id) {
        Category c = categoryMapper.selectById(id);
        if (c == null) return Map.of("ok", false, "reason", "分类不存在");
        int count = goodsMapper.countByCategory(id);
        if (count > 0) {
            return Map.of("ok", false, "reason", "该分类下还有 " + count + " 件商品，请先转移或删除商品后再删除分类");
        }
        categoryMapper.deleteById(id);
        addAuditLog("category.delete", "删除分类", "分类「" + c.getName() + "」", "ID " + id);
        return Map.of("ok", true);
    }

    private void addAuditLog(String action, String label, String target, String detail) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        // 操作人从请求上下文取：卖家发布 / 删除、管理员批量操作要各归各名，不能一律记 admin
        log.setOperator(OperatorContext.currentOperator());
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }
}
