package com.campus.market.security;

import com.campus.market.entity.User;
import com.campus.market.mapper.UserMapper;
import com.github.benmanes.caffeine.cache.Ticker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 鉴权快照缓存（P1-11）测试。
 *
 * <h3>★ 时钟必须可注入，理由与 {@code UploadQuotaGuardTest} 完全一样 ★</h3>
 * 「TTL 到点必须回源」是本类唯一的**保命属性**：它一旦被写坏（比如有人把过期改成
 * 永不过期、或去掉 expireAfterWrite），表现是「服务一切正常，只是封禁要多等一会儿」——
 * 没有报错、没有异常日志、接口全部 200。写死时钟就只能靠 {@code Thread.sleep(10_000)} 去测，
 * 没人会跑那种用例，等于这条分支**永远没被验证过**。所以这里注入假时钟，
 * 用 {@code advanceSeconds()} 把「10 秒后」变成一次内存自增。
 *
 * <h3>★ 断言一律锚「查了几次库」而不是「缓存对象里的值」★</h3>
 * 本类存在的唯一目的是**少查库**；所以「命中」的定义就是「没查库」。
 * 断言 mapper 的调用次数是唯一直接测到这个目的的方式，
 * 而不是去读缓存内部状态（那会变成「实现怎么写的就怎么断言」）。
 */
class AuthSnapshotCacheTest {

    private static final long USER_ID = 7L;
    private static final long OTHER_ID = 8L;

    private UserMapper userMapper;

    /** 假时钟：单位为纳秒，与 {@link Ticker#read()} 一致 */
    private AtomicLong nanos;

    private AuthSnapshotCache cache;

    @BeforeEach
    void setUp() {
        userMapper = mock(UserMapper.class);
        nanos = new AtomicLong(0);
        Ticker fakeTicker = nanos::get;
        cache = new AuthSnapshotCache(userMapper, AuthSnapshotCache.TTL_SECONDS, 100, fakeTicker);
    }

    /** 推着假时钟前进 */
    private void advanceSeconds(long seconds) {
        nanos.addAndGet(seconds * 1_000_000_000L);
    }

    /** 让回源查询返回指定的一行（每次调用都会覆盖上一次的桩） */
    private void givenRow(Long id, String status, String role, Integer tokenVersion) {
        User u = new User();
        u.setId(id);
        u.setStatus(status);
        u.setRole(role);
        u.setTokenVersion(tokenVersion);
        when(userMapper.selectById(id)).thenReturn(u);
    }

    private void givenNoRow(Long id) {
        when(userMapper.selectById(id)).thenReturn(null);
    }

    @Test
    @DisplayName("TTL 内同一个用户只回源一次 —— 这才是「加了缓存」")
    void sameUserIsLoadedOnceWithinTtl() {
        givenRow(USER_ID, "active", "user", 0);

        assertEquals("active", cache.get(USER_ID).orElseThrow().status());
        assertEquals("active", cache.get(USER_ID).orElseThrow().status());
        assertEquals("user", cache.get(USER_ID).orElseThrow().role());

        // ★ 判据的核心：三次取快照，只应该有一次落到数据库
        verify(userMapper, times(1)).selectById(USER_ID);
        // 第二条独立信号：条目确实留在缓存里（不依赖 mapper 计数这一个观测通道）
        assertTrue(cache.cachedCount() >= 1, "取过快照之后缓存里应当有东西");
    }

    @Test
    @DisplayName("TTL 到点必须回源 —— 兜底那一层不能被写坏")
    void expiredEntryFallsBackToDatabase() {
        givenRow(USER_ID, "active", "user", 0);
        cache.get(USER_ID);

        // 时间走到 TTL 之后，库里的状态变了
        advanceSeconds(AuthSnapshotCache.TTL_SECONDS + 1);
        givenRow(USER_ID, "banned", "user", 0);

        assertTrue(cache.get(USER_ID).orElseThrow().isBanned(),
                "TTL 过后必须看到库里的新状态（否则「永不过期」这个缺陷不会被任何用例发现）");
        verify(userMapper, times(2)).selectById(USER_ID);
    }

    @Test
    @DisplayName("TTL 之内**不会**回源 —— 与上一条配成一对，防「每请求都还是直查」而用例照样绿")
    void notExpiredEntryIsNotReloaded() {
        givenRow(USER_ID, "active", "user", 0);
        cache.get(USER_ID);

        // 只走到 TTL 的一半
        advanceSeconds(AuthSnapshotCache.TTL_SECONDS / 2);
        givenRow(USER_ID, "banned", "user", 0);

        assertFalse(cache.get(USER_ID).orElseThrow().isBanned(), "未过期就不该回源");
        verify(userMapper, times(1)).selectById(USER_ID);
    }

