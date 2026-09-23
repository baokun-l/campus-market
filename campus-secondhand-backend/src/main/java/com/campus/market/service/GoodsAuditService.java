package com.campus.market.service;

import com.campus.market.common.BusinessException;
import com.campus.market.common.OperatorContext;
import com.campus.market.common.Validators;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.GoodsAuditRecord;
import com.campus.market.entity.Goods;
import com.campus.market.entity.User;
import com.campus.market.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 商品审核业务逻辑层
 * <p>
 * 职能边界（只做三件事）：
 *  ① 查看待审核商品列表
 *  ② 通过（→ on_sale）/ 驳回（→ off_shelf，理由必填 ≥ 5 字）
 *  ③ 查看审核记录
 */
@Service
@RequiredArgsConstructor
public class GoodsAuditService {

    /** 与 schema.sql 的 t_goods_audit_record.reason varchar(500) 严格一致 */
    private static final int REASON_MAX = 500;

    /** 驳回理由下限：太短的理由卖家看不出差在哪里 */
    private static final int REASON_MIN = 5;

    /** 审核动作白名单：不收敛的话，任何拼错的 action 都会落进「非 approve 即驳回」的 else 分支 */
    private static final List<String> ACTIONS = List.of("approve", "reject");

    private final GoodsMapper goodsMapper;
    private final UserMapper userMapper;
    private final GoodsAuditRecordMapper auditRecordMapper;
    private final AuditLogMapper auditLogMapper;

    public IPage<Goods> fetchPendingGoods(int page, int pageSize, String keyword) {
        LambdaQueryWrapper<Goods> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(Goods::getStatus, "pending");
        /*
         * ★ 关键词必须整体括起来（`and(w -> ...)`）。
         * 直接写 `wrapper.like(title).or().like(sellerName)` 拼出来的是
         * `status = 'pending' AND title LIKE ? OR seller_name LIKE ?` ——
         * SQL 里 AND 优先级高于 OR，等于 `(status='pending' AND title LIKE ?) OR seller_name LIKE ?`，
         * 后半段把状态条件整个绕开：审核员输入卖家名，会看到该卖家**在售/已下架**的商品，
         * 而列表上写着「待审核」。用户以为筛选坏了，实际是漏了括号。
         */
        if (keyword != null && !keyword.isBlank()) {
            wrapper.and(w -> w.like(Goods::getTitle, keyword).or().like(Goods::getSellerName, keyword));
        }
        wrapper.orderByDesc(Goods::getCreateTime);
        return goodsMapper.selectPage(new Page<>(page, pageSize), wrapper);
    }

    public Map<String, Object> fetchAuditDetail(Long goodsId) {
        Goods g = goodsMapper.selectById(goodsId);
        if (g == null) throw BusinessException.notFound("商品不存在");
        User seller = userMapper.selectById(g.getSellerId());
        Map<String, Object> result = new HashMap<>();
        result.put("goods", g);

        long onSaleCount = goodsMapper.selectCount(
                new LambdaQueryWrapper<Goods>()
                        .eq(Goods::getSellerId, g.getSellerId())
                        .eq(Goods::getStatus, "on_sale"));
        Map<String, Object> sellerInfo = new HashMap<>();
        sellerInfo.put("id", g.getSellerId());
        sellerInfo.put("nickname", seller != null ? seller.getNickname() : g.getSellerName());
        sellerInfo.put("creditScore", seller != null ? seller.getCreditScore() : 100);
        sellerInfo.put("status", seller != null ? seller.getStatus() : "active");
        sellerInfo.put("onSaleCount", onSaleCount);
        result.put("seller", sellerInfo);
        return result;
    }

