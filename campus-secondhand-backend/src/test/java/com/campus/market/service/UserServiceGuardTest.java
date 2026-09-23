package com.campus.market.service;

import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.User;
import com.campus.market.mapper.AddressMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 用户封禁闸门与公开主页语义测试。
 * <p>
 * ★ 守的是「后台不能把自己锁在门外」★
 * <p>
 * 批量封禁一直会跳过管理员类账号（防误操作把审核人员全封死），
 * 单个封入口原先没有这道闸 —— 两个管理员互相封、或者手滑封了自己，
 * 解封接口也在后台里，全被封死等于把钥匙锁进保险柜。
 */
class UserServiceGuardTest {

    private static final long USER_ID = 10L;

    private UserMapper userMapper;
    private UserService service;

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
                mock(com.campus.market.config.JwtConfig.class),

                mock(LoginAttemptGuard.class),
                // P1-11：鉴权快照缓存。本文件只断言「谁被写了 status」，缓存失效由
                // AuthSnapshotCacheTest 单独看守（那里才有真缓存对象）
                mock(AuthSnapshotCache.class));
        // 封禁 / 审核走 LambdaUpdateWrapper<User>：set() 解析列名需要实体元数据，
        // 纯单测没有 MyBatis 启动流程，手动注册一次（等价于容器扫描实体的那一步）
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), User.class);
    }

    private void givenUser(String role) {
        User u = new User();
        u.setId(USER_ID);
        u.setRole(role);
        u.setStatus("active");
        when(userMapper.selectById(USER_ID)).thenReturn(u);
    }

    @Test
    @DisplayName("单个封禁对三类管理员账号一律拒绝 —— 与批量封禁同一道闸")
    void adminClassAccountsCannotBeBanned() {
        for (String role : new String[]{"admin", "goods_admin", "report_admin"}) {
            givenUser(role);
            assertEquals(BusinessCode.PARAM_ERROR,
                    assertThrows(BusinessException.class,
                            () -> service.toggleUserStatus(USER_ID, true)).getCode(),
                    "角色 " + role + " 应被拒绝封禁");
        }
    }

    @Test
    @DisplayName("解封不受限 —— 历史数据里被封的管理员要有恢复路径")
    void unbanRemainsAllowed() {
        givenUser("admin");
        User u = userMapper.selectById(USER_ID);
        u.setStatus("banned");
        assertDoesNotThrow(() -> service.toggleUserStatus(USER_ID, false));
    }

    @Test
    @DisplayName("普通用户正常封禁")
    void normalUserCanBeBanned() {
        givenUser("user");
        assertDoesNotThrow(() -> service.toggleUserStatus(USER_ID, true));
    }

    @Test
    @DisplayName("★ 封禁只 SET status 一列，绝不 updateById 整实体回写")
    void banNeverRewritesWholeEntity() {
        givenUser("user");

        service.toggleUserStatus(USER_ID, true);

        /*
         * ★ 为什么这条必须钉死 ★
         * selectById 读到的是一份**快照**。整实体回写会把它盖回整行，而 t_user 上有两列
         * 是「必须保持最新」的：
         *   · credit_score —— 封禁的同时别人刚扣过分，会被还原成旧值；
         *   · token_version —— 它是「改密 / 封禁即时吊销令牌」的计数器，写回旧版本号
         *     等于让**已经吊销的旧 token 重新生效**：一边封人、一边把门打开。
         */
        verify(userMapper).update(isNull(), any());
        verify(userMapper, never()).updateById(any());
    }

    @Test
    @DisplayName("★ 批量封禁同样只 SET status 一列 —— 单条通道防住了，批量通道不能漏")
    void batchBanNeverRewritesWholeEntity() {
        User u = new User();
        u.setId(USER_ID);
        u.setRole("user");
        u.setStatus("active");
        when(userMapper.selectBatchIds(any())).thenReturn(List.of(u));

        service.batchToggleUserStatus(List.of(USER_ID), true);

        // selectBatchIds 拿到的是一批快照；整实体回写 = 一次给所有目标把已吊销的令牌重新放行
        verify(userMapper).update(isNull(), any());
        verify(userMapper, never()).updateById(any());
    }

    @Test
    @DisplayName("公开主页查无此人回 1002，而不是 data:null")
    void publicProfileMissingIs404() {
        when(userMapper.selectById(USER_ID)).thenReturn(null);
        assertEquals(BusinessCode.NOT_FOUND,
                assertThrows(BusinessException.class,
                        () -> service.fetchPublicProfile(USER_ID)).getCode());
    }
}
