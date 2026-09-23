package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.mapper.MessageMapper;
import com.campus.market.mapper.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 私信会话归属校验测试。
 * <p>
 * ★ 守的是「不能往别人的会话里塞消息」★
 * <p>
 * 会话 id 只由「商品 id + 双方用户 id」推导，商品 id 与用户 id 都是小整数，
 * 完全可以被猜出来。读消息 / 标记已读 / 删会话都校验了归属，
 * 唯独发消息原先不校验 —— 任何登录用户拼一个别人的会话 id 就能把消息
 * （含任意内容）塞进对方的会话列表，对方还看到未读。
 */
class MessageServiceSessionGuardTest {

    private static final long ME = 3L;
    private static final long PEER = 7L;
    private static final long OUTSIDER = 9L;
    /** ME 与 PEER 的合法会话（商品 5） */
    private static final String SESSION = "s_5_3_7";

    private MessageMapper messageMapper;
    private MessageService service;

    @BeforeEach
    void setUp() {
        messageMapper = mock(MessageMapper.class);
        service = new MessageService(messageMapper, mock(UserMapper.class));
    }

    @Test
    @DisplayName("会话当事人发送正常落库")
    void partyCanSend() {
        assertDoesNotThrow(() -> service.sendMessage(ME, PEER, "在吗", SESSION));

        ArgumentCaptor<com.campus.market.entity.Message> captor =
                ArgumentCaptor.forClass(com.campus.market.entity.Message.class);
        verify(messageMapper).insert(captor.capture());
        assertEquals(SESSION, captor.getValue().getSessionId());
    }

    @Test
    @DisplayName("局外人冒用会话 id 被拒 —— 消息不能进别人的会话")
    void outsiderSessionIdRejected() {
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.sendMessage(OUTSIDER, PEER, "hi", SESSION)).getCode());
        verify(messageMapper, never()).insert(any(com.campus.market.entity.Message.class));
    }

    @Test
    @DisplayName("当事人换了接收人（拼接他人会话）同样被拒")
    void mismatchedPeerRejected() {
        // ME 想把消息塞进「商品 5、ME 与局外人」之外伪造的会话
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.sendMessage(ME, OUTSIDER, "hi", SESSION)).getCode());
        verify(messageMapper, never()).insert(any(com.campus.market.entity.Message.class));
    }

    @Test
    @DisplayName("不传 sessionId 走自动推导（商品 0 的普通私信）")
    void autoDerivedSessionAllowed() {
        assertDoesNotThrow(() -> service.sendMessage(ME, PEER, "你好", null));

        ArgumentCaptor<com.campus.market.entity.Message> captor =
                ArgumentCaptor.forClass(com.campus.market.entity.Message.class);
        verify(messageMapper).insert(captor.capture());
        assertEquals("s_0_3_7", captor.getValue().getSessionId());
    }

    @Test
    @DisplayName("空内容照旧拒绝（原有校验不回退）")
    void blankContentRejected() {
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.sendMessage(ME, PEER, "  ", null)).getCode());
        Mockito.verifyNoInteractions(messageMapper);
    }
}
