package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.common.InstanceSeqGenerator;
import com.campus.market.common.OperatorContext;
import com.campus.market.common.PromoPricing;
import com.campus.market.common.Validators;
import com.campus.market.dto.OrderStatusStat;
import com.campus.market.entity.*;
import com.campus.market.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 订单业务逻辑层
 * <p>
 * ─────────────────────────────────────────────────────────────────────
 * 订单状态机（ORDER_TRANSITIONS）：每个状态只允许流向后续状态
 *   pending_payment → pending_ship / cancelled
 *   pending_ship    → shipped / cancelled / refunding
 *   shipped         → received / cancelled / refunding
 *   received        → completed / refunding
 *   completed       → （终态，无出口）
 *   refunding       → cancelled（同意退款）/ **退回进入售后前的状态**（驳回退款，见 rejectRefund）
 *   cancelled       → （终态，无出口）
 * <p>
 * ★ 唯一一条「逆流」边是「驳回退款」：撤销售后单要回到申请前的状态
 *   （pending_ship / shipped / received），它记在 t_order_log 的 from_status 里。
 *   表里的 refunding → cancelled 是顺流（同意退款并关单），两者不要混淆。
 * ─────────────────────────────────────────────────────────────────────
 * <p>
 * ★ 事务设计：创建订单（扣库存 + 生成订单 + 记日志）必须在同一事务中完成，
 *   否则可能出现「下单成功但库存未扣」或「扣了库存但订单未生成」的脏数据。
 */
@Service
@RequiredArgsConstructor
public class OrderService {

    /**
     * 日志文案一律用 ASCII。
     * <p>
     * Windows 下 JVM 按 GBK 写标准输出管道，中文会变成乱码，运维侧 grep 不出东西 ——
     * 排查时最需要的那一行反而读不到。用英文 + key=value 形式，机器可读、可检索。
     */
    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderMapper orderMapper;
    private final GoodsMapper goodsMapper;
    private final OrderLogMapper orderLogMapper;
    private final UserMapper userMapper;
    private final AuditLogMapper auditLogMapper;
    /** 订单价格快照里的「让利资金归属」由活动声明决定，不能硬编码 */
    private final ActivityService activityService;

    /** 订单状态机 */
    private static final Map<String, List<String>> TRANSITIONS = Map.of(
            "pending_payment", List.of("pending_ship", "cancelled"),
            "pending_ship", List.of("shipped", "cancelled", "refunding"),
            "shipped", List.of("received", "cancelled", "refunding"),
            "received", List.of("completed", "refunding"),
            "completed", List.of(),
            "refunding", List.of("cancelled"),
            "cancelled", List.of()
    );

    /** 可退款状态 */
    private static final List<String> REFUNDABLE = List.of("pending_ship", "shipped", "received", "refunding");

    /** 全部订单状态（前端 `AdminOrderStats.byStatus` 要求 7 个键一个不少） */
    private static final List<String> ALL_STATUSES = List.of(
            "pending_payment", "pending_ship", "shipped", "received", "completed", "refunding", "cancelled");

    /**
     * 订单工作台概览卡的分组 —— 与前端 `api/order.ts` 的 ORDER_OVERVIEW_GROUPS **逐字对齐**。
     * <p>
     * 卡片上的数字与点进去筛出的条数必须一致：分组白名单同时也下发给前端，
     * 由它拿去筛列表（`statusIn`），所以这边不能自行增删分组或多算一个状态。
     */
    private static final List<Map<String, Object>> OVERVIEW_GROUPS = List.of(
            group("todo_pay", "待付款", "warn", List.of("pending_payment")),
            group("todo_ship", "待发货", "primary", List.of("pending_ship")),
            group("shipping", "已发货", "primary", List.of("shipped")),
            group("received", "已收货", "success", List.of("received")),
            group("done", "已完成", "success", List.of("completed")),
            group("after", "售后中", "danger", List.of("refunding", "cancelled")));

    /** 需要人工介入的状态（前端 ORDER_TODO_STATUS 同口径） */
    private static final List<String> TODO_STATUS = List.of("pending_payment", "pending_ship", "refunding");

    /** 计入成交额的状态（前端 ORDER_PAID_STATUS 同口径） */
    private static final List<String> PAID_STATUS =
            List.of("pending_ship", "shipped", "received", "completed");

    private static Map<String, Object> group(String key, String label, String tone, List<String> statuses) {
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("key", key);
        g.put("label", label);
        g.put("tone", tone);
        g.put("statuses", statuses);
        return g;
    }

    /**
     * 订单号发号器：17 位时间戳 ＋ 1 位实例号 ＋ 2 位毫秒内序号 = 20 位。
     * <p>
     * ★ L10（2026-09-22）★ 状态机原本写在本类里，与 {@code ActivityService.ID_SEQ}
     * 是**同族却两份实现** —— L5 重写了这里，活动那边没被扫到，仍是
     * {@code static AtomicLong} 自增（多实例各从 0 起 ⇒ 撞号）。
     * 现在两边共用 {@link InstanceSeqGenerator}，
     * 「改一处必查另一处」从靠纪律变成**靠结构**：发号逻辑只有一份。
     */
    private final InstanceSeqGenerator orderIds = new InstanceSeqGenerator(2);

    /**
     * 实例号：把订单号的序号段按实例切开，避免多实例部署时跨 JVM 撞号。
     * <p>
     * ★ L5（2026-09-22）★ 单实例部署保持默认 {@code 0} 即可；横向扩到 N 个实例时，
     * 给每个实例配一个不同的 {@code app.instance-id}（取值 0..9）。
     * <p>
     * 为什么是**字段注入**，而不像 {@code LoginAttemptGuard} 那样写进构造器参数：
     * 本类是 Lombok {@code @RequiredArgsConstructor}，往构造器里加参数就是改它生成的签名，
     * 全仓每个 {@code new OrderService(mocks...)} 的单测都得跟着补参。为一个可选配置付这个代价不值得。
     * 字段注入不进 Lombok 生成的构造器，所以单测里自然拿到默认 0 —— 语义正好是「单实例」。
     */
    @Value("${app.instance-id:0}")
    private int instanceId;

    /**
     * 订单支付时限（分钟），下单时用于算 {@code pay_expire_at}。
     * <p>
     * ★ 与 {@link #instanceId} 同样用**字段注入** ★
     * 本类是 Lombok {@code @RequiredArgsConstructor}，往构造器里加参数就是改它生成的签名，
     * 全仓 6 个 {@code new OrderService(...)} 的单测都得跟着补参。
     * 为一个带默认值的配置项付这个代价不值得 —— 字段注入不进 Lombok 生成的构造器，
     * 单测里自然拿到默认值 1440，语义正好是「生产默认的 24 小时」。
     * <p>
     * ★ 键名与 {@link com.campus.market.config.PayProperties} 保持同一个 ★
     * 本项目吃过「一个概念两个名字 = 两个开关」的亏：同一个超时若在这里读
     * {@code app.pay.timeout}、在那里读 {@code app.pay.order-timeout-minutes}，
     * 就会出现「改了收银台倒计时变了、关单时间没变」这种自相矛盾。
     * 这里刻意复用同一个键，两处口径不可能分叉。
     */
    @Value("${app.pay.order-timeout-minutes:1440}")
    private int payTimeoutMinutes;

    /**
     * 「后台内部备注」这一动作的机器名。
     * <p>
     * 它与其余动作（create / pay / ship / receive / complete / cancel / refund / adjust）
     * 的区别是**受众不同**：其余是履约留痕，买卖双方都该看到；只有它是管理员写给管理员看的，
     * 且 {@code note} 列里存的就是备注原文。所以它是唯一一个不能下发给非管理员的动作。
     */
    private static final String LOG_ACTION_ADMIN_NOTE = "note";

    /**
     * 订单状态 → 中文（与前端 `ORDER_STATUS_LABEL` 同口径）。
     * <p>
     * 报错文案不能把状态码直接抛给用户：一句
     * 「非法流转：订单当前「pending_payment」」在界面上是纯噪音，
     * 用户既看不懂也不知道该做什么。批量处置的「跳过原因」同理 ——
     * 那些文案是要原样显示给管理员看的。
     */
    private static final Map<String, String> STATUS_LABEL = Map.of(
            "pending_payment", "待付款",
            "pending_ship", "待发货",
            "shipped", "已发货",
            "received", "已收货",
            "completed", "已完成",
            "refunding", "退款中",
            "cancelled", "已取消");

    /** 状态码 → 中文标签（未知状态原样返回，不吞掉信息） */
    public static String labelOf(String status) {
        return status == null ? "" : STATUS_LABEL.getOrDefault(status, status);
    }

    // ==================== 买/卖家订单 ====================

    public IPage<Order> fetchOrders(Long userId, int page, int pageSize, String status, String role) {
        return orderMapper.selectUserOrders(new Page<>(page, pageSize), userId, status, role);
    }

    // ==================== 下单（事务） ====================

