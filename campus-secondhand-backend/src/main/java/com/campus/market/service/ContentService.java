package com.campus.market.service;

import com.campus.market.common.BusinessException;
import com.campus.market.common.OperatorContext;
import com.campus.market.common.Validators;
import com.campus.market.dto.ReportTargetBrief;
import com.campus.market.entity.*;
import com.campus.market.mapper.*;
import com.campus.market.security.AuthSnapshotCache;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 评价 + 留言 + 举报业务逻辑层
 */
@Service
@RequiredArgsConstructor
public class ContentService {

    /** 举报类型的合法取值（与 schema.sql 注释、前端举报页的选项同口径） */
    private static final List<String> REPORT_TYPES = List.of("goods", "user", "order");

    /** 举报处置动作：handle=成立并处置，reject=不成立 */
    private static final List<String> REPORT_ACTIONS = List.of("handle", "reject");

    /** 处置措施白名单（与 applyMeasure 的 switch 分支一一对应） */
    private static final List<String> REPORT_MEASURES = List.of("none", "warn", "off_shelf", "remove", "ban");

    /** 与 schema.sql 的 t_report.reason 严格一致 */
    private static final int REASON_MAX = 200;

    /** 与 schema.sql 的 t_report.remark 严格一致 */
    private static final int REMARK_MAX = 500;

    private final ReviewMapper reviewMapper;
    private final CommentMapper commentMapper;
    private final ReportMapper reportMapper;
    private final AuditLogMapper auditLogMapper;
    private final UserMapper userMapper;
    private final GoodsMapper goodsMapper;
    private final OrderMapper orderMapper;

    /**
     * 鉴权快照缓存（P1-11）。
     * <p>
     * 本类只有一处要失效：举报处置的 {@code case "ban"}。但它**必须**失效 ——
     * 那是全站第二个能把人封禁的入口，漏掉它就等于「从举报后台封人不管用」，
     * 而管理员在后台看到的是「已封禁用户「某某」」，反馈与事实相反。
     */
    private final AuthSnapshotCache authSnapshotCache;

    // ==================== 评价 ====================

    public List<Review> fetchReviewsByGoods(Long goodsId) {
        return reviewMapper.selectByGoods(goodsId);
    }

    public List<Review> fetchReviewsByUser(Long userId) {
        return reviewMapper.selectByUser(userId);
    }

    public Review fetchReviewByOrder(String orderId) {
        return reviewMapper.selectByOrder(orderId);
    }

    /**
     * 提交评价（首评，一单一次）
     * <p>
     * ★ 这里以前是「谁传什么就存什么」★：orderId / goodsId / toUserId 全部采信请求体，
     * 一个登录用户就能拿别人的订单号刷评价、把 toUserId 填成任意用户给他刷差评
     * （评价星级会进信誉分口径）。现在改为以订单为准做三件事：
     * <ol>
     *   <li>订单必须存在，且当前用户是这笔单的买家或卖家（非当事人一律 403）</li>
     *   <li>goodsId 以订单上的为准，请求体里传错也不写脏数据</li>
     *   <li>toUserId 由订单推导（对方当事人），不再采信客户端传值</li>
     * </ol>
     * 另外补了 {@code rating} 为 null 的兜底 —— {@code Math.max(1, null)} 会拆箱 NPE
     * 打到 500，构造一个不带 rating 的请求即可复现。
     */
    @Transactional
    public Map<String, Object> submitReview(Long fromUserId, String orderId, Long goodsId,
                                              Long toUserId, Integer rating, String content) {
        Order order = orderId == null ? null : orderMapper.selectById(orderId);
        if (order == null) throw BusinessException.notFound("订单不存在");
        if (fromUserId == null) throw BusinessException.forbidden("未登录");

        boolean isBuyer = fromUserId.equals(order.getBuyerId());
        boolean isSeller = fromUserId.equals(order.getSellerId());
        if (!isBuyer && !isSeller) {
            throw BusinessException.forbidden("只能评价自己参与的订单");
        }
        if (!"completed".equals(order.getStatus())) {
            throw BusinessException.of("订单完成后才可以评价");
        }
        if (content == null || content.isBlank()) {
            throw BusinessException.paramError("评价内容不能为空");
        }
        String safeContent = Validators.required(content, Validators.TEXT, "评价内容");

        Review exist = reviewMapper.selectByOrder(orderId);
        if (exist != null) {
            return Map.of("ok", false, "duplicate", true);
        }
        User user = userMapper.selectById(fromUserId);
        Review r = new Review();
        r.setOrderId(orderId);
        // 以订单为准，忽略请求体里的 goodsId / toUserId
        r.setGoodsId(order.getGoodsId());
        r.setFromUserId(fromUserId);
        r.setFromUserName(user != null ? user.getNickname() : "匿名用户");
        r.setFromUserAvatar(user != null ? user.getAvatar() : "");
        r.setToUserId(isBuyer ? order.getSellerId() : order.getBuyerId());
        r.setRating(rating == null ? 5 : Math.min(5, Math.max(1, rating)));
        r.setContent(safeContent);
        r.setCreateTime(LocalDateTime.now());
        reviewMapper.insert(r);
        return Map.of("ok", true);
    }

