package com.campus.market.service;

import com.campus.market.common.BusinessException;
import com.campus.market.common.OperatorContext;
import com.campus.market.common.Validators;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.Notice;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.NoticeMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 公告业务逻辑层
 * <p>
 * ★ 长度校验为什么放在这里 ★
 * <p>
 * {@code t_notice.title} 是 varchar(200)、{@code content} 是 TEXT。MySQL 在
 * STRICT_TRANS_TABLES 下遇到超长值不会截断，而是抛 {@code Data too long for column}，
 * 一路冒到 GlobalExceptionHandler 兜底成 code=500。管理员写了个长标题，
 * 看到的是「服务器内部错误」——既不知道怎么改，也和真实故障混在一个指标里。
 * 所以在 Service 层先量一次，超限给 1001。
 */
@Service
@RequiredArgsConstructor
public class NoticeService {

    /** 与 schema.sql 的 t_notice.title varchar(200) 严格一致 */
    private static final int TITLE_MAX = 200;

    private final NoticeMapper noticeMapper;
    private final AuditLogMapper auditLogMapper;

    public List<Notice> fetchNotices() {
        return noticeMapper.selectList(
                new LambdaQueryWrapper<Notice>()
                        .orderByDesc(Notice::getPinned)
                        .orderByDesc(Notice::getCreateTime));
    }

    public Notice fetchNoticeById(Long id) {
        return noticeMapper.selectById(id);
    }

    @Transactional
    public Notice createNotice(String title, String content, Boolean pinned) {
        Notice n = new Notice();
        n.setTitle(Validators.required(title, TITLE_MAX, "公告标题"));
        n.setContent(Validators.optional(content, Validators.TEXT, "公告内容"));
        n.setPinned(pinned != null ? pinned : false);
        n.setCreateTime(LocalDateTime.now());
        noticeMapper.insert(n);
        addAuditLog("notice.create", "发布公告", "公告 #" + n.getId(), n.getTitle());
        return n;
    }

    @Transactional
    public Notice updateNotice(Long id, String title, String content, Boolean pinned) {
        Notice n = noticeMapper.selectById(id);
        if (n == null) throw BusinessException.notFound("公告不存在");
        // 局部更新：null 表示「这个字段不动」，因此只在传了值时才校验
        if (title != null) n.setTitle(Validators.required(title, TITLE_MAX, "公告标题"));
        if (content != null) n.setContent(Validators.optional(content, Validators.TEXT, "公告内容"));
        if (pinned != null) n.setPinned(pinned);
        n.setUpdateTime(LocalDateTime.now());
        noticeMapper.updateById(n);
        addAuditLog("notice.update", "编辑公告", "公告 #" + id, n.getTitle());
        return n;
    }

    @Transactional
    public Notice togglePin(Long id) {
        Notice n = noticeMapper.selectById(id);
        if (n == null) throw BusinessException.notFound("公告不存在");
        n.setPinned(!n.getPinned());
        noticeMapper.updateById(n);
        addAuditLog("notice.pin", n.getPinned() ? "置顶公告" : "取消置顶", "公告 #" + id, n.getTitle());
        return n;
    }

    @Transactional
    public void deleteNotice(Long id) {
        noticeMapper.deleteById(id);
        addAuditLog("notice.delete", "删除公告", "公告 #" + id, "");
    }

    private void addAuditLog(String action, String label, String target, String detail) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        // 发布 / 删除公告是管理员动作，落款记真实操作人而不是一律 admin
        log.setOperator(OperatorContext.currentOperator());
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }
}
