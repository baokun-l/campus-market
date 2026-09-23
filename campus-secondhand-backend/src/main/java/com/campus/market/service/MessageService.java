package com.campus.market.service;

import com.campus.market.common.BusinessException;
import com.campus.market.common.SessionId;
import com.campus.market.common.Validators;
import com.campus.market.entity.Message;
import com.campus.market.entity.User;
import com.campus.market.mapper.MessageMapper;
import com.campus.market.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 私信业务逻辑层
 */
@Service
@RequiredArgsConstructor
public class MessageService {

    private final MessageMapper messageMapper;
    private final UserMapper userMapper;

    /** 会话列表（结构对齐前端 ChatSession） */
    public List<Map<String, Object>> fetchSessions(Long userId) {
        return messageMapper.selectSessions(userId);
    }

    /** 未读总数 */
    public int fetchUnreadTotal(Long userId) {
        return messageMapper.countUnread(userId);
    }

    /** 会话消息（拉取即标记已读） */
    @Transactional
    public List<Message> fetchMessages(String sessionId, Long userId) {
        messageMapper.markRead(sessionId, userId);
        return messageMapper.selectBySession(sessionId, userId);
    }

    /**
     * 打开发起会话：返回会话 id
     * <p>
     * 商品详情页点「联系卖家」时调用。会话 id 由「商品 + 双方 id」确定性推导，
     * 因此不需要先建会话表 —— 同一个人对同一件商品再点一次「联系卖家」，
     * 拿到的是同一个会话，不会每点一次就多出一条空会话。
     * 若带了首条打招呼语，则顺手落库，让对方消息中心立刻有未读。
     */
    @Transactional
    public String openSession(Long myUserId, Long toUserId, Long goodsId, String firstMessage) {
        if (toUserId == null) throw BusinessException.paramError("缺少对方用户 id");
        if (myUserId.equals(toUserId)) throw BusinessException.paramError("不能和自己发起会话");
        User peer = userMapper.selectById(toUserId);
        if (peer == null) throw BusinessException.notFound("对方用户不存在");

        String sessionId = SessionId.of(goodsId, myUserId, toUserId);
        if (firstMessage != null && !firstMessage.isBlank()) {
            Message msg = new Message();
            msg.setSessionId(sessionId);
            msg.setFromUserId(myUserId);
            msg.setToUserId(toUserId);
            msg.setContent(firstMessage);
            msg.setRead(false);
            msg.setCreateTime(LocalDateTime.now());
            messageMapper.insert(msg);
        }
        return sessionId;
    }

    /** 发送消息（sessionId 为空时按「商品 + 双方」自动推导） */
    @Transactional
    public Message sendMessage(Long fromUserId, Long toUserId, String content, String sessionId) {
        if (toUserId == null) throw BusinessException.paramError("缺少接收人");
        // t_message.content 是 TEXT（64KB）：拦掉空消息之后，还要挡明显超长的正文 ——
        // 否则一条几百 KB 的私信会在 insert 那一刻抛 Data too long 变成 500
        String safeContent = Validators.required(content, Validators.TEXT, "消息内容");
        /*
         * ★ 会话归属校验 ★
         *
         * sessionId 是客户端传上来的，可被伪造：不校验的话，任何登录用户
         * 拿着「商品 id + 任意两个用户 id」就能拼出一个合法格式的会话 id，
         * 把消息塞进别人的会话（对方的消息中心立刻出现未读）。
         * 读消息 / 标记已读 / 删会话都带了 userId 条件，唯独写消息这条漏了。
         *
         * 判定方式：会话 id 规则里编码了「商品 + 双方用户 id」（见 SessionId），
         * 用发送方与接收方重算一遍，与传入值完全一致才认 —— 伪装成第三方
         * 或冒用别人 id 拼出来的会话在这里过不去。
         */
        String sid;
        if (sessionId == null || sessionId.isBlank()) {
            sid = SessionId.of(null, fromUserId, toUserId);
        } else {
            String expected = SessionId.of(SessionId.goodsIdOf(sessionId), fromUserId, toUserId);
            if (!expected.equals(sessionId)) {
                throw BusinessException.forbidden("无权向该会话发送消息");
            }
            sid = sessionId;
        }
        Message msg = new Message();
        msg.setSessionId(sid);
        msg.setFromUserId(fromUserId);
        msg.setToUserId(toUserId);
        msg.setContent(safeContent);
        msg.setRead(false);
        msg.setCreateTime(LocalDateTime.now());
        messageMapper.insert(msg);
        return msg;
    }

    /** 标记会话已读 */
    @Transactional
    public void markSessionRead(String sessionId, Long userId) {
        messageMapper.markRead(sessionId, userId);
    }

    /** 删除会话 */
    @Transactional
    public void deleteSession(String sessionId, Long userId) {
        messageMapper.delete(new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, sessionId)
                .and(w -> w.eq(Message::getFromUserId, userId).or().eq(Message::getToUserId, userId)));
    }

    /** 平台警告：管理员以站内信形式发给目标用户，固定落在 goodsId=0 的会话里 */
    @Transactional
    public void sendPlatformWarning(Long operatorId, Long toUserId, String reason) {
        User target = userMapper.selectById(toUserId);
        if (target == null) throw BusinessException.notFound("用户不存在");
        Long from = resolveAdminId(operatorId);
        String sessionId = SessionId.of(0L, from, toUserId);
        Message msg = new Message();
        msg.setSessionId(sessionId);
        msg.setFromUserId(from);
        msg.setToUserId(toUserId);
        msg.setContent("【平台警告】" + (reason == null || reason.isBlank() ? "请遵守平台交易规范" : reason));
        msg.setRead(false);
        msg.setCreateTime(LocalDateTime.now());
        messageMapper.insert(msg);
    }

    /** 找一位管理员作为警告的发送方；取不到时退回操作人自己 */
    private Long resolveAdminId(Long fallback) {
        List<User> admins = userMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<User>()
                        .eq(User::getRole, "admin")
                        .orderByAsc(User::getId));
        if (!admins.isEmpty()) return admins.get(0).getId();
        if (fallback != null) return fallback;
        throw BusinessException.of("系统中没有管理员账号，无法发送平台警告");
    }
}
