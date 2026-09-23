package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.CommentMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.mapper.ReportMapper;
import com.campus.market.mapper.ReviewMapper;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 留言 / 举报入口参数校验测试。
 * <p>
 * ★ 守的是「业务拒绝报 1001，而不是撞库变 500」★
 * <p>
 * content / reason / description 在表里都带 NOT NULL 或语义必填，
 * 入口不拦的话脏请求会直接撞数据库约束 —— 用户看到的是
 * 「服务器内部错误」，监控里多一条假故障，真正的错误码（1001）全程没出场。
 */
class ContentServiceValidationTest {

    private static final long USER_ID = 1L;
    private static final long GOODS_ID = 2L;

    private CommentMapper commentMapper;
    private ReportMapper reportMapper;
    private ContentService service;

    @BeforeEach
    void setUp() {
        commentMapper = mock(CommentMapper.class);
        reportMapper = mock(ReportMapper.class);
        service = new ContentService(
                mock(ReviewMapper.class),
                commentMapper,
                reportMapper,
                mock(AuditLogMapper.class),
                mock(UserMapper.class),
                mock(GoodsMapper.class),
                mock(OrderMapper.class),
                // P1-11：鉴权快照缓存。用 mock —— 本文件断言的是输入校验，不涉及缓存行为
                mock(AuthSnapshotCache.class));
    }

    @Test
    @DisplayName("空白留言被拦下，不落库")
    void blankCommentRejected() {
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.postComment(USER_ID, GOODS_ID, "   ", null)).getCode());
        verify(commentMapper, never()).insert(any(com.campus.market.entity.Comment.class));
    }

    @Test
    @DisplayName("null 内容同样被拦（此前会 NPE 变 500）")
    void nullCommentRejected() {
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.postComment(USER_ID, GOODS_ID, null, null)).getCode());
        Mockito.verifyNoInteractions(commentMapper);
    }

    @Test
    @DisplayName("非法举报类型拒绝 —— 脏 type 落库会毁掉类型筛选与快照查询")
    void badReportTypeRejected() {
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.submitReport(USER_ID, "video", GOODS_ID, "假货", null)).getCode());
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.submitReport(USER_ID, null, GOODS_ID, "假货", null)).getCode());
        Mockito.verifyNoInteractions(reportMapper);
    }

    @Test
    @DisplayName("理由与描述都为空的举报单拒绝 —— 核实的人拿不到任何线索")
    void emptyReasonAndDescriptionRejected() {
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.submitReport(USER_ID, "goods", GOODS_ID, null, null)).getCode());
        verify(reportMapper, never()).insert(any(com.campus.market.entity.Report.class));
    }

    @Test
    @DisplayName("合法举报照常受理")
    void validReportAccepted() {
        assertDoesNotThrow(() -> service.submitReport(USER_ID, "goods", GOODS_ID, "疑似假货", null));
        verify(reportMapper).insert(any(com.campus.market.entity.Report.class));
    }
}