    /**
     * 审核一件商品
     *  - approve → on_sale
     *  - reject  → off_shelf，理由必填且 5 ~ 500 字
     * <p>
     * ★ 理由为什么要有上限 ★
     * {@code t_goods_audit_record.reason} 是 varchar(500)。原先只校验了下限（≥ 5 字），
     * 超长理由会在 insert 审核记录那一刻抛 Data too long，事务整体回滚 ——
     * 表现是「点驳回，报服务器内部错误，商品还是待审核」，审核员完全摸不着头脑。
     */
    @Transactional
    public void reviewGoods(Long goodsId, String action, String reason, String operator) {
        // action 先收敛：原先只判 `"reject".equals(action)`，传个拼错的动作会被当成驳回
        Validators.oneOf(action, ACTIONS, "审核动作");
        if (action == null) throw BusinessException.paramError("缺少审核动作");

        String safeReason = null;
        if ("reject".equals(action)) {
            if (reason == null || reason.trim().length() < REASON_MIN) {
                throw BusinessException.paramError("驳回理由至少 " + REASON_MIN + " 个字，让卖家知道差在哪里");
            }
            safeReason = Validators.required(reason, REASON_MAX, "驳回理由");
        }

        Goods g = goodsMapper.selectById(goodsId);
        if (g == null) throw BusinessException.notFound("商品不存在");
        if (!"pending".equals(g.getStatus())) {
            throw BusinessException.of("该商品不在待审核状态，无需重复审核");
        }

        // ★ 只 SET status + update_time 两列，绝不 updateById 整实体回写 ★
        // 上面 selectById 读到的是**快照**；审核期间详情页仍可能在被查看（view_count 自增）
        // 或该商品刚被人下单扣库存 —— 整实体回写会把旧快照盖回整行，抹掉并发写入。
        String nextStatus = "approve".equals(action) ? "on_sale" : "off_shelf";
        LocalDateTime now = LocalDateTime.now();
        goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                .eq(Goods::getId, goodsId)
                .set(Goods::getStatus, nextStatus)
                .set(Goods::getUpdateTime, now));
        g.setStatus(nextStatus);
        g.setUpdateTime(now);

        GoodsAuditRecord record = new GoodsAuditRecord();
        record.setGoodsId(goodsId);
        record.setGoodsTitle(g.getTitle());
        record.setAction(action);
        record.setReason(safeReason);
        record.setOperator(operator);
        record.setTime(LocalDateTime.now());
        auditRecordMapper.insert(record);

        addAuditLog("approve".equals(action) ? "goodsAudit.approve" : "goodsAudit.reject",
                "approve".equals(action) ? "商品审核通过" : "商品审核驳回",
                "商品 #" + goodsId,
                "《" + g.getTitle() + "》" + ("approve".equals(action) ? "审核通过" : "审核驳回：" + safeReason));
    }

    public IPage<GoodsAuditRecord> fetchRecords(int page, int pageSize, String keyword) {
        return auditRecordMapper.selectPage(new Page<>(page, pageSize), recordsWrapper(keyword));
    }

    /** 导出上限：列表可以翻页，导出要「当前筛选的全部」（与订单导出同口径） */
    private static final int EXPORT_MAX = 5000;

    /**
     * 审核记录导出（全量，带关键字过滤）。
     * <p>
     * 审核记录是只增不改的复核凭据，导出拿不全等于复核断档 ——
     * 用关闭 count 的宽分页（{@code new Page<>(1, EXPORT_MAX, false)}）
     * 一条 SQL 拿全量，筛选与列表共用 {@link #recordsWrapper}，条件永远不会两边漂。
     */
    public List<GoodsAuditRecord> fetchRecordsForExport(String keyword) {
        return auditRecordMapper.selectPage(new Page<>(1, EXPORT_MAX, false), recordsWrapper(keyword))
                .getRecords();
    }

    /** 列表与导出共用的筛选组装 */
    private LambdaQueryWrapper<GoodsAuditRecord> recordsWrapper(String keyword) {
        LambdaQueryWrapper<GoodsAuditRecord> wrapper = new LambdaQueryWrapper<>();
        if (keyword != null && !keyword.isBlank()) {
            wrapper.like(GoodsAuditRecord::getGoodsTitle, keyword);
        }
        wrapper.orderByDesc(GoodsAuditRecord::getTime);
        return wrapper;
    }

    /**
     * 审核工作台统计：待审 / 已通过 / 已驳回 / **今日已审**
     * <p>
     * `today` 不能漏：前端的统计卡有「今日已审」一格，
     * 少了这个键那一格会渲染成空白（`undefined`），
     * 审核员看不出自己今天到底审了多少件。
     */
    public Map<String, Object> fetchStats() {
        Map<String, Object> result = new HashMap<>();
        result.put("pending", goodsMapper.selectCount(
                new LambdaQueryWrapper<Goods>().eq(Goods::getStatus, "pending")));
        result.put("approved", auditRecordMapper.selectCount(
                new LambdaQueryWrapper<GoodsAuditRecord>().eq(GoodsAuditRecord::getAction, "approve")));
        result.put("rejected", auditRecordMapper.selectCount(
                new LambdaQueryWrapper<GoodsAuditRecord>().eq(GoodsAuditRecord::getAction, "reject")));
        result.put("today", auditRecordMapper.selectCount(
                new LambdaQueryWrapper<GoodsAuditRecord>()
                        .ge(GoodsAuditRecord::getTime, LocalDate.now().atStartOfDay())));
        return result;
    }

    private void addAuditLog(String action, String label, String target, String detail) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        // 审核记录表已记真实审核人，审计流水也不该一律落 admin（从请求上下文取当前用户）
        log.setOperator(OperatorContext.currentOperator());
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }
}
