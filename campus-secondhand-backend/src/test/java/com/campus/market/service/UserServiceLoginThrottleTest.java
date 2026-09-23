package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.common.Passwords;
import com.campus.market.config.JwtConfig;
import com.campus.market.entity.User;
import com.campus.market.mapper.AddressMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.UserMapper;
import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 登录失败闸门与 {@link UserService#login} 的接线测试。
 * <p>
 * ★ 为什么闸门本身已经有单测，这里还要再测一遍 ★
 * <p>
 * {@code LoginAttemptGuard} 测的是「计数/锁定/解锁」这套逻辑自身对不对；
 * 这里测的是<b>接线</b>：UserService 有没有在正确的位置调用它。
 * 接线错一步，整套闸门就是个摆设，而且是对外完全看不出来：
 * <ul>
 *   <li>{@code onFailure} 写在<b>口令校验之前</b> → 正常用户第一次输对密码也先被记一次失败；
 *   <li>{@code onSuccess} 写在<b>方法入口</b> → 前面积累的失败次数每次登录都被抹掉，闸门永不触发；
 *   <li>把「账号被封禁」也当成失败 → 被封的用户打 5 次就额外收到一条「尝试次数过多」，
 *       用户看不懂、日志里也混进假攻击信号；
 *   <li>{@code assertNotLocked} 放到<b>查库之后</b> → 锁定期间照样每次都打一次数据库，
 *       闸门只剩提示作用，防不住撞库。
 * </ul>
 * 这些都属于「改一行就静默失效」的类型，所以必须有用例把调用点钉住。
 */
class UserServiceLoginThrottleTest {

    private static final String USERNAME = "bob";
    private static final String WRONG = "wrong-password";
    private static final String RIGHT = "right-password";
    private static final String IP = "127.0.0.1";
    private static final String PWD_ERROR = "用户名或密码错误";

    /** 与 application.yml 的 app.login-guard.* 默认值一致（这里只用到账号维度） */
    private static final int ACCOUNT_MAX_FAILS = 5;
    private static final int WINDOW_SECONDS = 900;
    private static final int ACCOUNT_LOCK_SECONDS = 900;
    private static final int IP_MAX_FAILS = 100;
    private static final int IP_LOCK_SECONDS = 300;

    private AtomicLong now;
    private UserMapper userMapper;
    private LoginAttemptGuard guard;
    private UserService service;

    @BeforeEach
    void setUp() {
        now = new AtomicLong(1_700_000_000_000L);
        guard = new LoginAttemptGuard(ACCOUNT_MAX_FAILS, WINDOW_SECONDS, ACCOUNT_LOCK_SECONDS,
                IP_MAX_FAILS, IP_LOCK_SECONDS, now::get);
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
                guard,
                // P1-11：鉴权快照缓存。用 mock —— 本文件断言的是登录失败闸门，不涉及缓存行为
                mock(AuthSnapshotCache.class));
        // 登录路径里的「明文口令透明升级」会走 LambdaUpdateWrapper<User>，
        // set() 解析列名需要实体元数据；纯单测没有 MyBatis 启动流程，手动注册一次
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), User.class);
    }

    /** 每次都返回新的实例：login 成功时会 {@code setPassword(null)}，复用同一对象会污染下一次断言 */
    private void givenAccount(String status) {
        when(userMapper.selectByUsername(anyString())).thenAnswer(inv -> {
            User u = new User();
            u.setId(1L);
            u.setUsername(USERNAME);
            u.setNickname("小明");
            u.setPassword(Passwords.encode(RIGHT));
            u.setRole("user");
            u.setStatus(status);
            u.setTokenVersion(0);
            return u;
        });
    }

    private BusinessException login(String password) {
        return assertThrows(BusinessException.class, () -> service.login(USERNAME, password, IP));
    }

    // ==================== 接线正确性 ====================

    @Test
    @DisplayName("连错 5 次后第 6 次被拦，且锁定期间不再查库")
    void sixthAttemptIsBlockedBeforeDatabaseLookup() {
        givenAccount("active");

        for (int i = 0; i < 5; i++) {
            BusinessException e = login(WRONG);
            assertEquals(BusinessCode.PARAM_ERROR, e.getCode(), "必须是 1001，不能落到 500");
            assertEquals(PWD_ERROR, e.getMessage(), "前 5 次只应提示口令错误");
        }

        BusinessException locked = login(WRONG);
        assertTrue(locked.getMessage().contains("锁定"),
                "第 6 次应提示账号锁定，实际：" + locked.getMessage());

        // ★ 关键断言 ★：第 6 次连用户名都没查，说明闸门在查库之前
        verify(userMapper, times(5)).selectByUsername(USERNAME);
    }

    @Test
    @DisplayName("登录成功即清空失败累计（否则偶尔输错几次的正常用户会被越攒越锁）")
    void successClearsFailureCounter() {
        givenAccount("active");

        for (int i = 0; i < 4; i++) {
            assertEquals(PWD_ERROR, login(WRONG).getMessage());
        }
        assertNotNull(service.login(USERNAME, RIGHT, IP), "口令正确应当登录成功");

        for (int i = 0; i < 4; i++) {
            // 若没清零，这批的第 1 次就凑满 5 次并触发锁定
            assertEquals(PWD_ERROR, login(WRONG).getMessage(),
                    "成功登录后计数未清零：第 " + (i + 1) + " 次就变成锁定提示了");
        }
        assertDoesNotThrow(() -> guard.assertNotLocked(USERNAME, IP));
    }

    @Test
    @DisplayName("锁定到期后同一账号可以重新正常登录")
    void loginRecoversAfterLockExpires() {
        givenAccount("active");
        for (int i = 0; i < 5; i++) {
            login(WRONG);
        }
        assertTrue(login(WRONG).getMessage().contains("锁定"));

        now.addAndGet(901_000L); // 越过 900s 锁定期

        assertNotNull(service.login(USERNAME, RIGHT, IP), "锁定到期后必须能重新登录");
    }

    @Test
    @DisplayName("被封禁账号的尝试不计入失败次数 —— 封禁是管理动作，不是攻击特征")
    void bannedAccountAttemptsAreNotCounted() {
        givenAccount("banned");

        for (int i = 0; i < 8; i++) {
            BusinessException e = login(RIGHT); // 口令是对的，只是账号被封
            assertEquals(BusinessCode.FORBIDDEN, e.getCode());
            assertFalse(e.getMessage().contains("锁定"),
                    "第 " + (i + 1) + " 次就出现锁定提示：被封禁被误当成了一次失败");
        }
        assertDoesNotThrow(() -> guard.assertNotLocked(USERNAME, IP),
                "被封禁账号不该被计入失败次数");
    }

    @Test
    @DisplayName("不存在的用户名同样计数 —— 否则「锁不锁」本身就成了账号是否存在的探测器")
    void unknownUsernameIsCountedToo() {
        when(userMapper.selectByUsername(anyString())).thenReturn(null);

        for (int i = 0; i < 5; i++) {
            assertEquals(PWD_ERROR, login(WRONG).getMessage());
        }
        assertTrue(login(WRONG).getMessage().contains("锁定"),
                "不存在的用户名也必须被闸门拦下，否则锁行为可用来枚举有效账号");
    }
}