    /**
     * 追加评论（追评，一单一次）
     *
     * @param userId 当前登录用户 —— 只有原评价人本人（或后台）能追评。
     *               原先这个方法没有发起人参数，任何人拿到订单号就能替别人追评。
     */
    @Transactional
    public Map<String, Object> appendReview(String orderId, Long userId, String role, String content) {
        Review r = reviewMapper.selectByOrder(orderId);
        if (r == null) return Map.of("ok", false, "notFound", true);
        // 只有全能 admin 可以代任意用户追评：report_admin / goods_admin 这类「审核角色」职能互斥，
        // 只负责各自业务（举报 / 商品）的审核，不具备评价管理特权。此处口径与
        // OrderService.fetchOrderLogs 上一轮修正保持一致（那里也是只认 admin）。
        boolean admin = "admin".equals(role);
        if (!admin && (userId == null || !userId.equals(r.getFromUserId()))) {
            throw BusinessException.forbidden("只能追加自己的评价");
        }
        if (r.getAppendContent() != null) return Map.of("ok", false, "duplicate", true);
        // 追评列也是 TEXT，同样要一道业务上限（与首评同口径）
        String safeContent = Validators.required(content, Validators.TEXT, "追评内容");
        r.setAppendContent(safeContent);
        r.setAppendTime(LocalDateTime.now());
        reviewMapper.updateById(r);
        return Map.of("ok", true);
    }

    public IPage<Map<String, Object>> fetchAdminReviews(int page, int pageSize, String keyword, Object rating) {
        return reviewMapper.selectAdminReviews(new Page<>(page, pageSize), keyword, rating);
    }

    @Transactional
    public void deleteReview(Long id) {
        reviewMapper.deleteById(id);
    }

    // ==================== 留言 ====================

    public List<Comment> fetchComments(Long goodsId) {
        return commentMapper.selectByGoods(goodsId);
    }

    public IPage<Map<String, Object>> fetchAdminComments(int page, int pageSize, String keyword, Long goodsId) {
        return commentMapper.selectAdminComments(new Page<>(page, pageSize), keyword, goodsId);
    }

    @Transactional
    public Comment postComment(Long userId, Long goodsId, String content, Long parentId) {
        // content 列是 NOT NULL：不拦的话空留言会撞库约束变成 500「服务器内部错误」，
        // 而不是给用户看得懂的 1001 参数错误。列本身是 TEXT，再补一道业务上限 ——
        // 一条几万字的留言会把商品详情页的渲染成本推高一个量级
        String safeContent = Validators.required(content, Validators.TEXT, "留言内容");
        User user = userMapper.selectById(userId);
        Comment c = new Comment();
        c.setGoodsId(goodsId);
        c.setUserId(userId);
        c.setUserName(user != null ? user.getNickname() : "匿名用户");
        c.setUserAvatar(user != null ? user.getAvatar() : "");
        c.setContent(safeContent);
        c.setParentId(parentId);
        if (parentId != null) {
            Comment parent = commentMapper.selectById(parentId);
            if (parent != null) c.setReplyToName(parent.getUserName());
        }
        c.setCreateTime(LocalDateTime.now());
        commentMapper.insert(c);
        return c;
    }

    @Transactional
    public int deleteComment(Long id) {
        Comment target = commentMapper.selectById(id);
        if (target == null) return 0;
        int removed = 1;
        if (target.getParentId() == null) {
            removed += commentMapper.deleteByParentId(id);
        }
        commentMapper.deleteById(id);
        return removed;
    }

