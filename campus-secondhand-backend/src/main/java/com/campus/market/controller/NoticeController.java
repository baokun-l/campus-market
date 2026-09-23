package com.campus.market.controller;

import com.campus.market.common.Result;
import com.campus.market.entity.Notice;
import com.campus.market.service.NoticeService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 公告控制器
 */
@RestController
@RequiredArgsConstructor
public class NoticeController {

    private final NoticeService noticeService;

    @GetMapping("/notices")
    public Result<List<Notice>> fetchNotices() {
        return Result.success(noticeService.fetchNotices());
    }

    @GetMapping("/notices/{id}")
    public Result<Notice> fetchById(@PathVariable Long id) {
        return Result.success(noticeService.fetchNoticeById(id));
    }

    @PostMapping("/admin/notices")
    public Result<Notice> create(@RequestBody Map<String, Object> body) {
        return Result.success(noticeService.createNotice(
                (String) body.get("title"), (String) body.get("content"),
                body.get("pinned") != null ? (Boolean) body.get("pinned") : null));
    }

    @PatchMapping("/admin/notices/{id}")
    public Result<Notice> update(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        return Result.success(noticeService.updateNotice(id,
                (String) body.get("title"), (String) body.get("content"),
                body.get("pinned") != null ? (Boolean) body.get("pinned") : null));
    }

    @PostMapping("/admin/notices/{id}/pin")
    public Result<Notice> togglePin(@PathVariable Long id) {
        return Result.success(noticeService.togglePin(id));
    }

    @DeleteMapping("/admin/notices/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        noticeService.deleteNotice(id);
        return Result.success();
    }
}