    /**
     * 创建订单 —— ★ 事务程序 ★
     * <p>
     * 三条底线：
     *  ① 只在售商品可下单（pending / off_shelf / sold 不允许）
     *  ② 数量不得超过可售数量
     *  ③ 价格快照固化（活动结束后卖家改价不影响已成交的这单）
     * <p>
     * 事务内完成：查商品 → 校验 → 扣库存 → 建订单 → 记日志
     */
    @Transactional
    public Order createOrder(Long buyerId, Long goodsId, Integer quantity, String remark, String address) {
        // 1. 查商品
        Goods goods = goodsMapper.selectById(goodsId);
        if (goods == null) throw BusinessException.notFound("商品不存在或已被删除");
        if ("pending".equals(goods.getStatus())) throw BusinessException.of("商品正在审核中，暂时无法购买");
        if (!"on_sale".equals(goods.getStatus())) throw BusinessException.of("商品已" + goods.getStatus() + "，无法购买");
        // 自购闸门：买家与卖家是同一人时，订单的 buyerId / sellerId 会重合，
        // 「买家确认收货」「卖家发货」两套越权判定同时成立，且同一件商品自买自卖
        // 会把 GMV 直接刷上去。前端商品详情页并没有藏掉自己的「立即购买」，所以这里必须拦。
        if (buyerId != null && buyerId.equals(goods.getSellerId())) {
            throw BusinessException.of("不能购买自己发布的商品");
        }

        int qty = Math.max(1, quantity != null ? quantity : 1);
        int stock = goods.getStock() != null ? goods.getStock() : 1;
        if (qty > stock) throw BusinessException.of("库存不足，该商品当前仅剩 " + stock + " 件");

        // 2. 生成订单号（同一毫秒内也不撞号，见 generateOrderId）
        String orderId = generateOrderId();
        User buyer = userMapper.selectById(buyerId);

        // 3. 价格快照
        //
        // ★ 资金归属必须由活动规则解析，不能想当然写成 seller ★
        //
        // 这里原来是 `platformSubsidy = 0` + `fundSource = "seller"` 硬编码的，等于
        // 「所有让利都算卖家自己掏的」。后果有两层：
        //   ① 卖家实收被凭空扣掉平台本该补的那部分（本该 sellerIncome = 挂牌价）；
        //   ② 后台看板的 platformSubsidyTotal 是用订单快照算的（见 AnalyticsService），
        //      于是「平台补贴」这个数字**恒为 0** —— 平台真金白银贴出去多少，账上永远看不出来。
        // 现在统一走 ActivityService.fundSourceFor()：优先认商品自己的 activityId，
        // 解析不到就保守回落 seller（**不回退按分类反查** —— 那会命中同分类下
        // 另一条 fundSource 相反的活动，把卖家让利错记成平台补贴），与前端结算口径同源。
        String fundSource = activityService.fundSourceFor(goods.getActivityId(), goods.getCategoryId());
        BigDecimal listPrice = goods.getPrice();
        PromoPricing.Settlement settlement = PromoPricing.settle(listPrice, goods.getPromoPrice(), fundSource);
        BigDecimal payAmount = settlement.payAmount();
        BigDecimal sellerCut = settlement.sellerCut();
        BigDecimal platformSubsidy = settlement.platformSubsidy();
        BigDecimal sellerIncome = settlement.sellerIncome();

        Order order = new Order();
        order.setId(orderId);
        order.setStatus("pending_payment");
        order.setGoodsId(goodsId);
        order.setGoodsTitle(goods.getTitle());
        order.setGoodsCover(goods.getCover());
        order.setGoodsPrice(goods.getPrice());
        order.setGoodsPromoPrice(goods.getPromoPrice());
        order.setBuyerId(buyerId);
        order.setBuyerName(buyer != null ? buyer.getNickname() : null);
        order.setSellerId(goods.getSellerId());
        order.setSellerName(goods.getSellerName());
        BigDecimal totalList = listPrice.multiply(BigDecimal.valueOf(qty));
        /*
         * ★ 金额必须落在 decimal(10,2) 里 ★
         * 挂牌价上限 MAX_PRICE=99999999.99、库存上限 9999，两者相乘轻易越界，
         * 越界在 STRICT_TRANS_TABLES 下是硬报错 → 整个事务回滚 → 500。
         * 由于 sellerCut + platformSubsidy + payAmount == listPrice，
         * 各项单件金额都不超过挂牌价，所以只校验「挂牌价 × 数量」这一个最大值，
         * 就已经覆盖了 amount / list_price / seller_cut / platform_subsidy / seller_income 五列。
         */
        if (totalList.compareTo(AMOUNT_MAX) > 0) {
            throw BusinessException.paramError("订单金额 ¥" + totalList.toPlainString()
                    + " 超出单笔上限 ¥" + AMOUNT_MAX.toPlainString() + "，请减少购买数量");
        }
        order.setAmount(payAmount.multiply(BigDecimal.valueOf(qty)));
        order.setListPrice(totalList);
        order.setSellerCut(sellerCut.multiply(BigDecimal.valueOf(qty)));
        order.setPlatformSubsidy(platformSubsidy.multiply(BigDecimal.valueOf(qty)));
        order.setSellerIncome(sellerIncome.multiply(BigDecimal.valueOf(qty)));
        order.setFundSource(fundSource);
        // 订单要记住「这一单属于哪次活动」：活动结束后卖家改价也不影响已成交的这单，
        // 事后对账（谁掏的钱、按哪条活动）要拿得出当时的依据。
        // 但只在活动**现在仍可解析**时才落这个 id：活动已被删除/下架却照抄商品上残留的
        // activityId，会留下「订单自称属于某次活动、后台却查不到任何活动记录」的孤儿账，
        // 既点不开也对不上 —— 比不记更糟。
        order.setActivityId(settlement.onPromo()
                ? activityService.resolvedActivityId(goods.getActivityId(), goods.getCategoryId())
                : null);
        order.setQuantity(qty);
        // 买家备注与收货地址都是 varchar(500)：超长会在 insert 那一刻抛 Data too long，
        // 整个下单事务回滚（连同刚扣掉的库存一起回滚），用户只看到「服务器内部错误」
        order.setRemark(Validators.optional(remark, NOTE_MAX, "买家备注"));
        /*
         * ★ 缺地址不能再用一句「校园内面交」静静兜住 ★
         *
         * 这里原来是一个三元表达式：传了就用，没传就写死「校园内面交」。
         * 单看这一行毫无问题，但它把**调用方的 bug 静默吞掉**了：
         * `Cart.vue` 的下单请求根本不带 address（只有 `Detail.vue` 带，且带的是硬编码常量），
         * 于是「从购物车结算」这条路径产出的订单，收货地址全是「校园内面交」——
         * 用户在结算页填的地址从未进过库，而后端一路 200、日志里一个字都没有。
         * 等卖家发出货、买家说没收到，才发现地址压根没保存。
         *
         * 现在按投递方式区分对待，而不是统一写死：
         *   - face / self（面交 / 自提）：本来就不需要收货地址，缺省文案是**正确**的，不打日志；
         *   - express（快递）：缺地址是真问题 —— 货款发出后没有任何收货信息可用。
         *     这里仍不阻断下单（避免把「历史上一路能下单」的行为突然变成故障），
         *     但必须留一条 WARN，让「选了快递却没传地址」在日志里当场可见。
         *
         * 为什么不改成抛 1001 直接拦住：前端两条下单路径有一条没传地址，
         * 现在改成报错等于**把购物车结算功能整体打挂**。留痕 + 由前端补齐传参（见 utils/address.ts）
         * 才是正确的修复顺序。
         */
        if (address != null) {
            order.setAddress(Validators.required(address, NOTE_MAX, "收货地址"));
        } else {
            order.setAddress("校园内面交");
            if ("express".equals(goods.getDeliveryMethod())) {
                log.warn("order created without address but deliveryMethod=express, "
                                + "goodsId={} buyerId={} orderId={}",
                        goodsId, buyerId, orderId);
            }
        }
        order.setCreateTime(LocalDateTime.now());
        /*
         * ★ 支付截止时间必须在下单这一刻算好并落库 ★
         *
         * 超时关单任务按这一列扫描。不落库、改成扫描时用 create_time 加偏移现场算的话，
         * 「改支付时限」会把**已经存在的**订单的截止时间一起改掉 ——
         * 昨天还差 1 小时的单子，今天改小配置就立刻"超时"了，
         * 判定口径随配置漂移，而对账时没人说得清当时的口径是什么。
         *
         * 值取 app.pay.order-timeout-minutes（默认 1440 = 24 小时），
         * 与前端 ORDER_SLA_HOURS.pending_payment = 24 同口径。
         */
        order.setPayExpireAt(order.getCreateTime().plusMinutes(payTimeoutMinutes));

        // 4. 插入订单
        orderMapper.insert(order);

        // 5. 记下单日志
        recordLog(order.getId(), "create", "买家下单", null, "pending_payment",
                buyer != null ? buyer.getNickname() : "买家", "buyer", null);

        // 6. 扣减库存，售罄则置 sold
        //
        // ★ 这里改成「带条件的原子扣减」★：原来是 selectById 读出来、在内存里减、
        // 再 updateById 整体回写。两个人同时下最后一单时，双方读到的 stock 都是 1、
        // 各自减成 0 再回写，结果是**超卖**（两笔订单共用同一件库存）。
        // 现在让数据库来保证：只有 stock >= qty 的行才会被扣，扣不动就是库存不足。
        // 「售罄置 sold」放到扣减之后重读再判，避免在同一条 SQL 里拼 IF() 这种方言写法。
        if (goods.getStock() == null) {
            // 老数据没写 stock 列：沿用原来的宽松语义（视作 1 件）
            // ★ 仍只 SET 指定列 ★：整实体回写会把这个快照里的 view_count 等列一并盖回，
            // 抹掉并发中的详情页浏览自增。
            LocalDateTime now = LocalDateTime.now();
            goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                    .eq(Goods::getId, goods.getId())
                    .set(Goods::getStock, 0)
                    .set(Goods::getStatus, "sold")
                    .set(Goods::getUpdateTime, now));
            goods.setStock(0);
            goods.setStatus("sold");
            goods.setUpdateTime(now);
        } else {
            int updated = goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                    .eq(Goods::getId, goodsId)
                    .ge(Goods::getStock, qty)
                    .setSql("stock = stock - " + qty)
                    .set(Goods::getUpdateTime, LocalDateTime.now()));
            if (updated == 0) {
                throw BusinessException.of("库存不足，该商品当前仅剩 " + stock + " 件");
            }
            Goods latest = goodsMapper.selectById(goodsId);
            if (latest != null && latest.getStock() != null && latest.getStock() <= 0
                    && !"sold".equals(latest.getStatus())) {
                // ★ 只 SET status + update_time ★：latest 也是一次快照，回写整行会把
                // 读快照之后由并发取消订单回补的 stock 覆盖回 0（白丢一件库存）。
                LocalDateTime now = LocalDateTime.now();
                goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                        .eq(Goods::getId, goodsId)
                        .set(Goods::getStatus, "sold")
                        .set(Goods::getUpdateTime, now));
                goods.setStatus("sold");
            }
            goods.setStock(latest != null && latest.getStock() != null ? latest.getStock() : 0);
        }

        return order;
    }

    // ==================== 买家取消 ====================

    /**
     * 买家取消订单（仅待付款可取消）
     * <p>
     * ★ 必须显式限死 pending_payment ★ —— 状态机里 pending_ship → cancelled
     * 是给管理员 / 卖家关闭订单留的边，若只靠 assertTransition 放行，
     * 买家就能把「已付款待发货」的单直接取消，钱货两清的退款流程被整个绕过。
     * 付款之后想退走 refunding（申请退款），两条线不能混。
     * <p>
     * 取消即回补库存：下单时扣掉的数量要原样还回去，否则一次「下了又取消」
     * 就永久吃掉一件库存，售罄的商品再也回不到在售。
     */
    @Transactional
    public void cancelByBuyer(String orderId, Long userId, String reason) {
        Order order = requireOrder(orderId);
        requireBuyer(order, userId);
        if (!"pending_payment".equals(order.getStatus())) {
            throw BusinessException.of("订单已付款，不能直接取消，可在订单详情申请退款");
        }
        assertTransition(order.getStatus(), "cancelled");

        LocalDateTime now = LocalDateTime.now();
        order.setStatus("cancelled");
        // cancel_reason_text 是 varchar(200)：买家随手粘贴一大段文字会撞库约束变 500
        order.setCancelReasonText(reason != null && !reason.isBlank()
                ? Validators.required(reason, REASON_MAX, "取消原因")
                : "买家主动取消");
        order.setCancelReasonTime(now);
        orderMapper.updateById(order);
        restoreStock(order);

        User buyer = userMapper.selectById(userId);
        recordLog(orderId, "cancel", "买家取消订单", "pending_payment", "cancelled",
                buyer != null ? buyer.getNickname() : "买家", "buyer", order.getCancelReasonText());
    }

    // ==================== 买家申请退款（售后入口） ====================

    /**
     * 买家申请退款：把订单推进到 {@code refunding}，等平台（管理员）审批。
     * <p>
     * ★ 补的是「有出口、没入口」★
     * <p>
     * 状态机里 {@code pending_ship / shipped / received → refunding} 三条边一直都在，
     * 管理端的「同意退款」「驳回退款」也一应俱全（见 {@link #refundOrder} /
     * {@link #rejectRefund}）—— 但**买家自己发起不了**：全代码没有任何一处能把订单
     * 置成 {@code refunding}，只有种子数据和前端 Mock 手工写过。
     * <p>
     * 于是买家的实际处境是：付了款、收到货不对版，想去退 —— 界面里「取消订单」只对
     * 待付款开放（付款后取消已被 {@link #cancelByBuyer} 显式拦掉），又没有任何申请入口，
     * 只能线下找管理员。后台的售后工作台永远是空的，而状态机里那条
     * {@code shipped → refunding} 的边从头到尾没有真实数据走过。
     * <p>
     * ★ 三个刻意的设计决定 ★
     * <ul>
     *   <li><b>不写 {@code refund_time}</b>：那个列是**完成时间**，前端拿它统计已退金额，
     *       申请即写入会把「审核中的售后」算成「已退的钱」。申请时间由本方法记的日志承载，
     *       响应出口再由 {@link #fillLogs} 回填成 {@code refund.time}（契约见
     *       {@link Order#getRefundApplyTime()}）。</li>
     *   <li><b>申请时先按全额挂在退款单上</b>：买家申请退的是「这一单」，
     *       金额默认等于实付；管理员审批时可以改小（部分退款，见 {@link #refundOrder}）。</li>
     *   <li><b>不引入「超时自动同意」</b>：自动同意等于系统替平台做财务决定，
     *       要做也必须是定时任务 + 明确的时限配置，不能靠一句话术。管理员审批前
     *       订单停在 {@code refunding}，前端有独立的「售后中」分组兜住。</li>
     * </ul>
     * <p>
     * ★ 为什么 {@code received} 也在可申请之列 ★
     * <p>
     * 收货后才发现质量问题是最常见的售后场景。而本项目的「确认收货」会**连做**
     * 「收货 + 完成」两步（见 {@link #confirmReceive}），一旦走到 {@code completed}
     * 就是终态、再也退不掉，所以 {@code received} 必须留在可申请状态里
     * （{@link #REFUNDABLE} 已包含，无需另加白名单）。
     *
     * @param reason 申请原因，必填（写进 {@code t_order.refund_reason}，varchar(200)）
     */
    @Transactional
    public void applyRefund(String orderId, Long userId, String reason) {
        Order order = requireOrder(orderId);
        requireBuyer(order, userId);

        if ("refunding".equals(order.getStatus())) {
            throw BusinessException.of("退款申请已提交，正在等待平台处理，请勿重复申请");
        }
        // pending_payment 应走「取消订单」（不用退款），completed / cancelled 是终态：
        // 这里交给状态机判，错误文案由 assertTransition 统一给出
        assertTransition(order.getStatus(), "refunding");

        // refund_reason 是 varchar(200)：买家随手粘贴一大段文字会撞库约束，
        // 整个申请事务回滚，而提示只有一句「服务器内部错误」
        String safeReason = Validators.required(reason, REASON_MAX, "退款原因");

        String before = order.getStatus();
        order.setRefundAmount(order.getAmount());
        order.setRefundReason(safeReason);
        // 发起方记 buyer：管理端详情里「买家申请 / 平台发起」就是读它区分，
        // 审批后也不会被覆写（见 refundOrder 的保留逻辑）
        order.setRefundBy("buyer");
        order.setRefundRemark(null);
        // 完成时间留空 —— 语义见方法头注释，前端已退金额统计读的就是这一列
        order.setRefundTime(null);
        order.setStatus("refunding");
        orderMapper.updateById(order);
        /*
         * ★ 申请阶段必须保证退款单是「干净」的，而这两列的置空 updateById 写不进 NULL ★
         *   · refund_time 是**完成时间**（前端 api/order.ts 拿它统计「已退款金额」），
         *     申请阶段绝不能有值，否则一笔还在审核中的售后会被算成已经退出去的钱；
         *   · refund_remark 是平台备注，新申请不该继承上一轮。
         * 当前不变式下这两列本就应为 NULL（首次申请 / 已被 rejectRefund 的单列 UPDATE 清过），
         * 所以这是一次**幂等的兜底**；写它的意义是不让「将来 refunding 可重复进入」时静默失效。
         * eq(status,'refunding') 是乐观守卫：确认本事务的状态确实已经落库，顺带挡住并发改状态。
         */
        orderMapper.update(null, new LambdaUpdateWrapper<Order>()
                .eq(Order::getId, orderId)
                .eq(Order::getStatus, "refunding")
                .set(Order::getRefundRemark, null)
                .set(Order::getRefundTime, null));

        User buyer = userMapper.selectById(userId);
        // 这条日志就是「申请时间」的唯一来源（to_status='refunding'），
        // 同时给 rejectRefund 提供「申请前的状态」（from_status）
        recordLog(orderId, "refund", "买家申请退款", before, "refunding",
                buyer != null ? buyer.getNickname() : "买家", "buyer", safeReason);
    }

    // ==================== 买家付款 ====================

    /**
     * 校验「这个买家现在能不能为这笔订单付款」，通过则返回订单。
     * <p>
     * ★★ 这里**不再改任何状态** —— 改造前它就是"付款"本身 ★★
     * <p>
     * 原来的 {@code payOrder} 做的是：读订单 → 校验买家 → 校验状态 →
     * {@code setStatus("pending_ship")} → {@code updateById}。也就是说
     * <b>客户端说付了就付了</b>：任何持有合法 token 的人对着
     * {@code POST /orders/{id}/pay} 发一次请求，订单就变成「已付款」，
     * 卖家必须发货。它没有任何支付凭证校验，因为那时候根本没有支付单。
     * <p>
     * 现在这条链路被拆成两段，中间由支付单把住：
     * <pre>
     *   PaymentService.createPayment → requirePayable（本方法，只读校验）
     *                                → 建支付单 → 渠道收银台
     *   渠道回调 / 同步返回           → settle → markPaid（真正翻状态）
     * </pre>
     * 也就是说「翻状态」这一步**只能**被支付成功的结算路径调用，
     * 前端再也不能直接触发它。本方法保留买家归属比对，
     * 是因为「谁能对这笔订单发起支付」仍然是一条越权防线。
     *
     * @throws BusinessException 订单不存在（404）/ 非买家本人（403）/ 状态不可付（1001）
     */
    public Order requirePayable(String orderId, Long userId) {
        Order order = requireOrder(orderId);
        requireBuyer(order, userId);
        if (!"pending_payment".equals(order.getStatus())) {
            throw BusinessException.of("订单当前「" + labelOf(order.getStatus()) + "」，无需付款");
        }
        return order;
    }

    /**
     * 取订单并校验「这是买家本人的单」（**只读，不改任何状态**）。
     * <p>
     * 收银台轮询支付结果时用：用户盯着「支付中…」的界面，前端每隔几秒问一次
     * 「成了没」。这个入口必须是只读的 —— 轮询天然高频，任何写操作放进来都会
     * 被放大成反复写库；而且它不该有副作用：用户只是看了一眼，不该改变任何东西。
     * <p>
     * 归属比对同样不能省：没有它，任何人拿一个订单号就能轮询别人的支付状态
     * （金额、支付方式、渠道流水号都会跟着漏出去）。
     */
    public Order requireBuyerOrder(String orderId, Long userId) {
        Order order = requireOrder(orderId);
        requireBuyer(order, userId);
        return order;
    }

    /**
     * 把订单标记为「已付款，待发货」——**支付结算的唯一落点**。
     * <p>
     * ★★ 为什么必须是条件 UPDATE ★★
     * <p>
     * 支付宝的回调会**重复投递**（没收到 {@code success} 响应就一直重推），
     * 而且可能与我们自己的「超时关单」并发跑到一起。三种情况都要有确定结果：
     * <ul>
     *   <li>重复回调：第二次进来时 {@code status} 已经是 {@code pending_ship}，
     *       WHERE 不命中 → {@code affected == 0} → 直接返回 false，不写第二条日志；</li>
     *   <li>与关单并发：先到的一方赢。若关单先到，这里的 {@code eq(status,'pending_payment')}
     *       不命中 → 返回 false，调用方据此**自动把钱退回去**（订单已关，不能收钱）；</li>
     *   <li>读改写做不到上面任何一条 —— 它会把「已取消」的订单再推回「待发货」。</li>
     * </ul>
     *
     * @param channel 支付方式（wallet / demo / alipay_sandbox / offline）
     * @return 本次调用是否**真的**完成了状态流转（false = 已经被处理过或订单已不可付）
     */
    @Transactional
    public boolean markPaid(String orderId, String channel) {
        LocalDateTime now = LocalDateTime.now();
        int affected = orderMapper.update(null, new LambdaUpdateWrapper<Order>()
                .eq(Order::getId, orderId)
                .eq(Order::getStatus, "pending_payment")
                .set(Order::getStatus, "pending_ship")
                .set(Order::getPayTime, now)
                .set(Order::getPayChannel, channel));
        if (affected == 0) {
            return false;
        }
        recordLog(orderId, "pay", "买家付款", "pending_payment", "pending_ship",
                "买家", "buyer", payChannelLabel(channel));
        return true;
    }

    /**
     * 超时未付款：关闭订单并回补库存。
     * <p>
     * ★★ 补的是「配置能看能改、却没有任何代码消费它」★ 这一族缺陷 ★★
     * <p>
     * 前端的 {@code ORDER_SLA_HOURS.pending_payment = 24} 只是个**界面常量**，
     * 后端的 {@code slaBreach} SQL 片段也只是把超时订单**标红显示**出来 ——
     * 全代码没有一个定时任务真的去关过单。后果是：买家拍下不付，库存被永久占住，
     * 卖家既不能卖给别人也无法自行解除（{@code cancelByBuyer} 只有买家能调）。
     * 商品就这样从货架上消失，而管理员在后台看到的只是一条「待付款」记录。
     * <p>
     * 判据用 {@code pay_expire_at}（下单时按配置算出并落库，见
     * {@link Order#getPayExpireAt()}），而不是现场用 {@code create_time} 加偏移 ——
     * 后者会让「改配置」把存量订单的截止时间一起改掉。
     * <p>
     * 同样走条件 UPDATE：与「用户刚好在这一刻付款成功」并发时，
     * 只有一方能赢。付款赢 → 本方法返回 false，订单保持待发货；
     * 关单赢 → 付款方返回 false，由 {@code PaymentService} 自动退回那笔钱。
     *
     * @return 本次调用是否真的关掉了订单（false = 状态已变，不必回补库存）
     */
    @Transactional
    public boolean closeExpiredOrder(String orderId) {
        LocalDateTime now = LocalDateTime.now();
        int affected = orderMapper.update(null, new LambdaUpdateWrapper<Order>()
                .eq(Order::getId, orderId)
                .eq(Order::getStatus, "pending_payment")
                .set(Order::getStatus, "cancelled")
                .set(Order::getCancelReasonText, "超时未付款，系统自动关闭")
                .set(Order::getCancelReasonTime, now));
        if (affected == 0) {
            return false;
        }
        /*
         * ★ 回补库存必须在状态改成功之后 ★
         * 反过来（先回补再改状态）会在「状态已经变了、库存不该回补」时白送一件库存 ——
         * 两个并发的关单请求各回补一次，商品凭空多出两件。
         * 条件 UPDATE 的 affected 就是这里的准入凭据：只有真正改了状态的那一次才回补。
         */
        Order order = orderMapper.selectById(orderId);
        if (order != null) {
            restoreStock(order);
        }
        recordLog(orderId, "cancel", "超时未付款，系统自动关闭", "pending_payment", "cancelled",
                "系统", "system", "订单超过支付时限仍未付款");
        return true;
    }

    /** 支付方式 → 中文（写进订单时间线，让买卖双方看得懂钱是怎么付的） */
    public static String payChannelLabel(String channel) {
        if (channel == null) {
            return null;
        }
        return switch (channel) {
            case "wallet" -> "钱包余额支付";
            case "demo" -> "演示渠道支付";
            case "alipay_sandbox" -> "支付宝支付";
            case "offline" -> "平台线下代收";
            default -> "支付方式：" + channel;
        };
    }

    // ==================== 卖家发货 ====================

    @Transactional
    public void shipOrder(String orderId, String trackingNo, String company, Long userId) {
        Order order = requireOrder(orderId);
        requireSeller(order, userId);
        assertTransition(order.getStatus(), "shipped");

        // 运单号 / 承运公司都是 varchar(50)：卖家粘贴单号时多带几位就会撞库约束，
        // 整个发货事务回滚，而提示只有一句「服务器内部错误」
        String safeTrackingNo = Validators.optional(trackingNo, CARRIER_MAX, "运单号");
        String safeCompany = Validators.optional(company, CARRIER_MAX, "承运公司");

        LocalDateTime now = LocalDateTime.now();
        order.setStatus("shipped");
        order.setTrackingNo(safeTrackingNo);
        if (safeCompany != null) order.setLogisticsCompany(safeCompany);
        order.setShipTime(now);
        /*
         * ★ t_order.traces 原先是「死列」★
         * schema.sql 建了列、OrderMapper 配了 JacksonTypeHandler、实体也声明了字段，
         * 种子数据（demo-data-orders.sql）还灌满了轨迹 —— 但全代码**没有任何一处 setTraces**。
         * 结果是「演示数据能看到完整时间轴、真实发货的订单轨迹永远是 NULL」，
         * 买家在自己的订单详情里看到一片空白，而且不会报错。
         * 从发货这一步开始真正落库（签收那一站在 confirmReceive 里追加）。
         */
        order.setTraces(withTrace(order.getTraces(), now, "卖家已发货，快件已被【"
                + (safeCompany != null ? safeCompany : "校园驿站") + "】揽收"));
        orderMapper.updateById(order);

        recordLog(orderId, "ship", "卖家发货", "pending_ship", "shipped",
                order.getSellerName(), "seller", safeCompany != null ? safeCompany + " " + safeTrackingNo : safeTrackingNo);
    }

    // ==================== 买家确认收货 ====================

    /**
     * 确认收货 → 直接进入已完成（收货 + 完成连做两步，时间戳与日志分开）
     */
    @Transactional
    public void confirmReceive(String orderId, Long userId) {
        Order order = requireOrder(orderId);
        requireBuyer(order, userId);
        assertTransition(order.getStatus(), "received");

        LocalDateTime receiveAt = LocalDateTime.now();
        LocalDateTime completeAt = receiveAt.plusSeconds(1);

        order.setStatus("completed");
        order.setReceiveTime(receiveAt);
        order.setCompleteTime(completeAt);
        // 物流轨迹补上「签收」这一站（与 shipOrder 里的「已发货」成对，见那边的注释）
        order.setTraces(withTrace(order.getTraces(), receiveAt,
                "快件已签收，签收人：本人。感谢使用，期待再次为您服务"));
        orderMapper.updateById(order);

        User buyer = userMapper.selectById(userId);
        recordLog(orderId, "receive", "买家确认收货", "shipped", "received",
                buyer != null ? buyer.getNickname() : "买家", "buyer", null);
        recordLog(orderId, "complete", "交易完成", "received", "completed",
                "系统", "system", "确认收货后系统自动完成结算");
    }

    // ==================== 管理端 ====================

    public IPage<Order> fetchAdminOrders(Map<String, Object> query) {
        int page = (int) query.getOrDefault("page", 1);
        int pageSize = (int) query.getOrDefault("pageSize", 10);
        return orderMapper.selectAdminOrders(new Page<>(page, pageSize), query);
    }

    /**
     * 导出行数上限。
     * <p>
     * ★ 为什么导出必须自己也设上限 ★
     * <p>
     * 另两处导出（审计日志 / 审核记录）都各自设了 5000 上限，唯独这里漏了：
     * 原先直接把 Map 交给 XML，而 {@code selectAdminOrdersForExport} 是一条
     * **不带 LIMIT 的裸查询**，因此它**根本不经过**分页拦截器，
     * 全局 {@code MybatisPlusConfig} 里的 {@code setMaxLimit(500)} 对它无效 ——
     * 订单量上万时会把整表读进内存，既拖慢导出也可能 OOM。
     * <p>
     * 这里在服务层兜一道：即调用方没传 pageSize（或传了个非法值），也不会退化成全表查询。
     */
    private static final int EXPORT_MAX = 5000;

    public List<Order> fetchAdminOrdersForExport(Map<String, Object> query) {
        Map<String, Object> q = new HashMap<>(query);
        Object raw = q.get("pageSize");
        int size = raw instanceof Number n ? n.intValue() : EXPORT_MAX;
        q.put("pageSize", Math.max(1, Math.min(EXPORT_MAX, size)));
        return orderMapper.selectAdminOrdersForExport(q);
    }

    /**
     * 订单工作台统计
     * <p>
     * 前端 `AdminOrderStats` 要求的字段一个都不能少：
     * {@code total / todo / issues / todayCount / gmv / pendingGmv / refundedAmount
     * / byStatus / groups}。
     * <p>
     * 之前直接把 SQL 聚合的「各状态计数」原样返回，前端拿到的
     * {@code byStatus}、{@code groups} 全是 undefined，概览卡与状态页签全空，
     * 而且 gmv 口径也没排除「待付款」（没收到的钱不能算成交）。
     * <p>
     * ★ 口径与前端 mock 严格一致（两者必须能对得上，否则联调时数不一样就是 bug）：
     * <ul>
     *   <li>{@code gmv}：仅已成交状态（pending_ship / shipped / received / completed）；</li>
     *   <li>{@code pendingGmv}：已付款但还没走完的（pending_ship / shipped / received）；</li>
     *   <li>{@code refundedAmount}：有退款完成时间的单，退多少算多少（部分退款按实退）；</li>
     *   <li>{@code issues}：踩到服务时限的单数（各类超时阈值见 SQL 注释）。</li>
     * </ul>
     */
    public Map<String, Object> fetchAdminOrderStats() {
        Map<String, Object> agg = orderMapper.selectOrderStats();

        Map<String, Integer> byStatus = new LinkedHashMap<>();
        Map<String, BigDecimal> amountByStatus = new LinkedHashMap<>();
        ALL_STATUSES.forEach(s -> {
            byStatus.put(s, 0);
            amountByStatus.put(s, BigDecimal.ZERO);
        });
        for (OrderStatusStat row : orderMapper.selectStatusStats()) {
            if (row.getStatus() == null) continue;
            byStatus.put(row.getStatus(), row.getCnt() == null ? 0 : row.getCnt());
            amountByStatus.put(row.getStatus(),
                    row.getAmt() == null ? BigDecimal.ZERO : row.getAmt());
        }

        List<Map<String, Object>> groups = new ArrayList<>();
        for (Map<String, Object> def : OVERVIEW_GROUPS) {
            @SuppressWarnings("unchecked")
            List<String> statuses = (List<String>) def.get("statuses");
            int count = statuses.stream().mapToInt(s -> byStatus.getOrDefault(s, 0)).sum();
            BigDecimal amount = statuses.stream()
                    .map(s -> amountByStatus.getOrDefault(s, BigDecimal.ZERO))
                    .reduce(BigDecimal.ZERO, BigDecimal::add);
            Map<String, Object> item = new LinkedHashMap<>(def);
            item.put("count", count);
            item.put("amount", amount);
            groups.add(item);
        }

        int todo = TODO_STATUS.stream().mapToInt(s -> byStatus.getOrDefault(s, 0)).sum();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("total", num(agg.get("total")));
        result.put("todo", todo);
        result.put("issues", num(agg.get("issues")));
        result.put("todayCount", num(agg.get("todayCount")));
        result.put("gmv", dec(agg.get("gmv")));
        result.put("pendingGmv", dec(agg.get("pendingGmv")));
        result.put("refundedAmount", dec(agg.get("refundedAmount")));
        result.put("byStatus", byStatus);
        result.put("groups", groups);
        return result;
    }

    /** 聚合结果里的计数一律是 Long/BigDecimal，统一转成前端能直接算的数值 */
    private int num(Object raw) {
        return raw instanceof Number n ? n.intValue() : 0;
    }

    private BigDecimal dec(Object raw) {
        if (raw == null) return BigDecimal.ZERO;
        return raw instanceof BigDecimal b ? b : new BigDecimal(raw.toString());
    }

    /**
     * 管理员改订单状态（含补填运单号），并写入操作日志
     * <p>
     * ★ 状态机会拦下非法流转
     */
    @Transactional
    public void updateOrderStatus(String orderId, String targetStatus, String trackingNo,
                                   String logisticsCompany, String reason) {
        Order order = requireOrder(orderId);

        String before = order.getStatus();
        assertTransition(before, targetStatus);

        // ★ 运单号 / 承运公司是 varchar(50)、取消原因是 varchar(200) ★
        // 超长会在 updateById 那一刻撞 MySQL 严格模式抛 Data too long，事务整体回滚 ——
        // 管理员补填运单号时多贴了几个字符，看到的就是「服务器内部错误」，
        // 而这次状态流转与物流信息其实一个都没生效
        String safeTrackingNo = Validators.optional(trackingNo, CARRIER_MAX, "运单号");
        String safeCarrier = Validators.optional(logisticsCompany, CARRIER_MAX, "承运公司");
        String safeReason = Validators.optional(reason, REASON_MAX, "订单原因");

        LocalDateTime now = LocalDateTime.now();
        order.setStatus(targetStatus);
        if (safeTrackingNo != null) order.setTrackingNo(safeTrackingNo);
        if (safeCarrier != null) order.setLogisticsCompany(safeCarrier);
        if ("shipped".equals(targetStatus) && order.getShipTime() == null) order.setShipTime(now);
        if ("pending_ship".equals(targetStatus) && order.getPayTime() == null) {
            order.setPayTime(now);
            /*
             * ★ 管理员把订单推进到「待发货」，等于「平台确认收到钱了」★
             *
             * 这条路径与买家在收银台付款是两件事：常见于线下现金/转账、或者第三方渠道
             * 回调丢失后管理员人工核对。所以支付方式标成 offline 而不是留空 ——
             * 把平台自己记的账伪装成钱包/支付宝支付，会让按渠道统计与对账全部失真。
             * 只有 {@code payTime} 为空时才补，避免覆盖买家真实支付的渠道记录。
             */
            if (order.getPayChannel() == null) order.setPayChannel("offline");
        }
        if ("received".equals(targetStatus) && order.getReceiveTime() == null) order.setReceiveTime(now);
        if ("completed".equals(targetStatus)) {
            if (order.getReceiveTime() == null) order.setReceiveTime(now);
            order.setCompleteTime(now);
        }
        if ("cancelled".equals(targetStatus) && order.getCancelReasonText() == null) {
            order.setCancelReasonText(safeReason != null ? safeReason : "管理员关闭订单");
            order.setCancelReasonTime(now);
        }
        orderMapper.updateById(order);

        // 关闭订单 = 交易作废，下单时扣掉的库存要还回去（退款路径同理，见 refundOrder）
        if ("cancelled".equals(targetStatus)) {
            restoreStock(order);
        }

        String action = "cancelled".equals(targetStatus) ? "cancel" :
                        "shipped".equals(targetStatus) ? "ship" :
                        "received".equals(targetStatus) ? "receive" :
                        "completed".equals(targetStatus) ? "complete" : "adjust";
        recordLog(orderId, action, labelOf(targetStatus), before, targetStatus, "管理员", "admin",
                reason != null ? reason : (trackingNo != null ? "运单号 " + trackingNo : null));

        addAuditLog("order.status", "修改订单状态", "订单 " + orderId,
                labelOf(before) + " → " + labelOf(targetStatus));
    }

    /**
     * 退款（平台同意）：置为已取消并记录退款单（金额 / 原因 / 发起方 / 备注）。
     * <p>
     * 两条入口共用本方法：买家申请过售后单的（{@code before = refunding}，见
     * {@link #applyRefund}）与管理员直接退的（任意可退状态）。前者**保留买家填的
     * 申请原因与发起方**，只允许审批人改金额（可部分退）与备注；后者补一条
     * 「平台发起退款」日志，时间线才完整。
     */
    @Transactional
    public void refundOrder(String orderId, BigDecimal amount, String reason, String remark) {
        Order order = requireOrder(orderId);
        if ("cancelled".equals(order.getStatus())) throw BusinessException.of("该订单已取消，无需重复退款");
        if (!REFUNDABLE.contains(order.getStatus())) {
            throw BusinessException.of("订单当前「" + labelOf(order.getStatus()) + "」，不支持退款");
        }

        String before = order.getStatus();
        LocalDateTime now = LocalDateTime.now();
        BigDecimal refundAmount = amount != null ? amount : order.getAmount();
        if (refundAmount.compareTo(BigDecimal.ZERO) <= 0) throw BusinessException.of("退款金额必须大于 0");
        if (refundAmount.compareTo(order.getAmount()) > 0) {
            throw BusinessException.of("退款金额不得超过买家实付 ¥" + order.getAmount());
        }

        // refund_reason 是 varchar(200)、refund_remark 是 varchar(500)：
        // 原因 / 备注超长会在 updateById 那一刻抛 Data too long，
        // 整笔退款连同库存回补一起回滚 —— 钱没退、库存也没还，而报错只是一句 500
        String safeRefundReason = Validators.optional(reason, REASON_MAX, "退款原因");
        String safeRefundRemark = Validators.optional(remark, NOTE_MAX, "退款备注");

        /*
         * ★ 买家已申请过的售后单：审批时不得改写「申请理由」与「发起方」★
         *
         * 申请理由是**证据**（买家当时为什么要求退），不是审批人可以编辑的字段。
         * 原实现无条件写成「payload.reason 或默认文案」「refund_by=admin」，
         * 于是「买家申请 → 管理员同意」这条链路上，售后统计里看到的全是
         * 「平台发起 · 双方协商一致退款」—— 谁提的、为什么提，两条信息同时丢失，
         * 售后数据彻底失去参考价值（前端 Mock 早就按保留语义实现，见 api/order.ts）。
         *
         * 金额与备注则**允许**审批时改：金额是审批结论（可部分退），
         * 备注是审批人写的处理说明。
         */
        boolean buyerApplied = "refunding".equals(before) && "buyer".equals(order.getRefundBy());
        String finalReason = buyerApplied && order.getRefundReason() != null
                ? order.getRefundReason()
                : (safeRefundReason != null ? safeRefundReason : "双方协商一致退款");

        order.setRefundAmount(refundAmount);
        order.setRefundReason(finalReason);
        order.setRefundBy(buyerApplied ? "buyer" : "admin");
        order.setRefundRemark(safeRefundRemark);
        order.setRefundTime(now);
        order.setStatus("cancelled");
        orderMapper.updateById(order);
        // 退款即交易作废，商品回补库存（与取消订单同一口径，见 restoreStock）
        restoreStock(order);

        // 若是管理员直接退（买家没有申请过），先补一条「平台发起退款」，时间线才完整
        if (!"refunding".equals(before)) {
            recordLog(orderId, "refund", "平台发起退款", before, "refunding",
                    "管理员", "admin", order.getRefundReason());
        }
        recordLog(orderId, "refund", "退款完成，订单关闭", "refunding", "cancelled",
                "管理员", "admin", "退款 ¥" + refundAmount + (safeRefundRemark != null ? " · " + safeRefundRemark : ""));

        addAuditLog("order.refund", "订单退款", "订单 " + orderId,
                "退款 ¥" + refundAmount + "（原因：" + order.getRefundReason() + "；原状态：" + labelOf(before) + "）");
    }

    /**
     * 驳回退款申请：撤销售后单，把订单退回**申请退款之前的那个状态**
     * <p>
     * ★ 为什么不能一律退回 shipped ★
     * <p>
     * 退款申请可能来自三种状态：{@code pending_ship} / {@code shipped} / {@code received}。
     * 原实现无条件写死 {@code shipped}，造成两个真实缺陷：
     * <ul>
     *   <li>从 {@code pending_ship}（卖家还没发货）申请 → 驳回后变成「已发货」，
     *       而 {@code ship_time} 仍是 {@code null}：状态说发了、库里没有发货时间、日志里也没有 ship 记录。
     *       卖家看到「已发货」以为货已出，**再也不会去发货，交易直接卡死**；</li>
     *   <li>从 {@code received}（买家已收货）申请 → 驳回后退回发货态，收货时间丢失，
     *       {@code received → completed} 的履约链断裂。</li>
     * </ul>
     * 而且 {@code refunding → shipped} 这条边**根本不在状态机表 {@link #TRANSITIONS} 里**
     * （表中 {@code refunding} 只能转到 {@code cancelled}），原写法等于绕过了守卫。
     * <p>
     * ★ 怎么拿到「申请前的状态」★
     * <p>
     * 不需要新增数据库列 —— 每次状态流转都写进 {@code t_order_log} 的
     * {@code from_status → to_status}，所以取**最近一条 {@code to_status='refunding'} 的
     * {@code from_status}} 就是答案（见 {@link #refundBackTarget}）。
     */
    @Transactional
    public void rejectRefund(String orderId, String note) {
        Order order = requireOrder(orderId);
        if (!"refunding".equals(order.getStatus())) {
            throw BusinessException.of("订单当前「" + labelOf(order.getStatus()) + "」，没有待处理的退款申请");
        }

        order.setRefundAmount(null);
        order.setRefundReason(null);
        order.setRefundBy(null);
        order.setRefundRemark(null);
        order.setRefundTime(null);
        // 驳回备注最终会写进 t_order_log.note（varchar(500)），超长同样走 500 兜底
        Validators.optional(note, NOTE_MAX, "驳回备注");

        String back = refundBackTarget(orderId);
        /*
         * ★ 清空必须「显式 SET 成 NULL」，不能靠 updateById ★
         *
         * MyBatis-Plus 的 updateById 默认走 FieldStrategy.NOT_NULL：**null 字段根本不进
         * SET 子句**。所以上面那五句 setXxx(null) 配原来的 updateById，在库上等于什么都没做 ——
         * refund_amount / reason / by / remark / time 原样留在行里，而订单状态已经退回
         * 「申请前」（shipped / pending_ship / received）。后果是双向的：
         *   · {@link Order#getRefund()} 的判定条件（refundTime 或 refundAmount 非空）依然成立，
         *     买卖双方与管理员看到的是一张「已驳回、却还挂着退款单」的订单 ——
         *     金额、原因、申请时间一应俱全，谁也说不清这笔售后到底结没结；
         *   · 前端 `api/order.ts` 的退款统计按 refundTime 计数，被驳回的单子会被算进
         *     「已退款金额」；Mock 分支专门断言过「驳回后 refund 整个消失」。
         * 这里改成单列原子 UPDATE + 显式 set(列, null)，并带 status 乐观守卫：
         * 两个管理员同时点「驳回」时，后到的这次不会把前一次的结果当成 refunding 再写一遍。
         */
        int affected = orderMapper.update(null, new LambdaUpdateWrapper<Order>()
                .eq(Order::getId, orderId)
                .eq(Order::getStatus, "refunding")
                .set(Order::getStatus, back)
                .set(Order::getRefundAmount, null)
                .set(Order::getRefundReason, null)
                .set(Order::getRefundBy, null)
                .set(Order::getRefundRemark, null)
                .set(Order::getRefundTime, null));
        if (affected == 0) {
            throw BusinessException.of("退款申请状态已变化，请刷新后重试");
        }

        recordLog(orderId, "adjust", "驳回退款申请", "refunding", back,
                "管理员", "admin",
                (note != null && !note.isBlank() ? note : "经核实后驳回，订单恢复履约")
                        + "（恢复至「" + labelOf(back) + "」）");
    }

    /**
     * 「进入售后之前」的状态：最近一条 {@code to_status='refunding'} 日志的 {@code from_status}。
     * <p>
     * 只接受确实可以进入售后的三种状态（{@link #REFUNDABLE} 去掉 {@code refunding} 自身）；
     * 取不到（历史数据没留对应日志）时退回 {@code shipped}，与旧行为保持兼容，不会更差。
     */
    private String refundBackTarget(String orderId) {
        OrderLog latestIntoRefund = orderLogMapper.selectOne(new LambdaQueryWrapper<OrderLog>()
                .eq(OrderLog::getOrderId, orderId)
                .eq(OrderLog::getToStatus, "refunding")
                .orderByDesc(OrderLog::getId)
                .last("LIMIT 1"));
        String from = latestIntoRefund != null ? latestIntoRefund.getFromStatus() : null;
        return from != null && REFUNDABLE.contains(from) && !"refunding".equals(from) ? from : "shipped";
    }

    /** 与 schema.sql 严格一致：t_order.admin_note / t_order_log.note 都是 varchar(500) */
    private static final int NOTE_MAX = 500;

    /** 与 schema.sql 严格一致：t_order.tracking_no / logistics_company 都是 varchar(50) */
    private static final int CARRIER_MAX = 50;

    /** 与 schema.sql 严格一致：t_order.cancel_reason_text / refund_reason 都是 varchar(200) */
    private static final int REASON_MAX = 200;

    /**
     * 与 schema.sql 严格一致：订单的金额列全是 {@code decimal(10,2)} ——
     * 整数部分只有 8 位，上限就是 99999999.99。
     * <p>
     * 为什么需要一个常量来守：挂牌价上限是 {@code MAX_PRICE = 99999999.99}、
     * 库存上限是 9999，两者相乘能轻易越过这个上限；而 MySQL 处于
     * {@code STRICT_TRANS_TABLES} 时越界是硬报错（Out of range），
     * 会让整个下单事务回滚（连刚扣掉的库存一起回滚），用户只看到 500。
     * 提前拦成 1001，才能给出「请减少购买数量」这种可读的原因。
     */
    private static final java.math.BigDecimal AMOUNT_MAX = new java.math.BigDecimal("99999999.99");

    /**
     * 物流轨迹条目的时间格式。
     * <p>
     * ★ 必须与种子数据（`demo-data-orders.sql` 的 traces 列）和前端
     * `types/index.ts` 的 `LogisticsTrace.time` 完全一致 ★：`2026-09-15T09:20:00`。
     * 不用 {@code LocalDateTime.toString()} —— 它在秒为 0 时会省掉 `:00`
     * （输出 `2026-09-15T09:20`），同一列里出现两种格式，前端 `new Date()` 解析结果会不一致。
     */
    private static final DateTimeFormatter TRACE_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    /** 单条物流轨迹条目（键名 time / text 与前端 LogisticsTrace 对齐） */
    private static Map<String, Object> traceEntry(LocalDateTime at, String text) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("time", at.format(TRACE_TIME));
        m.put("text", text);
        return m;
    }

    /**
     * 追加一条物流轨迹，**新条目放最前**。
     * <p>
     * 阅读顺序必须与种子数据一致：`demo-data-orders.sql` 里 traces 是「最新在前」，
     * 前端直接顺序渲染。插到末尾会让新发货的订单时间轴倒过来。
     */
    private static List<Map<String, Object>> withTrace(List<Map<String, Object>> old, LocalDateTime at, String text) {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(traceEntry(at, text));
        if (old != null && !old.isEmpty()) out.addAll(old);
        return out;
    }

    /**
     * 写后台内部备注
     * <p>
     * ★ 同一个超长值会写两处 ★ t_order.admin_note 与 t_order_log.note 都是 varchar(500)，
     * 超长会在任一处撞 MySQL 严格模式抛 Data too long，整个事务一起回滚 ——
     * 管理员看到的是「备注保存失败：服务器内部错误」，而订单本身其实什么问题都没有。
     */
    @Transactional
    public void saveOrderNote(String orderId, String note) {
        Order order = requireOrder(orderId);
        String safeNote = Validators.optional(note, NOTE_MAX, "后台备注");
        String text = safeNote != null ? safeNote.trim() : "";
        // 库里 null 与空串是同一个语义（都是「没有备注」）。原先直接 text.equals(getAdminNote())，
        // 当列是 null 时恒为 false —— 于是「本来没备注、又提交空串」也会走一遍写库 + 记一条
        // 「清空后台备注」日志，属于纯噪音。统一成空串再比。
        String current = order.getAdminNote() != null ? order.getAdminNote() : "";
        if (text.equals(current)) return;

        /*
         * ★ 必须单列 UPDATE，不能 `setAdminNote(...)` + `updateById` ★
         * 「清空备注」这条意图在 updateById 下**写不进库**：MP 默认 FieldStrategy.NOT_NULL，
         * null 字段根本不进 SET 子句（本项目 application.yml 未覆盖 update-strategy）——
         * 于是库里的旧备注原样留着，而下面已经记了一条「清空后台备注」的日志，
         * **库与审计日志互相矛盾**。
         * `set(col, null)` 走 formatParam，一定会拼进 SET 子句，这才是真正的清空。
         */
        String nextNote = text.isEmpty() ? null : text;
        orderMapper.update(null, new LambdaUpdateWrapper<Order>()
                .eq(Order::getId, orderId)
                .set(Order::getAdminNote, nextNote));

        recordLog(orderId, "note", text.isEmpty() ? "清空后台备注" : "更新后台备注",
                null, null, "管理员", "admin", nextNote);
    }

    // ==================== 订单日志查询 ====================

    public List<OrderLog> fetchOrderLogs(String orderId) {
        return selectLogs(List.of(orderId)).getOrDefault(orderId, List.of());
    }

    /**
     * 订单日志（带可见性校验 + 按身份裁剪）
     * <p>
     * 订单日志里有运单号、退款原因等履约留痕，属于只该买卖双方与管理员看到的内容 ——
     * 只判「登录了」就放行，任何注册用户换个订单号就能读到别人的交易详情。
     * <p>
     * ★ 过了这道闸 ≠ 全量可见 ★ 其中「后台内部备注」（{@code action='note'}）只对全能 admin
     * 开放，买卖双方拿到的是裁剪后的列表 —— 见 {@link #visibleLogs}。
     */
    public List<OrderLog> fetchOrderLogs(String orderId, Long userId, String role) {
        Order order = requireOrder(orderId);
        /*
         * ★ 只有全能 admin 能越过「买卖双方」这道闸 ★
         *
         * 这里原先还放行了 goods_admin / report_admin。但这两个角色的职责域分别是
         * 商品审核台与举报处理台，与订单履约无关（AuthInterceptor 明确要求两者职能互斥），
         * 而 /orders/** 不在任何后台 zone，拦截器只要求登录 ——
         * 于是任何审核员都能拿一个订单号读到运单号、退款原因、后台内部备注（已实测确认）。
         * 订单日志的可见范围就是「买卖双方 + 全能 admin」，与下面注释一致。
         */
        boolean isAdmin = "admin".equals(role);
        boolean isParty = userId != null
                && (userId.equals(order.getBuyerId()) || userId.equals(order.getSellerId()));
        if (!isAdmin && !isParty) {
            throw BusinessException.forbidden("无权查看该订单的操作日志");
        }
        return visibleLogs(fetchOrderLogs(orderId), isAdmin);
    }

    /**
     * 按订单 id 批量取日志，并按 orderId 分组（一次 IN 查询，避免逐单 N+1）
     */
    private Map<String, List<OrderLog>> selectLogs(List<String> orderIds) {
        List<String> ids = orderIds.stream().filter(Objects::nonNull).distinct().toList();
        if (ids.isEmpty()) return Map.of();
        return orderLogMapper.selectList(
                        new LambdaQueryWrapper<OrderLog>()
                                .in(OrderLog::getOrderId, ids)
                                .orderByDesc(OrderLog::getTime))
                .stream()
                .collect(Collectors.groupingBy(OrderLog::getOrderId));
    }

    /**
     * 只保留「该查看者有权看到的」日志条目。
     * <p>
     * ★ 为什么必须在**出口**过滤，而不是靠前端不渲染 ★
     * <p>
     * {@code t_order_log} 里混着两种东西：一种是买卖双方都该看到的履约留痕
     * （下单 / 付款 / 发货 / 收货 / 退款原因 / 驳回原因），另一种是**管理员写给管理员看的**
     * 内部备注（{@link #saveOrderNote} 写入 {@code action='note'}，且 {@code note} 就是备注原文）。
     * <p>
     * 原实现把整张表的行原样下发。前端订单页恰好没有渲染 {@code logs}，
     * 所以界面上「看不见」—— 但**数据已经进了买家的浏览器**：
     * 打开开发者工具看 {@code GET /orders} 的响应体，就能读到管理员写的备注原文。
     * 这属于「靠前端不渲染来兜底」，一旦前端补上时间线渲染，隐私缺陷会当场变成显示事故。
     * <p>
     * 因此过滤点放在数据出口：调用方给出查看者身份，方法负责决定给什么。
     *
     * @param logs    原始日志（可为 null，表示该单没有日志）
     * @param isAdmin 是否为全能 admin（只有它能看到内部备注）
     */
    public List<OrderLog> visibleLogs(List<OrderLog> logs, boolean isAdmin) {
        if (logs == null || isAdmin) return logs;
        return logs.stream()
                .filter(l -> !LOG_ACTION_ADMIN_NOTE.equals(l.getAction()))
                .toList();
    }

    /**
     * 给一批订单回填操作日志（前端 `Order.logs`，订单详情的时间线由此而来），
     * 并按查看者身份裁掉「仅后台可见」的字段。
     * <p>
     * 列表页一次性回填，比让前端逐单再发 N 个请求要省得多；
     * 这里用一条 IN 查询覆盖整页，成本与单条查询同级。
     * <p>
     * ★ 裁两样，都是同一个根因（后台内部信息随普通接口下发）★
     * <ul>
     *   <li>{@code logs} 里的 {@code action='note'} 行 —— 后台备注原文，见 {@link #visibleLogs}；</li>
     *   <li>{@code order.adminNote} 本身 —— 它是 {@link Order} 上的普通字段，
     *       没有 {@code @JsonIgnore}，会**逐条**出现在每一次 {@code GET /orders} 的响应里。
     *       前端 `types/index.ts` 明确定义它「只对管理员可见，买家与卖家都看不到」，
     *       而管理端订单列表 / 详情抽屉确实在读它（OrdersPanel / OrderDetailDrawer），
     *       所以不能一刀切忽略，只能按身份裁剪。</li>
     * </ul>
     * ★ 这里是「把对象上的字段置空」，只用在**响应出口** ★
     * 调用方都是 Controller，拿到结果就直接序列化返回，不会再回写数据库 ——
     * 因此清空不会污染库里的数据。若将来有人在「先 fillLogs 再 updateById」的路径上复用它，
     * 就会把备注洗掉，届时应改成另建一个只读视图对象。
     */
    public void fillLogs(List<Order> orders, boolean isAdmin) {
        if (orders == null || orders.isEmpty()) return;
        Map<String, List<OrderLog>> byOrder = selectLogs(orders.stream().map(Order::getId).toList());
        orders.forEach(o -> {
            List<OrderLog> logs = visibleLogs(byOrder.getOrDefault(o.getId(), List.of()), isAdmin);
            o.setLogs(logs);
            /*
             * 回填「申请退款时间」：取最近一条 to_status='refunding' 的日志。
             *
             * 与 refundBackTarget 取的是同一行数据（那边要 from_status，这边要 time）——
             * 申请时间不落 t_order 的列，只存在日志里，理由见 Order#getRefundApplyTime()。
             * selectLogs 已按 time 倒序，所以匹配到的第一条就是最近一次申请；
             * 驳回后退款单被清空（见 rejectRefund），getRefund() 返回 null，
             * 这条回填不会被上层读到，不会出现「售后已结案却还显示申请时间」。
             */
            o.setRefundApplyTime(logs.stream()
                    .filter(l -> "refunding".equals(l.getToStatus()))
                    .map(OrderLog::getTime)
                    .findFirst()
                    .orElse(null));
            if (!isAdmin) {
                // 库列 admin_note 照旧保留，只在出口清空（配合 @JsonInclude(NON_NULL)，键直接消失）
                o.setAdminNote(null);
            }
        });
    }

    // ==================== 内部工具 ====================

    /**
     * 生成订单号：{@code yyyyMMddHHmmssSSS} + 1 位实例号 + 2 位毫秒内序号（共 20 位）。
     * <p>
     * 早期直接用 {@code System.currentTimeMillis()} 当主键：同一毫秒内的两笔下单
     * （脚本压测、连点两下「立即购买」）会拿到同一个号 → 主键冲突、第二单直接失败。
     * 补一个毫秒内自增序号即可唯一，同时保留「时间有序、肉眼可读」的优点。
     * <p>
     * ★ L5（2026-09-22）★ 上一版是 {@code timestamp + (全局 AtomicInteger % 1000)}，两个毛病：
     * <ol>
     *   <li><b>序号与毫秒无关</b>：计数器从头到尾只增不减、跨毫秒不归零，
     *       所以那个「毫秒内序号」其实是个全局流水号，压根不表示「这一毫秒里的第几单」；</li>
     *   <li><b>静默回绕</b>：第 1000 次调用把序号绕回 0。只要第 N 次与第 N+1000 次落在同一毫秒
     *       （脚本压测下并不罕见），就会生成出**完全相同的订单号** → 主键冲突，
     *       用户看到的是「下单失败」，日志里没有任何线索指向撞号。</li>
     * </ol>
     * 而且它是纯进程内状态：两个 JVM 各自从 0 开始，多实例部署**必然**撞号。
     * <p>
     * 现在的做法：
     * <ul>
 *   <li>序号**按毫秒归零**，且发号器内部记录的毫秒只增不减（顺带免疫时钟回拨）；</li>
 *   <li>一毫秒内超过 100 单（2 位序号的上限）时，把毫秒**推进**一格而不是回绕 ——
     *       代价是发出的时间戳可能略微跑在挂钟前面（标准雪花算法的取舍），换来的是「绝不重复」，
     *       而订单号的用途本来就只是「唯一 + 大致有序」，不要求与挂钟严格一致；</li>
     *   <li>实例号占序号段的最高位，多实例各配一个号即可跨 JVM 唯一。</li>
     * </ul>
     * 于是在「实例数不超过 10」的前提下，{@code (毫秒, 实例号, 毫秒内序号)} 三元组严格不重复。
     * <p>
     * 抽出一个收毫秒参数的包级重载，是为了**可测**：单测能拿固定毫秒驱动它，
     * 把「同一毫秒内连发 100 个号」这种在真实时钟上要靠运气才复现的场景变成确定性断言。
     */
    private String generateOrderId() {
        return generateOrderId(System.currentTimeMillis());
    }

    /** 见 {@link #generateOrderId()}：传固定毫秒即可确定性复现「同一毫秒内连发」。 */
    String generateOrderId(long nowMillis) {
        // 前缀为空 → 仍是 20 位的「时间戳 + 实例号 + 2 位序号」，与历史订单号同形
        return orderIds.id("", nowMillis, instanceId);
    }

    private Order requireOrder(String orderId) {
        Order order = orderMapper.selectById(orderId);
        if (order == null) throw BusinessException.notFound("订单不存在");
        return order;
    }

    /**
     * 取消 / 退款后回补库存。
     * <p>
     * 下单走的是「带条件的原子扣减」（见 {@link #createOrder}），回补同理必须由
     * 数据库原子完成 —— 先读后写会在并发下单时把别人刚扣走的库存覆盖回去（超卖）。
     * 回补后若商品是 sold（售罄时自动置的状态），要翻回 on_sale，否则
     * 「库存回来了、商品却永远显示已售出」；翻回前重读再判，避免与并发下单
     * 互相覆盖（刚回补的库存可能已被别人买走）。
     */
    private void restoreStock(Order order) {
        int qty = order.getQuantity() != null && order.getQuantity() > 0 ? order.getQuantity() : 1;
        Goods goods = goodsMapper.selectById(order.getGoodsId());
        if (goods == null) return; // 商品已被删除：无处回补，订单快照仍可对账
        goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                .eq(Goods::getId, goods.getId())
                .setSql("stock = COALESCE(stock, 0) + " + qty)
                .set(Goods::getUpdateTime, LocalDateTime.now()));
        if ("sold".equals(goods.getStatus())) {
            Goods latest = goodsMapper.selectById(goods.getId());
            if (latest != null && "sold".equals(latest.getStatus())
                    && latest.getStock() != null && latest.getStock() > 0) {
                // ★ 只 SET status + update_time ★：整实体回写会把读快照之后
                // 被人买走的库存又变回 latest 里的旧值（超卖）。
                LocalDateTime now = LocalDateTime.now();
                goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                        .eq(Goods::getId, goods.getId())
                        .set(Goods::getStatus, "on_sale")
                        .set(Goods::getUpdateTime, now));
            }
        }
    }

    /**
     * 买家本人校验。
     * <p>
     * ★ 越权防线：付款 / 确认收货都带着「当前登录用户 id」做归属比对。
     * 不比对的话，任何登录用户拿到一个订单号就能替别人付款、替别人确认收货，
     * 一单交易的状态被无关的人推着走。
     */
    private void requireBuyer(Order order, Long userId) {
        if (userId == null || !userId.equals(order.getBuyerId())) {
            throw BusinessException.forbidden("只有买家本人可以操作该订单");
        }
    }

    /** 卖家本人校验：发货只能由该单的卖家执行 */
    private void requireSeller(Order order, Long userId) {
        if (userId == null || !userId.equals(order.getSellerId())) {
            throw BusinessException.forbidden("只有卖家本人可以操作该订单");
        }
    }

    /** 状态机校验：只许顺着走 */
    private void assertTransition(String from, String to) {
        List<String> allowed = TRANSITIONS.get(from);
        if (allowed == null || !allowed.contains(to)) {
            throw BusinessException.of("非法流转：订单当前「" + labelOf(from) + "」，只能推进到「" +
                    (allowed != null && !allowed.isEmpty()
                            ? allowed.stream().map(OrderService::labelOf).collect(Collectors.joining(" / "))
                            : "无（已终结）") + "」");
        }
    }

    /** 记录订单操作日志（状态流转 + 日志在同一个事务里落库） */
    private void recordLog(String orderId, String action, String label,
                            String from, String to, String operator, String role, String note) {
        OrderLog log = new OrderLog();
        log.setOrderId(orderId);
        log.setTime(LocalDateTime.now());
        log.setAction(action);
        log.setActionLabel(label);
        log.setFromStatus(from);
        log.setToStatus(to);
        log.setOperator(operator);
        log.setOperatorRole(role);
        log.setNote(note);
        orderLogMapper.insert(log);
    }

    private void addAuditLog(String action, String label, String target, String detail) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        // 改状态 / 退款是管理员动作，落款记真实操作人而不是一律 admin
        log.setOperator(OperatorContext.currentOperator());
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }
}