    // ==================== 举报 ====================

    @Transactional
    public void submitReport(Long reporterId, String type, Long targetId, String reason, String description) {
        // type 只认三种合法值：脏 type 落库后举报台的类型筛选 / 快照查询全部落空
        if (type == null || !REPORT_TYPES.contains(type)) {
            throw BusinessException.paramError("举报类型不正确");
        }
        // 理由与描述至少要有其一：一张什么都不写的举报单给核实的人留不下任何线索
        if ((reason == null || reason.isBlank()) && (description == null || description.isBlank())) {
            throw BusinessException.paramError("请填写举报理由或详细描述");
        }
        // ★ 落库前先量长度 ★ t_report.reason 是 varchar(200)、description 是 TEXT，
        // 超长会撞 MySQL 严格模式抛 Data too long，用户看到 500 而不是「理由太长了」
        String safeReason = Validators.optional(reason, REASON_MAX, "举报理由");
        String safeDescription = Validators.optional(description, Validators.TEXT, "详细描述");
        Report r = new Report();
        r.setType(type);
        r.setTargetId(targetId);
        r.setReporterId(reporterId);
        r.setReason(safeReason);
        r.setDescription(safeDescription);
        r.setStatus("pending");
        r.setCreateTime(LocalDateTime.now());
        reportMapper.insert(r);
    }

    public IPage<Report> fetchReports(int page, int pageSize, String status, String type) {
        return reportMapper.selectReportPage(new Page<>(page, pageSize), status, type);
    }

    /** 导出上限：列表可以翻页，导出要「当前筛选的全部」（与订单导出同口径） */
    private static final int EXPORT_MAX = 5000;

    /**
     * 举报处理记录导出（全量，带状态 / 类型过滤）。
     * <p>
     * 复用 {@link ReportMapper#selectReportPage}：关闭 count 的宽分页
     * 一条 SQL 拿全量，筛选条件与列表永远同源，不会「列表筛的是 A、导出的是 B」。
     */
    public List<Report> fetchReportsForExport(String status, String type) {
        return reportMapper.selectReportPage(new Page<>(1, EXPORT_MAX, false), status, type)
                .getRecords();
    }

    public Map<String, Object> fetchReportStats() {
        return reportMapper.selectReportStats();
    }

