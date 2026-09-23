package com.campus.market.service;

import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.config.JwtConfig;
import com.campus.market.entity.User;
import com.campus.market.mapper.AddressMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 修改个人资料（{@link UserService#updateProfile}）的局部更新语义测试。
 * <p>
 * ★ 守的是两件事 ★
 * <ol>
 *   <li><b>局部更新</b>：只改请求体里出现过的列。绝不能退化成
 *       {@code updateById} 整实体回写 —— 那会把同一时刻别人改过的 {@code credit_score} /
 *       {@code status} 一起覆盖回旧值（本项目已在 {@code favorite_count} 上栽过同类病根）；</li>
 *   <li><b>「没有要改的字段」必须报错</b>：请求体的键名全是后端不认识的（如把 nickname 拼成
 *       nickName）时，静默返回成功会让用户以为改好了，刷新后才发现没变，只能反复重试。</li>
 * </ol>
 * <p>
 * 手机号那两条用例是刻意配对的：{@code abcdefghijk} 有 11 个字符、**长度完全合法**，
 * 只有格式校验能拦下它 —— 只用「长度不超过 20」来校验等于没校验。
 * <p>
 * 构造方式沿用 {@link UserServiceFavoriteTest}：直接 new 出 {@code UserService} 并塞入 mock Mapper。
 * 另外，{@code LambdaUpdateWrapper.set()} 解析列名要读实体元数据，纯单测没有 MyBatis 启动流程，
 * 所以在 {@code @BeforeAll} 里手动注册一次（等价于容器扫描实体的那一步）。
 */
class UserServiceProfileTest {

    private static final long USER_ID = 7L;

    private UserMapper userMapper;
    private UserService service;

    @BeforeAll
    static void registerEntityMetadata() {
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), User.class);
    }

    @BeforeEach
    void setUp() {
        userMapper = mock(UserMapper.class);
        service = new UserService(
                userMapper,
                mock(GoodsMapper.class),
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(AddressMapper.class),
                mock(AuditLogMapper.class),
                mock(MessageService.class),
                mock(JwtConfig.class),

                mock(LoginAttemptGuard.class),
                // P1-11：鉴权快照缓存。用 mock —— 本文件断言的是局部更新口径，不涉及缓存行为
                mock(AuthSnapshotCache.class));
        // 默认：更新命中一行
        when(userMapper.update(any(), any())).thenReturn(1);
    }

    /** 取「这次 UPDATE 到底 SET 了哪些列」——局部更新的核心证据 */
    private String capturedSetSql() {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<LambdaUpdateWrapper<User>> captor =
                ArgumentCaptor.forClass(LambdaUpdateWrapper.class);
        verify(userMapper).update(any(), captor.capture());
        String sql = captor.getValue().getSqlSet();
        return sql == null ? "" : sql;
    }

    private static Map<String, Object> body(Object... kv) {
        Map<String, Object> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }

    @Test
    @DisplayName("只传 nickname → 只 SET nickname，且绝不整实体回写（updateById 从未被调用）")
    void onlyNicknameIsUpdated() {
        service.updateProfile(USER_ID, body("nickname", "  新昵称  "));

        String sql = capturedSetSql();
        assertTrue(sql.contains("nickname"), "应该 SET nickname，实际：" + sql);
        // 昵称落库前要 trim（Validators.required 的约定）
        assertTrue(sql.contains("nickname=#{"), "SET 子句形态异常：" + sql);

        // ★ 核心断言：任何「整实体回写」都会把 credit_score / status 一起带出去 ★
        assertFalse(sql.contains("credit_score"), "不得触碰 credit_score，实际：" + sql);
        assertFalse(sql.contains("status"), "不得触碰 status，实际：" + sql);
        assertFalse(sql.contains("password"), "不得触碰 password，实际：" + sql);
        assertFalse(sql.contains("token_version"), "不得触碰 token_version，实际：" + sql);
        assertFalse(sql.contains("role"), "不得触碰 role，实际：" + sql);

        verify(userMapper, never()).updateById(any());
    }

    @Test
    @DisplayName("只传 avatar → 只 SET avatar")
    void onlyAvatarIsUpdated() {
        service.updateProfile(USER_ID, body("avatar", "https://example.com/a.png"));

        String sql = capturedSetSql();
        assertTrue(sql.contains("avatar"), "应该 SET avatar，实际：" + sql);
        assertFalse(sql.contains("nickname"), "未传 nickname 时不该改它，实际：" + sql);
        assertFalse(sql.contains("credit_score"), "不得触碰 credit_score，实际：" + sql);
        verify(userMapper, never()).updateById(any());
    }

    @Test
    @DisplayName("手机号「长度合法但格式非法」（abcdefghijk）→ 1001，且一行都不写")
    void illegalPhoneIsRejectedEvenWhenLengthIsLegal() {
        // 11 个字符，长度校验会放行；只有格式校验能拦住
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateProfile(USER_ID, body("phone", "abcdefghijk")));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(), "非法手机号必须按 1001 返回");
        verify(userMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("手机号合法 → SET phone 为该值")
    void validPhoneIsAccepted() {
        service.updateProfile(USER_ID, body("phone", "13800138000"));

        String sql = capturedSetSql();
        assertTrue(sql.contains("phone"), "应该 SET phone，实际：" + sql);
        assertFalse(sql.contains("nickname"), "未传 nickname 时不该改它，实际：" + sql);
    }

    @Test
    @DisplayName("手机号传空串 → 视为清空该列（不是 1001）")
    void blankPhoneClearsTheColumn() {
        service.updateProfile(USER_ID, body("phone", "   "));

        String sql = capturedSetSql();
        assertTrue(sql.contains("phone"), "空串应当仍产生一次 SET phone（置空），实际：" + sql);
    }

    @Test
    @DisplayName("昵称为空白 → 1001（非空列不能被清空）")
    void blankNicknameIsRejected() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateProfile(USER_ID, body("nickname", "   ")));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
        verify(userMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("昵称超长（51 字 > varchar(50)）→ 1001，而不是让 MySQL 抛 500")
    void tooLongNicknameIsRejected() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateProfile(USER_ID, body("nickname", "阿".repeat(51))));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(), "窄列溢出必须是 1001，不能落到兜底 500");
        verify(userMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("空 body → 1001，且一行都不写")
    void emptyBodyIsRejected() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateProfile(USER_ID, new HashMap<>()));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode());
        verify(userMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("键名全是后端不认识的（nickname 拼成 nickName）→ 1001，不静默成功")
    void unknownKeysAreRejectedInsteadOfSilentlyDoingNothing() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateProfile(USER_ID, body("nickName", "张三")));
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(),
                "拼错的键名必须报错：静默成功会让用户以为改好了");
        verify(userMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("用户不存在（UPDATE 影响 0 行）→ 404")
    void unknownUserGivesNotFound() {
        when(userMapper.update(any(), any())).thenReturn(0);

        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateProfile(USER_ID, body("nickname", "张三")));
        assertEquals(BusinessCode.NOT_FOUND, ex.getCode(), "用户不存在必须是 404 而不是静默成功");
    }
}
