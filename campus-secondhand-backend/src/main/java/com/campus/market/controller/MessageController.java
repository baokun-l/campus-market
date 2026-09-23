package com.campus.market.controller;

import com.campus.market.common.Params;
import com.campus.market.common.Result;
import com.campus.market.entity.Message;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.MessageService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 私信控制器
 */
@RestController
@RequiredArgsConstructor
public class MessageController {

    private final MessageService messageService;

    @GetMapping("/messages/sessions")
    public Result<List<Map<String, Object>>> fetchSessions(HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(messageService.fetchSessions(userId));
    }

    /**
     * 打开发起会话（商品详情页「联系卖家」）
     * <p>
     * 返回会话 id 字符串；前端把它存下来后直接跳转消息页。
     * 注意用**登录态里的 userId**作为发起方，而不是请求体里的 myUserId ——
     * 后者由客户端提供，可被伪造。
     */
    @PostMapping("/messages/sessions/open")
    public Result<String> openSession(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(messageService.openSession(
                userId,
                Params.requiredLong(body.get("toUserId"), "toUserId"),
                body.get("goodsId") != null ? Params.requiredLong(body.get("goodsId"), "goodsId") : null,
                (String) body.get("firstMessage")));
    }

    @GetMapping("/messages/unread")
    public Result<Integer> fetchUnreadTotal(HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(messageService.fetchUnreadTotal(userId));
    }

    @GetMapping("/messages/sessions/{sessionId}")
    public Result<List<Message>> fetchMessages(
            @PathVariable String sessionId, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(messageService.fetchMessages(sessionId, userId));
    }

    @PostMapping("/messages")
    public Result<Message> sendMessage(HttpServletRequest request, @RequestBody Map<String, Object> body) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        return Result.success(messageService.sendMessage(
                userId,
                Params.requiredLong(body.get("toUserId"), "toUserId"),
                (String) body.get("content"),
                (String) body.get("sessionId")));
    }

    @PostMapping("/messages/sessions/{sessionId}/read")
    public Result<Void> markRead(@PathVariable String sessionId, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        messageService.markSessionRead(sessionId, userId);
        return Result.success();
    }

    @DeleteMapping("/messages/sessions/{sessionId}")
    public Result<Void> deleteSession(@PathVariable String sessionId, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
        messageService.deleteSession(sessionId, userId);
        return Result.success();
    }
}