    /**
     * 处理 / 驳回举报 —— ★ 事务程序 ★
     * <p>
     * 处理措施带真实副作用：
     *  - warn: 扣减被举报方 5 点信用分
     *  - off_shelf: 下架被举报商品
     *  - remove: 删除被举报商品
     *  - ban: 封禁被举报用户
     *  - none: 驳回，不做处置
     */
    @Transactional
    public void resolveReport(Long reportId, String action, String measure, String remark, String operator) {
        /*
         * ★ 为什么 action 必须先收敛到白名单 ★
         * 原先用 `"reject".equals(action) ? "none" : measure` 三元判断，只区分
         * 「是 reject」和「不是 reject」两种。于是任何拼错的 action（前端旧版本传的
         * "resolve"、或者手工构造的任意字符串）都会落进后半段被当成「举报成立」，
         * 而 measure 缺省值是 warn —— 一个拼错的动作会 **静默扣掉被举报人 5 点信用分**，
         * 还在处置记录里留成一条正常结论。这个副作用不报错，只会悄悄改数据。
         */
        Validators.oneOf(action, REPORT_ACTIONS, "处置动作");
        if (action == null) throw BusinessException.paramError("缺少处置动作");
        // measure 同理：t_report.measure 是 varchar(20) 且数据库层无任何约束，
        // 写入「不存在的措施」后，处置措施的筛选与导出都会对不上号
        Validators.oneOf(measure, REPORT_MEASURES, "处置措施");

        Report r = reportMapper.selectById(reportId);
        if (r == null) throw BusinessException.notFound("举报记录不存在");
        if (!"pending".equals(r.getStatus())) throw BusinessException.of("该举报已处理过，不能重复处置");

        // ★ remark 列是 varchar(500) ★：超长会在 updateById 那一刻抛 Data too long，
        // 连同状态变更一起回滚 —— 举报台表现是「点了处理没反应，只弹服务器内部错误」
        String safeRemark = Validators.optional(remark, REMARK_MAX, "处置备注");

        String actualMeasure = "reject".equals(action) ? "none" : (measure != null ? measure : "warn");
        String nextStatus = "handle".equals(action) ? "handled" : "rejected";

        /*
         * ★ 先「抢占」状态，再产生副作用 ★
         * 原先是「select 判断 pending → 执行副作用（扣信用分 / 封禁 / 下架）→ 回写状态」，
         * 典型的 check-then-act：两个请求同时通过判断时，**副作用会各执行一次**
         * —— 同一条举报被扣两次信用分、或者被连着封两次。
         * 现在把「状态从 pending 改走」做成一条**带条件的 UPDATE** 并检查影响行数：
         * 只有一个请求能拿到 1 行，其余的拿到 0 行直接抛错。
         * 于是「副作用只可能由抢占成功的那一个请求执行」成为**硬保证**，
         * 而不是靠「先查一下应该没问题」的时序假设。
         */
        int claimed = reportMapper.update(null, new LambdaUpdateWrapper<Report>()
                .eq(Report::getId, reportId)
                .eq(Report::getStatus, "pending")
                .set(Report::getStatus, nextStatus)
                .set(Report::getMeasure, actualMeasure)
                .set(Report::getRemark, safeRemark)
                .set(Report::getHandleTime, LocalDateTime.now())
                .set(Report::getHandledBy, operator));
        if (claimed != 1) {
            // 抢占失败 = 另一个请求已经改走了状态。此时绝不能继续往下走。
            throw BusinessException.of("该举报已被其他人处理，请刷新后重试");
        }

        // —— 以下副作用只会在抢占成功后执行 ——
        String effect = "reject".equals(action) ? "举报不成立，未做处置" : applyMeasure(r, actualMeasure);

        // outcome 依赖 applyMeasure 的返回值（里面带着真实结果，如封禁了谁、下架了哪件商品），
        // 而抢占那条 UPDATE 必须先于副作用执行，所以用第二条 UPDATE 把 outcome 补上（仍只针对这一行）
        reportMapper.update(null, new LambdaUpdateWrapper<Report>()
                .eq(Report::getId, reportId)
                .set(Report::getOutcome, effect));

        addAuditLog("handle".equals(action) ? "report.handle" : "report.reject",
                "handle".equals(action) ? "处理举报" : "驳回举报",
                "举报 #" + reportId, effect);
    }

    /**
     * 批量处理 / 驳回举报
     * <p>
     * 逐条走 {@link #resolveReport}：批量不等于「统一结论」，
     * 每条举报处置完都会在自身的 outcome 里留下各自的处置说明；
     * 已处理过的记录会被跳过（幂等），不会把上一次的结论覆盖掉。
     *
     * @return 实际被处理的条数
     */
    @Transactional
    public int batchResolveReports(List<Long> ids, String action, String measure, String remark, String operator) {
        if (ids == null || ids.isEmpty()) return 0;
        List<Report> targets = reportMapper.selectBatchIds(ids).stream()
                .filter(r -> "pending".equals(r.getStatus()))
                .toList();
        if (targets.isEmpty()) return 0;
        for (Report r : targets) {
            resolveReport(r.getId(), action, measure, remark, operator);
        }
        // 汇总一条审计流水：详情里带上每条的结论（去重，避免 10 条同样的话刷屏）
        List<String> outcomes = new ArrayList<>();
        int handled = 0;
        for (Long id : targets.stream().map(Report::getId).toList()) {
            Report r = reportMapper.selectById(id);
            if (r != null && r.getOutcome() != null && !outcomes.contains(r.getOutcome())) {
                outcomes.add(r.getOutcome());
            }
            if (r != null && ("handled".equals(r.getStatus()) || "rejected".equals(r.getStatus()))) handled++;
        }
        addAuditLog("handle".equals(action) ? "report.batchHandle" : "report.batchReject",
                "handle".equals(action) ? "批量处理举报" : "批量驳回举报",
                targets.size() + " 条举报",
                String.join("；", outcomes) + "；ID：" + targets.stream().map(Report::getId).toList()
                        + (remark != null && !remark.isBlank() ? "；备注：" + remark : ""));
        return handled;
    }

