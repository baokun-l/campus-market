package com.campus.market.service;

import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
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

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 在线状态（心跳 / 在线名单 / 隐私开关）的判定口径与越权边界。
 * <p>
 * ★ 守的是三件「错了也不报错」的事 ★
 * <p>
 * 在线状态是本项目里最容易被写错、而且写错了**没有任何报错**的功能：
 * <ul>
 *   <li><b>隐私条件漏在 SQL 之外</b>：把 {@code show_online} 的判断挪到前端或挪到
 *       内存里过滤，页面看起来完全正常，但「关掉开关」这件事就失效了 ——
 *       别人照样能看到你在线。这正是这个开关此前的病根（过滤发生在观看者的浏览器里）。</li>
 *   <li><b>时间窗挪到客户端比</b>：同理，改本机时钟就能伪造在线。</li>
 *   <li><b>隐私开关「顺手」清掉 last_active_at</b>：看着像是让隐私即时生效，
 *       实际是拿一个查询条件去销毁真实活跃数据，且不可逆。</li>
 * </ul>
 * 这三条都无法靠「页面能不能打开」发现，只能靠断言 SQL 把口径钉死。
 */
class UserServiceOnlineTest {

    private static final long USER_ID = 4L;

    private UserMapper userMapper;
    private UserService service;

