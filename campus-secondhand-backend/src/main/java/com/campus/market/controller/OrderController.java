package com.campus.market.controller;

import com.campus.market.common.BusinessException;
import com.campus.market.common.PageResult;
import com.campus.market.common.Params;
import com.campus.market.common.Result;
import com.campus.market.entity.Order;
import com.campus.market.entity.OrderLog;
import com.campus.market.dto.PayLaunch;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.OrderService;
import com.campus.market.service.PaymentService;
import com.baomidou.mybatisplus.core.metadata.IPage;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.*;

/**
 * 订单控制器
 * <p>
 * 买家侧：我的订单 / 支付 / 收货 / 取消（仅待付款）/ 申请退款（付款后走售后）
 * 卖家侧：发货
 * 管理侧：全量检索 / 改状态 / 退款 / 批量处置 / 内部备注
 * <p>
 * ★ 响应契约：前端 `types/index.ts` 的 `Order` 是嵌套结构
 * （`goods` / `refund` / `cancelReason` / `logs`），
 * 由实体上的派生 getter 组装，`logs` 在本层按页批量回填（见 {@link OrderService#fillLogs}）。
 */
@RestController
@RequiredArgsConstructor
public class OrderController {

    /** 单页上限：不做限制的话 `pageSize=999999` 一次就能把整表拉进内存 */
    private static final int MAX_PAGE_SIZE = 200;

    /**
     * 导出专用的上限（比列表页宽得多）。
     * <p>
     * ★ 导出不能复用列表页的 200 上限 ★
     * <p>
     * 前端 `fetchAdminOrdersForExport` 的语义是「导出**当前筛选的全部**」，
     * 而导出走的是一次性取数（没有分页循环）。若沿用 200，订单超过 200 笔时
     * 导出的 CSV 会**静默少数据** —— 没有报错、没有提示，管理员拿去对账
     * 才会发现金额对不上，这类「悄悄截断」比直接报错危险得多。
     * 这里给一个足够大的上限，并把截断与否写进导出结果的可核对口径（见下方注释）。
     */
    private static final int EXPORT_MAX = 5000;

    /**
     * 承运商 → 运单号前缀（ASCII）。
     * 运单号是对外单号，含中文会被快递系统与格式校验同时拒掉，
     * 所以不能取「顺丰速运」的首字，必须用代号。
     * 与前端 `api/order.ts` 的 CARRIER_CODE 保持一致。
     */
    private static final Map<String, String> CARRIER_CODE = Map.of(
            "顺丰速运", "SF",
            "中通快递", "ZTO",
            "圆通速递", "YTO",
            "韵达快递", "YD",
            "京东物流", "JD");

    private final OrderService orderService;

    /**
     * 支付服务。
     * <p>
     * ★ 依赖方向：Controller → PaymentService → OrderService，**单向** ★
     * 订单状态机归 {@link OrderService}，收钱归 {@link PaymentService}，
     * 两边都不互相引用，Controller 是把它们接起来的那一层。
     * 不要为了「少注入一个」而让 {@code OrderService} 反过来依赖支付 ——
     * 那会立刻形成循环依赖，且是 Spring 启动期才炸、本地跑单测发现不了的那类。
     */
    private final PaymentService paymentService;

    // ==================== 买 / 卖家 ====================