    /**
     * 被举报对象现状快照
     * <p>
     * 处理举报不能只看举报文案：必须能当场看到被举报对象**现在**是什么状态
     * （商品还在不在架、卖家信用分多少、描述与图片是否自相矛盾），处置决定才有依据。
     * 对象已被删除时也返回一条 exists=false 的说明，前端照样能渲染。
     */
    public ReportTargetBrief fetchReportTargetBrief(String type, Long targetId) {
        return switch (type == null ? "" : type) {
            case "goods" -> goodsBrief(targetId);
            case "user" -> userBrief(targetId);
            case "order" -> orderBrief(targetId);
            default -> {
                ReportTargetBrief brief = new ReportTargetBrief();
                brief.setExists(false);
                brief.setTitle("未知举报类型：" + type);
                brief.setStatusLabel("无法核实");
                brief.setStatusType("danger");
                yield brief;
            }
        };
    }

    private ReportTargetBrief goodsBrief(Long id) {
        Goods g = goodsMapper.selectById(id);
        if (g == null) {
            return missing("商品 #" + id + "（已删除）", "不存在");
        }
        Map<String, String[]> status = Map.of(
                "on_sale", new String[]{"在售中", "success"},
                "off_shelf", new String[]{"已下架", "info"},
                "sold", new String[]{"已售出", "info"},
                "pending", new String[]{"审核中", "warning"});
        String[] st = status.getOrDefault(g.getStatus(), new String[]{g.getStatus(), "info"});

        ReportTargetBrief b = new ReportTargetBrief();
        b.setExists(true);
        b.setTitle(g.getTitle());
        b.setStatusLabel(st[0]);
        b.setStatusType(st[1]);
        b.setSellerName(g.getSellerName());
        b.setCover(g.getCover());
        b.setPrice(g.getPromoPrice() != null ? g.getPromoPrice() : g.getPrice());
        // 完整商品档案：核实「虚假描述 / 违规商品」要能看到全部证据
        b.setListPrice(g.getPrice());
        b.setPromoPrice(g.getPromoPrice());
        b.setDescription(g.getDescription());
        b.setCategoryName(g.getCategoryName());
        b.setLocation(g.getLocation());
        b.setStock(g.getStock());
        b.setDeliveryMethod(g.getDeliveryMethod());
        b.setCreateTime(g.getCreateTime());
        b.setViewCount(g.getViewCount());
        b.setFavoriteCount(g.getFavoriteCount());
        List<String> images = new ArrayList<>();
        if (g.getCover() != null && !g.getCover().isBlank()) images.add(g.getCover());
        if (g.getImages() != null) {
            g.getImages().stream().filter(i -> i != null && !i.isBlank()).forEach(images::add);
        }
        b.setImages(images.stream().distinct().toList());
        return b;
    }

    private ReportTargetBrief userBrief(Long id) {
        User u = userMapper.selectById(id);
        if (u == null) {
            return missing("用户 #" + id + "（已注销）", "不存在");
        }
        String status = u.getStatus() == null ? "active" : u.getStatus();
        Map<String, String[]> map = Map.of(
                "banned", new String[]{"已封禁", "danger"},
                "pending", new String[]{"待审核", "warning"},
                "active", new String[]{"正常", "success"});
        String[] st = map.getOrDefault(status, new String[]{status, "info"});

        ReportTargetBrief b = new ReportTargetBrief();
        b.setExists(true);
        b.setTitle(u.getNickname());
        b.setAvatar(u.getAvatar());
        b.setStatusLabel(st[0]);
        b.setStatusType(st[1]);
        b.setCreditScore(u.getCreditScore());
        return b;
    }

    private ReportTargetBrief orderBrief(Long id) {
        // 订单号是 VARCHAR，历史数据既有纯数字也有 ORD00012 形态，两种都试
        Order o = orderMapper.selectById(String.valueOf(id));
        if (o == null) {
            o = orderMapper.selectById(String.format("ORD%05d", id));
        }
        if (o == null) {
            return missing("订单 #" + id, "未找到该订单");
        }
        Map<String, String[]> map = Map.of(
                "pending_payment", new String[]{"待付款", "warning"},
                "pending_ship", new String[]{"待发货", "warning"},
                "shipped", new String[]{"已发货", "info"},
                "received", new String[]{"已收货", "info"},
                "completed", new String[]{"已完成", "success"},
                "refunding", new String[]{"退款中", "warning"},
                "cancelled", new String[]{"已取消", "info"});
        String[] st = map.getOrDefault(o.getStatus(), new String[]{o.getStatus(), "info"});

        ReportTargetBrief b = new ReportTargetBrief();
        b.setExists(true);
        b.setTitle(o.getId());
        b.setStatusLabel(st[0]);
        b.setStatusType(st[1]);
        b.setSellerName(o.getSellerName());
        b.setBuyerName(o.getBuyerName());
        b.setPrice(o.getAmount());
        return b;
    }