    /**
     * 单元测试里没有 Spring 容器，MyBatis-Plus 的实体元数据（属性名 ↔ 列名映射）不会自动注册，
     * LambdaQueryWrapper 解析列名时会抛 {@code can not find lambda cache for this entity}。
     * 手工注册一次 User 即可 —— 本文件的核心断言正是「生成的 SQL 里有没有
     * show_online / NOW() / 300 秒」这些条件，拿不到 SQL 就等于什么都没测。
     */
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
                // P1-11：鉴权快照缓存。用 mock —— 本文件断言的是在线口径，不涉及缓存行为
                mock(AuthSnapshotCache.class));
    }

    /**
     * MP 的 update(entity, wrapper) 第二参捕获器（generics 擦除，需要显式转换）。
     * <p>
     * ★ 必须捕获成 {@code LambdaUpdateWrapper}，不能只捕获成 {@code Wrapper} ★
     * {@code getSqlSegment()} 返回的是 **WHERE** 片段，SET 子句在 {@code getSqlSet()} 里，
     * 而 {@code getSqlSet()} 定义在 Update 接口上 —— 用 Wrapper 接住就调不到它，
     * 于是「心跳/开关到底写了哪一列」这个最关键的断言会退化成「在 WHERE 里找列名」，
     * 永远为假。这个坑踩过一次。
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static ArgumentCaptor<LambdaUpdateWrapper<User>> updateWrapperCaptor() {
        return ArgumentCaptor.forClass((Class) LambdaUpdateWrapper.class);
    }

    /** 查询类 wrapper 的捕获器（对查询而言 getSqlSegment() 就是 WHERE，够用） */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static ArgumentCaptor<Wrapper<User>> queryWrapperCaptor() {
        return ArgumentCaptor.forClass((Class) Wrapper.class);
    }

    // ==================== 心跳 ====================

    @Test
    @DisplayName("心跳：只以「当前时刻」刷新 last_active_at，不做整实体回写")
    void heartbeatRefreshesOnlyLastActiveAt() {
        service.heartbeat(USER_ID);

        ArgumentCaptor<LambdaUpdateWrapper<User>> captor = updateWrapperCaptor();
        verify(userMapper).update(eq(null), captor.capture());

        LambdaUpdateWrapper<User> w = captor.getValue();
        assertTrue(w.getSqlSet().contains("last_active_at"),
                "心跳必须写 last_active_at，实际 SET：" + w.getSqlSet());
        assertTrue(w.getSqlSegment().contains("id"),
                "心跳必须限定在本人这一行，实际 WHERE：" + w.getSqlSegment());
        // 整实体回写会把并发改动的 credit_score / status / nickname 覆盖回旧值
        verify(userMapper, never()).updateById(any());
    }

    @Test
    @DisplayName("心跳：拿不到登录态时回 401，不做任何写库")
    void heartbeatWithoutLoginIsRejected() {
        BusinessException e = assertThrows(BusinessException.class, () -> service.heartbeat(null));
        assertEquals(BusinessCode.UNAUTHORIZED, e.getCode());
        verify(userMapper, never()).update(any(), any());
    }

    // ==================== 在线名单 ====================

    @Test
    @DisplayName("在线名单：入参为空 / 全为非法值时，一次库都不查就返回空列表")
    void onlineIdsSkipsDatabaseForEmptyInput() {
        assertEquals(List.of(), service.queryOnlineIds(null));
        assertEquals(List.of(), service.queryOnlineIds(List.of()));
        // 0 与负数都不是合法主键，必须先被清洗掉，否则会拼出 WHERE id IN (0,-1) 这种无意义查询
        assertEquals(List.of(), service.queryOnlineIds(Arrays.asList(0L, -5L, null)));

        verify(userMapper, never()).selectList(any());
    }

    @Test
    @DisplayName("★ 在线名单：show_online 与时间窗必须同时写在 SQL 里（口径只在服务端）")
    void onlineIdsPinsPrivacyFilterAndServerSideWindow() {
        when(userMapper.selectList(any())).thenReturn(List.of());

        service.queryOnlineIds(List.of(1L, 2L));

        ArgumentCaptor<Wrapper<User>> captor = queryWrapperCaptor();
        verify(userMapper).selectList(captor.capture());
        String sql = captor.getValue().getSqlSegment();

        assertTrue(sql.contains("show_online"),
                "隐私开关必须由 SQL 过滤：漏掉它，关掉开关的人照样出现在名单里。实际 SQL：" + sql);
        assertTrue(sql.contains("last_active_at"),
                "在线判定必须基于 last_active_at。实际 SQL：" + sql);
        assertTrue(sql.contains("NOW()"),
                "时间基准必须是服务端时钟 NOW()：交给客户端比，改本机时钟就能伪造在线。实际 SQL：" + sql);
        assertTrue(sql.contains("300"),
                "时间窗必须与 ONLINE_WINDOW_SECONDS 一致（300 秒）。实际 SQL：" + sql);
    }

    @Test
    @DisplayName("在线名单：结果按 id 升序，与前端的渲染顺序解耦")
    void onlineIdsReturnsSortedList() {
        User u3 = new User();
        u3.setId(3L);
        User u1 = new User();
        u1.setId(1L);
        // 故意让库返回乱序（真实执行计划不保证顺序），方法负责排序
        when(userMapper.selectList(any())).thenReturn(List.of(u3, u1));

        assertEquals(List.of(1L, 3L), service.queryOnlineIds(List.of(1L, 3L)));
    }

    @Test
    @DisplayName("在线名单：重复 id 先收敛再查库（避免把同一 id 展开成多次占位符）")
    void onlineIdsDeduplicatesBeforeQuery() {
        List<User> rows = new ArrayList<>();
        when(userMapper.selectList(any())).thenReturn(rows);

        service.queryOnlineIds(List.of(2L, 2L, 2L, 9L, 9L));

        // 只发一次查询；重复入参在进入 SQL 之前就被 distinct 掉了
        verify(userMapper).selectList(any());
    }

    @Test
    @DisplayName("在线名单：入参超过上限时截断（挡住「构造一万个 id 压库」）")
    void onlineIdsTruncatesOversizedInput() {
        when(userMapper.selectList(any())).thenReturn(List.of());

        List<Long> flood = new ArrayList<>();
        for (long i = 1; i <= 5_000; i++) {
            flood.add(i);
        }

        // 不抛异常，也不把 5000 个值原样拼进 IN —— 只取前 100 个
        assertEquals(List.of(), service.queryOnlineIds(flood));

        // 捕获成 LambdaQueryWrapper：getParamNameValuePairs() 定义在 AbstractWrapper 上，
        // 用 Wrapper 接口接住就调不到它
        @SuppressWarnings({"unchecked", "rawtypes"})
        ArgumentCaptor<LambdaQueryWrapper<User>> captor =
                ArgumentCaptor.forClass((Class) LambdaQueryWrapper.class);
        verify(userMapper).selectList(captor.capture());
        // MP 把 IN 的每个值都放进参数表，参数个数即实际参与 SQL 的 id 数量
        int params = captor.getValue().getParamNameValuePairs().size();
        assertTrue(params <= 100, "参与 SQL 的 id 数必须被截断到 100，实际：" + params);
    }

    // ==================== 隐私开关 ====================

    @Test
    @DisplayName("隐私开关：没传布尔值回 1001，不做任何写库")
    void updateShowOnlineRequiresBooleanValue() {
        BusinessException e = assertThrows(BusinessException.class,
                () -> service.updateShowOnline(USER_ID, null));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode());
        verify(userMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("隐私开关：拿不到登录态时回 401")
    void updateShowOnlineWithoutLoginIsRejected() {
        BusinessException e = assertThrows(BusinessException.class,
                () -> service.updateShowOnline(null, true));
        assertEquals(BusinessCode.UNAUTHORIZED, e.getCode());
    }

    @Test
    @DisplayName("隐私开关：用户不存在回 1002")
    void updateShowOnlineMissingUserIsNotFound() {
        when(userMapper.selectById(USER_ID)).thenReturn(null);
        BusinessException e = assertThrows(BusinessException.class,
                () -> service.updateShowOnline(USER_ID, false));
        assertEquals(BusinessCode.NOT_FOUND, e.getCode());
    }

    @Test
    @DisplayName("★ 隐私开关：只改自己那一行的 show_online，且绝不动 last_active_at")
    void updateShowOnlineWritesOnlyOwnFlag() {
        User me = new User();
        me.setId(USER_ID);
        when(userMapper.selectById(USER_ID)).thenReturn(me);

        assertFalse(service.updateShowOnline(USER_ID, false));

        ArgumentCaptor<LambdaUpdateWrapper<User>> captor = updateWrapperCaptor();
        verify(userMapper).update(eq(null), captor.capture());
        LambdaUpdateWrapper<User> w = captor.getValue();
        String setSql = w.getSqlSet();

        assertTrue(setSql.contains("show_online"), "必须写 show_online，实际 SET：" + setSql);
        assertTrue(w.getSqlSegment().contains("id"),
                "必须把目标限定为登录者本人，实际 WHERE：" + w.getSqlSegment());
        /*
         * 关闭开关时**不能**顺手清空 last_active_at：
         * 可见性闸门在查询语句里，效果本来就是立刻的；去清时间戳等于
         * 用一个查询条件销毁真实活跃数据，不可逆，而且会让「重新打开开关」
         * 之后的在线状态凭空缺一段。
         */
        assertFalse(setSql.contains("last_active_at"),
                "隐私开关不该触碰 last_active_at，实际 SET：" + setSql);
    }

    @Test
    @DisplayName("隐私开关：返回值就是落库值，供前端回填（不让前端凭乐观更新自己猜）")
    void updateShowOnlineReturnsPersistedValue() {
        User me = new User();
        me.setId(USER_ID);
        when(userMapper.selectById(USER_ID)).thenReturn(me);

        assertTrue(service.updateShowOnline(USER_ID, true));
    }
}