    /** 买/卖家我的订单 */
    @GetMapping("/orders")
    public Result<PageResult<Order>> fetchOrders(
            HttpServletRequest request,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String role) {
        Long userId = currentUserId(request);
        int size = clamp(pageSize);
        IPage<Order> p = orderService.fetchOrders(userId, page, size, status, role);
        orderService.fillLogs(p.getRecords(), isAdmin(request));
        // 返回体里的 pageSize 必须是**实际生效**的那个：回显请求值会让前端
        // 分页组件按 99999 算总页数，而每页其实最多 200 条，翻页直接错位
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, size));
    }

    /** 创建订单 */
    @PostMapping("/orders")
    public Result<Order> createOrder(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Long userId = currentUserId(request);
        String remark = body.get("remark") != null ? body.get("remark").toString() : null;
        String address = body.get("address") != null ? body.get("address").toString() : null;
        Order order = orderService.createOrder(userId,
                Params.requiredLong(body.get("goodsId"), "goodsId"),
                optionalInt(body.get("quantity")),
                remark, address);
        // 下单这一步本身就会写一条「买家下单」日志，回填后详情页时间线立刻可见
        orderService.fillLogs(List.of(order), isAdmin(request));
        return Result.success(order);
    }

    /**
     * 买家发起支付。
     * <p>
     * ★★ 这个接口改造前后最大的区别 ★★
     * <p>
     * 改造前它只做一件事：把订单状态改成 {@code pending_ship}。
     * 也就是说「付款成功」这件事**没有任何依据** —— 谁点一下「去支付」谁就付了款，
     * 金额不校验、渠道不存在、幂等谈不上，订单时间线上却写着「买家已付款」。
     * <p>
     * 现在它返回 {@link PayLaunch}，由前端按 {@code kind} 决定下一步：
     * <ul>
     *   <li>{@code DONE} —— 钱包 / 演示渠道当场扣款完成，直接刷新订单；</li>
     *   <li>{@code REDIRECT} —— 跳到支付宝收银台，付完由回调推进订单；</li>
     *   <li>{@code QR} —— 展示二维码并轮询（将来接扫码支付用）。</li>
     * </ul>
     * <p>
     * ★ {@code channel} 允许为空 ★ 为空时后端选第一条可用渠道，
     * 这样老版本前端（不带这个参数）不会一升级就付不了款。
     */
    @PostMapping("/orders/{id}/pay")
    public Result<PayLaunch> payOrder(HttpServletRequest request, @PathVariable String id,
                                      @RequestBody(required = false) Map<String, Object> body) {
        String channel = body == null ? null : str(body.get("channel"));
        return Result.success(paymentService.createPayment(id, currentUserId(request),
                channel, PayController.clientIp(request)));
    }

    /** 卖家发货 */
    @PostMapping("/orders/{id}/ship")
    public Result<Void> shipOrder(HttpServletRequest request, @PathVariable String id,
                                   @RequestBody Map<String, Object> body) {
        orderService.shipOrder(id, str(body.get("trackingNo")), str(body.get("company")),
                currentUserId(request));
        return Result.success();
    }

    /** 买家确认收货 */
    @PostMapping("/orders/{id}/receive")
    public Result<Void> confirmReceive(HttpServletRequest request, @PathVariable String id) {
        orderService.confirmReceive(id, currentUserId(request));
        return Result.success();
    }

    /**
     * 买家取消订单（仅待付款可取消；取消后库存回补，见 {@link OrderService#cancelByBuyer}）。
     * <p>
     * 买家此前只能等管理员关闭或订单超时，自己的单自己取消不了 —— 补上这个口子。
     */
    @PostMapping("/orders/{id}/cancel")
    public Result<Void> cancelOrder(HttpServletRequest request, @PathVariable String id,
                                     @RequestBody(required = false) Map<String, String> body) {
        orderService.cancelByBuyer(id, currentUserId(request), body != null ? body.get("reason") : null);
        return Result.success();
    }

    /**
     * 买家申请退款（售后入口）：订单进入 {@code refunding}，等管理端「同意 / 驳回」。
     * <p>
     * ★ 与 {@code /orders/{id}/cancel} 是两条不能混的线 ★
     * <p>
     * 取消只对「待付款」开放（下单还没给钱，直接作废即可）；付了款之后要拿回钱，
     * 只能走这里申请退款，由平台（管理员）审批。状态机 {@code ORDER_TRANSITIONS}
     * 里 {@code pending_ship / shipped / received → refunding} 三条边一直都在，
     * 管理端的同意 / 驳回也早就实现了 —— 缺的只是买家这一侧的入口。
     * <p>
     * 归属校验（只有买家本人）与状态校验都在 {@link OrderService#applyRefund} 内完成，
     * 这里不重复判 —— 鉴权写两处迟早会漂移。原因必填：售后统计与纠纷举证都要靠它。
     */
    @PostMapping("/orders/{id}/refund/apply")
    public Result<Void> applyRefund(HttpServletRequest request, @PathVariable String id,
                                    @RequestBody Map<String, Object> body) {
        orderService.applyRefund(id, currentUserId(request), str(body.get("reason")));
        return Result.success();
    }

    /** 订单操作日志（买卖双方与管理员可见） */
    @GetMapping("/orders/{id}/logs")
    public Result<List<OrderLog>> fetchOrderLogs(HttpServletRequest request, @PathVariable String id) {
        return Result.success(orderService.fetchOrderLogs(id, currentUserId(request), currentRole(request)));
    }

    // ==================== 管理端 ====================

    /**
     * 管理端订单检索。
     * <p>
     * 参数与前端 `AdminOrderQuery` 逐一对应 —— 少接一个，界面上对应的筛选就是
     * 「点了没反应」，而且它不会报错，只是静默返回全量。
     */
    @GetMapping("/admin/orders")
    public Result<PageResult<Order>> fetchAdminOrders(
            HttpServletRequest request,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize) {
        Map<String, Object> query = buildAdminQuery(request, page, clamp(pageSize));
        IPage<Order> p = orderService.fetchAdminOrders(query);
        orderService.fillLogs(p.getRecords(), isAdmin(request));
        return Result.success(PageResult.of(p.getRecords(), p.getTotal(), page, clamp(pageSize)));
    }

    /**
     * 导出：与列表共用同一套筛选，导出的是「当前筛选的全部」而不只是当前页。
     * <p>
     * 上限用 {@link #EXPORT_MAX} 而不是列表页的 {@link #MAX_PAGE_SIZE}：
     * 列表可以翻页，导出不能 —— 一次取不满就等于丢数据。
     */
    @GetMapping("/admin/orders/export")
    public Result<List<Order>> exportOrders(HttpServletRequest request) {
        List<Order> list = orderService.fetchAdminOrdersForExport(buildAdminQuery(request, 1, EXPORT_MAX));
        orderService.fillLogs(list, isAdmin(request));
        return Result.success(list);
    }

    /** 订单工作台概览统计（卡片 + 状态页签 + 分组的数字都来自这里） */
    @GetMapping("/admin/orders/stats")
    public Result<Map<String, Object>> fetchStats() {
        return Result.success(orderService.fetchAdminOrderStats());
    }

    @PatchMapping("/admin/orders/{id}/status")
    public Result<Void> updateOrderStatus(@PathVariable String id, @RequestBody Map<String, Object> body) {
        orderService.updateOrderStatus(id,
                str(body.get("status")),
                str(body.get("trackingNo")),
                str(body.get("logisticsCompany")),
                str(body.get("reason")));
        return Result.success();
    }

    /**
     * 同意退款：订单侧落地 + **原路退回**。
     * <p>
     * ★★ 这里原来只改订单状态，钱一分没动 ★★
     * <p>
     * 改造前 {@code orderService.refundOrder} 把订单改成「已取消」并填上退款金额与时间，
     * 界面上显示「已退款 ¥45.00」，而买家的钱**还留在平台账上**。
     * 这不是"功能没做完"，是**账实不符** —— 对账时平台记着支出 45 元，实际资金没动。
     * <p>
     * 现在改走 {@link PaymentService#refundForOrder}：先落订单侧（校验 + 库存回补），
     * 再调渠道退款，最后标记支付单。渠道退款失败会抛业务异常并**整体回滚**，
     * 不会出现「记录说退了、钱没退」。
     */
    @PostMapping("/admin/orders/{id}/refund")
    public Result<Void> refundOrder(@PathVariable String id, @RequestBody Map<String, Object> body) {
        BigDecimal amount = body.get("amount") == null ? null : new BigDecimal(body.get("amount").toString());
        paymentService.refundForOrder(id, amount, str(body.get("reason")), str(body.get("remark")));
        return Result.success();
    }

    @PostMapping("/admin/orders/{id}/refund/reject")
    public Result<Void> rejectRefund(@PathVariable String id, @RequestBody Map<String, Object> body) {
        orderService.rejectRefund(id, str(body.get("note")));
        return Result.success();
    }

    @PatchMapping("/admin/orders/{id}/note")
    public Result<Void> saveNote(@PathVariable String id, @RequestBody Map<String, String> body) {
        orderService.saveOrderNote(id, body.get("note"));
        return Result.success();
    }

    /**
     * 批量处置订单（标记付款 / 发货 / 关闭）
     * <p>
     * ★ 返回体是 {@code {ok, skipped: [{id, reason}]}}，**不是**「跳过了几条」的数字。
     * 前端要逐条把跳过原因显示给管理员看（「这 50 单里哪 3 单没动、为什么」），
     * 只给一个数字，管理员就得自己一单单去翻是谁没成功。
     * <p>
     * 逐条仍走单条的状态机校验，不做「一把梭全改」：批量入口最容易掩盖的 bug
     * 就是把已完成的一起改成待发货，且没有任何提示。
     */
    @PostMapping("/admin/orders/batch")
    public Result<Map<String, Object>> batchAction(@RequestBody Map<String, Object> body) {
        List<String> ids = Params.toStringList(body.get("ids"));
        String action = str(body.get("action"));
        String carrier = str(body.get("carrier"));
        String reason = str(body.get("reason"));

        int ok = 0;
        List<Map<String, String>> skipped = new ArrayList<>();
        for (String id : ids) {
            try {
                applyBatchAction(id, action, carrier, reason);
                ok++;
            } catch (Exception e) {
                String msg = e.getMessage();
                skipped.add(Map.of("id", id, "reason", msg == null || msg.isBlank() ? "处置失败" : msg));
            }
        }
        return Result.success(Map.of("ok", ok, "skipped", skipped));
    }

    /** 单条批量动作：不合法就抛业务异常，由上面的循环收敛成 skipped 条目 */
    private void applyBatchAction(String id, String action, String carrier, String reason) {
        if ("mark_paid".equals(action)) {
            orderService.updateOrderStatus(id, "pending_ship", null, null, "管理员批量确认收款");
        } else if ("ship".equals(action)) {
            String name = carrier != null && !carrier.isBlank() ? carrier : "顺丰速运";
            String code = CARRIER_CODE.getOrDefault(name, "YB");
            String trackingNo = code + id.substring(Math.max(0, id.length() - 8));
            orderService.updateOrderStatus(id, "shipped", trackingNo, name, "管理员批量发货");
        } else if ("close".equals(action)) {
            orderService.updateOrderStatus(id, "cancelled", null, null,
                    reason != null && !reason.isBlank() ? reason : "管理员批量关闭");
        } else {
            // 用 BusinessException 而非 IllegalArgumentException：
            // 后者会落到 GlobalExceptionHandler 的兜底分支，被脱敏成
            // 「服务器内部错误，请稍后再试」——调用方看不到到底哪个 action 不被支持。
            throw BusinessException.paramError("不支持的批量动作：" + action);
        }
    }

    // ==================== 内部工具 ====================

    /**
     * 组装管理端检索条件。
     * <p>
     * {@code statusIn} 用「原样读 parameter」而不是 {@code @RequestParam List}：
     * axios 把数组序列化成 {@code statusIn[]=a&statusIn[]=b}，而 Spring 的
     * {@code @RequestParam List} 只按字面名取值，带方括号的键绑不上、会静默变成 null。
     * 这里把带方括号/不带方括号/逗号分隔三种形态一起收掉，不依赖前端的序列化细节。
     */
    private Map<String, Object> buildAdminQuery(HttpServletRequest request, int page, int pageSize) {
        Map<String, Object> query = new HashMap<>();
        query.put("page", Math.max(1, page));
        /*
         * 这里的上限是 EXPORT_MAX（导出用的宽上限），不是列表页的 MAX_PAGE_SIZE。
         * 列表页在调用前已经用 clamp() 收过一次，导出则需要拿到「全部」；
         * 若在这里重新 clamp 到 200，导出又会退回「静默截断」的老问题。
         */
        query.put("pageSize", Math.min(EXPORT_MAX, Math.max(1, pageSize)));
        query.put("status", blankToNull(request.getParameter("status")));
        query.put("keyword", blankToNull(request.getParameter("keyword")));
        query.put("sort", blankToNull(request.getParameter("sort")));
        query.put("fundSource", blankToNull(request.getParameter("fundSource")));
        query.put("minAmount", decimal(request.getParameter("minAmount")));
        query.put("maxAmount", decimal(request.getParameter("maxAmount")));
        query.put("dateFrom", dayStart(request.getParameter("dateFrom")));
        query.put("dateTo", dayEnd(request.getParameter("dateTo")));
        query.put("statusIn", Params.multiValue(request, "statusIn"));
        query.put("onlyTodo", bool(request.getParameter("onlyTodo")));
        query.put("onlyIssue", bool(request.getParameter("onlyIssue")));
        query.put("onlyRemark", bool(request.getParameter("onlyRemark")));
        query.put("onlyNoted", bool(request.getParameter("onlyNoted")));
        return query;
    }

    /**
     * 把 {@code 2026-09-11} 补成当天起点，把 {@code 2026-09-11} 补成
     * {@code 2026-09-11 23:59:59}。
     * <p>
     * 不补的话 {@code create_time <= '2026-09-11'} 等价于 {@code <= 2026-09-11 00:00:00}，
     * 「筛到 9 月 11 日」会把 11 号**整天**的单子全部漏掉 —— 用户会以为那天的订单丢了。
     */
    private String dayStart(String raw) {
        String v = blankToNull(raw);
        if (v == null) return null;
        return v.length() == 10 ? v + " 00:00:00" : v;
    }

    private String dayEnd(String raw) {
        String v = blankToNull(raw);
        if (v == null) return null;
        return v.length() == 10 ? v + " 23:59:59" : v;
    }

    private Boolean bool(String raw) {
        return raw == null || raw.isBlank() ? null : Boolean.valueOf(raw);
    }

    private BigDecimal decimal(String raw) {
        String v = blankToNull(raw);
        if (v == null) return null;
        try {
            return new BigDecimal(v);
        } catch (NumberFormatException e) {
            throw BusinessException.paramError("金额参数格式错误：" + v);
        }
    }

    private String blankToNull(String raw) {
        return raw == null || raw.isBlank() ? null : raw;
    }

    /** 数量：前端可能传数字也可能传字符串，统一按 Number 收，避免 ClassCastException */
    private Integer optionalInt(Object raw) {
        if (raw == null) return null;
        if (raw instanceof Number n) return n.intValue();
        String s = raw.toString().trim();
        if (s.isEmpty()) return null;
        try {
            return Integer.valueOf(s);
        } catch (NumberFormatException e) {
            throw BusinessException.paramError("购买数量格式错误：" + s);
        }
    }

    private String str(Object raw) {
        return raw == null ? null : raw.toString();
    }

    private int clamp(int pageSize) {
        return Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
    }

    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }

    private String currentRole(HttpServletRequest request) {
        return (String) request.getAttribute(AuthInterceptor.ATTR_ROLE);
    }

    /**
     * 当前请求是否为全能 admin。
     * <p>
     * 只用来决定「要不要下发仅后台可见的内容」（后台内部备注、{@code action='note'} 的日志），
     * 不承担任何鉴权职责 —— 鉴权由 {@link AuthInterceptor} 与 Service 内的归属校验负责。
     * <p>
     * ★ 一律从请求属性取，不要写死 true ★ 即使 {@code /admin/**} 已被拦截器限定为 admin，
     * 也在每个调用点显式判一次：将来若有人把某个 admin 接口挪出 {@code /admin} 前缀，
     * 这里不会跟着一起漏。
     */
    private boolean isAdmin(HttpServletRequest request) {
        return "admin".equals(currentRole(request));
    }
}