    private ReportTargetBrief missing(String title, String label) {
        ReportTargetBrief b = new ReportTargetBrief();
        b.setExists(false);
        b.setTitle(title);
        b.setStatusLabel(label);
        b.setStatusType("danger");
        return b;
    }

    /** 施加处理措施的真实副作用 */
    private String applyMeasure(Report report, String measure) {        switch (measure) {
            case "warn": {
                Long userId = resolveTargetUserId(report);
                if (userId != null) {
                    User u = userMapper.selectById(userId);
                    if (u != null) {
                        /*
                         * ★ 信用分必须用原子 UPDATE 扣，不能在 Java 里「读-改-写」★
                         * 原先是 selectById 读出整行 → 在内存里减 5 → updateById 整体回写。
                         * 两个管理员同时处置两条举报时，后写的那次会拿**自己读到的旧分数**覆盖前一次，
                         * 表现成「处置了两条，只扣了一次分」。扣分是累积副作用，丢了不会报错、
                         * 也没有任何日志对不上，属于最难发现的并发缺陷。
                         * 交给数据库执行 credit_score = GREATEST(0, credit_score - 5) 才是原子的；
                         * GREATEST(0, ...) 同时保住原来 Math.max(0, ...) 的「分数不为负」语义。
                         */
                        userMapper.update(null, new LambdaUpdateWrapper<User>()
                                .eq(User::getId, userId)
                                .setSql("credit_score = GREATEST(0, credit_score - 5)"));
                        // 重新读一次拿真实分数：给用户看的文案必须与库里实际值一致
                        User after = userMapper.selectById(userId);
                        int score = after != null ? after.getCreditScore() : 0;
                        return "已向「" + u.getNickname() + "」发出警示，信用分扣减至 " + score;
                    }
                }
                return "已发出警示（未匹配到责任用户）";
            }
            case "off_shelf": {
                Goods g = goodsMapper.selectById(report.getTargetId());
                if (g == null) return "目标商品已不存在，未执行下架";
                // 只写要改的两列。updateById 会把**整个实体快照**回写，
                // 顺手把并发的收藏数/浏览量改动覆盖掉 —— 与本方法 warn 分支同一类问题。
                goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                        .eq(Goods::getId, report.getTargetId())
                        .set(Goods::getStatus, "off_shelf")
                        .set(Goods::getUpdateTime, LocalDateTime.now()));
                return "已下架商品《" + g.getTitle() + "》";
            }
            case "remove": {
                Goods g = goodsMapper.selectById(report.getTargetId());
                if (g == null) return "目标商品已不存在，未执行删除";
                goodsMapper.deleteById(report.getTargetId());
                return "已删除商品《" + g.getTitle() + "》";
            }
            case "ban": {
                Long userId = resolveTargetUserId(report);
                if (userId != null) {
                    User u = userMapper.selectById(userId);
                    if (u != null) {
                        // 只写 status 一列：封禁不该顺手覆盖同一行上并发的信用分变动
                        userMapper.update(null, new LambdaUpdateWrapper<User>()
                                .eq(User::getId, userId)
                                .set(User::getStatus, "banned"));
                        // ★ P1-11：封禁当场生效（第二个封禁入口，别以为只有 UserService 会封人）★
                        authSnapshotCache.invalidate(userId);
                        return "已封禁用户「" + u.getNickname() + "」";
                    }
                }
                return "目标用户已不存在，未执行封禁";
            }
            default:
                return "未做处置（仅记录结论）";
        }
    }

    /** 责任方：商品类举报找卖家，用户类举报就是本人，订单类举报找卖家 */
    private Long resolveTargetUserId(Report report) {
        if ("goods".equals(report.getType())) {
            Goods g = goodsMapper.selectById(report.getTargetId());
            return g != null ? g.getSellerId() : null;
        }
        return report.getTargetId();
    }

    private void addAuditLog(String action, String label, String target, String detail) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        // 处置人从请求上下文取真实用户名，不再一律记 admin
        log.setOperator(OperatorContext.currentOperator());
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }
}