    @Test
    @DisplayName("显式失效后第一个请求就回源 —— 「封禁当场生效」靠的就是这条")
    void invalidateForcesReloadOnTheVeryNextRead() {
        givenRow(USER_ID, "active", "user", 0);
        assertEquals("active", cache.get(USER_ID).orElseThrow().status());

        // 模拟「管理员封禁」：先把库改掉，再像 UserService 那样显式失效
        givenRow(USER_ID, "banned", "user", 0);
        cache.invalidate(USER_ID);

        assertTrue(cache.get(USER_ID).orElseThrow().isBanned(),
                "失效之后必须立刻回源，否则被封的人还能靠 10 秒 TTL 白蹭");
        verify(userMapper, times(2)).selectById(USER_ID);
    }

    @Test
    @DisplayName("批量失效一次覆盖一批（批量封禁走的这条）")
    void invalidateAllCoversEveryGivenUser() {
        givenRow(USER_ID, "active", "user", 0);
        givenRow(OTHER_ID, "active", "user", 0);
        cache.get(USER_ID);
        cache.get(OTHER_ID);

        givenRow(USER_ID, "banned", "user", 0);
        givenRow(OTHER_ID, "banned", "user", 0);
        cache.invalidateAll(List.of(USER_ID, OTHER_ID));

        assertTrue(cache.get(USER_ID).orElseThrow().isBanned());
        assertTrue(cache.get(OTHER_ID).orElseThrow().isBanned());
        verify(userMapper, times(2)).selectById(USER_ID);
        verify(userMapper, times(2)).selectById(OTHER_ID);
    }

    @Test
    @DisplayName("查不到的用户按「空」缓存 —— 负缓存不给删号后的旧 token 留打库通道")
    void missingUserIsCachedAsEmpty() {
        givenNoRow(USER_ID);

        assertTrue(cache.get(USER_ID).isEmpty());
        assertTrue(cache.get(USER_ID).isEmpty());

        verify(userMapper, times(1)).selectById(USER_ID);
    }

    @Test
    @DisplayName("null userId 直接答空，不碰数据库")
    void nullUserIdDoesNotTouchDatabase() {
        assertTrue(cache.get(null).isEmpty());
        verifyNoInteractions(userMapper);
    }

    @Test
    @DisplayName("token_version 为 NULL 的行按 0 处理 —— 与 JwtConfig.tokenVersionOf 的老令牌口径一致")
    void nullTokenVersionCountsAsZero() {
        givenRow(USER_ID, "active", "user", null);
        assertEquals(0, cache.get(USER_ID).orElseThrow().tokenVersion(),
                "口径必须与 JwtConfig.tokenVersionOf(老令牌无 ver 声明) 一致，否则升级后会把人全部踢下线");
    }

    /**
     * ★ TTL 是安全边界，不是性能旋钮 ★
     * <p>
     * 这个用例没有断言「TTL 等于 10」这种琐事，而是钉住它的**量级**：
     * 「漏了显式失效时，被封的人最坏还能多用几秒」。
     * 把它调到小时级能让接口更快，而后果是一个被踢下线的账号还能继续访问 ——
     * 不报错、不告警，只在安全评审时才被发现。所以这里给它一个上界。
     */
    @Test
    @DisplayName("TTL 必须落在「秒级」区间 —— 它是失效兜底的边界，不许被调成小时级")
    void ttlStaysInSecondRange() {
        assertTrue(AuthSnapshotCache.TTL_SECONDS >= 1,
                "TTL 小于 1 秒等于没缓存（每次请求都过期）");
        assertTrue(AuthSnapshotCache.TTL_SECONDS <= 30,
                "TTL 超过 30 秒，漏失效时被封账号能继续访问太久；"
                        + "要调大请先想清楚这条安全边界，并改掉本用例的期望值");
    }

    @Test
    @DisplayName("快照只带鉴权那三列 —— 缓存里不放整行（不重复持有密码哈希）")
    void snapshotCarriesOnlyAuthColumns() {
        givenRow(USER_ID, "active", "admin", 3);
        AuthSnapshotCache.Snapshot s = cache.get(USER_ID).orElseThrow();

        assertEquals(3, s.tokenVersion());
        assertEquals("admin", s.role());
        assertEquals("active", s.status());
        assertFalse(s.isBanned());
        // 结构上就只有这三个字段：用反射数一遍，防止以后有人「顺手」把整行塞进来
        assertEquals(3, AuthSnapshotCache.Snapshot.class.getRecordComponents().length,
                "Snapshot 只应承载 status / role / tokenVersion");
    }
}
