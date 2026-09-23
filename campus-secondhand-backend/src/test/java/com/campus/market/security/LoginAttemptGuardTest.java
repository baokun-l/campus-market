package com.campus.market.security;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 登录失败闸门测试。
 * <p>
 * ★ 时钟必须可注入 ★
 * <p>
 * 闸门的三条核心行为全是「时间驱动」的：窗口滑过要重新计数、锁定要到期自动解除、
 * 惰性清理要等条目过期。如果时钟写死成 {@code System.currentTimeMillis()}，
 * 这三条就只能靠 {@code Thread.sleep(15 分钟)} 去测 —— 没人会跑那种用例，
 * 等于这三条分支<b>永远没被验证过</b>。而它们恰恰是最危险的：
 * 一旦写成「锁永不过期」，上线后每个输错 5 次密码的账号会被永久锁死，
 * 而单测全绿、日志无异常。
 * <p>
 * ★ 参数必须与 {@code application.yml} 的 {@code app.login-guard.*} 默认值一致 ★
 * （账号 5 次 / 窗口 900s / 锁 900s，来源 IP 100 次 / 锁 300s）。
 * 用例按这组数字断言，改配置时这里要一起改 —— 否则会出现
 * 「配置调松了、用例还在拿旧数字自我验证」的假绿。
 */
class LoginAttemptGuardTest {

    private static final String ACCOUNT = "alice";
    private static final String IP = "10.0.0.9";
    private static final String LOCK_HINT = "锁定";
    private static final String IP_HINT = "当前网络";

    /** 与 application.yml 的 app.login-guard.* 默认值一一对应 */
    private static final int ACCOUNT_MAX_FAILS = 5;
    private static final int WINDOW_SECONDS = 900;
    private static final int ACCOUNT_LOCK_SECONDS = 900;
    private static final int IP_MAX_FAILS = 100;
    private static final int IP_LOCK_SECONDS = 300;

    /** 可控时钟：一个「秒表」，用例自己决定它走多快 */
    private AtomicLong now;
    private LoginAttemptGuard guard;

    @BeforeEach
    void setUp() {
        now = new AtomicLong(1_700_000_000_000L);
        guard = new LoginAttemptGuard(ACCOUNT_MAX_FAILS, WINDOW_SECONDS, ACCOUNT_LOCK_SECONDS,
                IP_MAX_FAILS, IP_LOCK_SECONDS, now::get);
    }

    /** 一次完整的失败尝试：先过闸门（真实调用顺序），再记账 */
    private void attemptFailure(String username, String ip) {
        guard.assertNotLocked(username, ip);
        guard.onFailure(username, ip);
    }

    /** 连错 5 次，把账号打进锁定 */
    private void lockAccount() {
        for (int i = 0; i < 5; i++) {
            attemptFailure(ACCOUNT, IP);
        }
    }

    /** 断言此刻该账号/来源已被拦下，并返回异常以便检查文案与码 */
    private BusinessException captureLock(String username, String ip) {
        return assertThrows(BusinessException.class, () -> guard.assertNotLocked(username, ip));
    }

    // ==================== 账号维度 ====================

    @Test
    @DisplayName("前 5 次失败都放行到口令校验那一步，第 6 次才被闸门拦下")
    void locksAfterFifthFailure() {
        for (int i = 0; i < 5; i++) {
            // 第 5 次失败本身仍须放行：用户此时该看到的是「用户名或密码错误」，
            // 而不是一条他无从理解的锁定通知（锁定提示留给第 6 次）
            assertDoesNotThrow(() -> guard.assertNotLocked(ACCOUNT, IP));
            guard.onFailure(ACCOUNT, IP);
        }

        BusinessException e = captureLock(ACCOUNT, IP);
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode(), "必须是 1001（业务拒绝），不能是 401/500");
        assertTrue(e.getMessage().contains(LOCK_HINT), "应提示账号被锁定，实际：" + e.getMessage());
        assertTrue(e.getMessage().contains("15 分钟"), "应给出剩余等待时间，实际：" + e.getMessage());
    }

    @Test
    @DisplayName("锁定到期自动解除 —— 防「锁写成永不过期」这种上线即全站锁死的写法")
    void lockExpiresAutomatically() {
        lockAccount();

        now.addAndGet(899_000L);
        assertThrows(BusinessException.class, () -> guard.assertNotLocked(ACCOUNT, IP));

        now.addAndGet(2_000L); // 累计 901s，越过 900s 锁定期
        assertDoesNotThrow(() -> guard.assertNotLocked(ACCOUNT, IP));
    }

    @Test
    @DisplayName("锁定期间继续尝试不会延长锁定 —— 否则攻击者能把任何账号永久锁在门外")
    void lockIsNotExtendedByFurtherFailures() {
        lockAccount();

        // 锁定期间的请求本就被 assertNotLocked 挡住，走不到 onFailure；
        // 这里直接调，模拟「万一有人把顺序写反」的极端路径
        guard.onFailure(ACCOUNT, IP);

        now.addAndGet(901_000L);
        assertDoesNotThrow(() -> guard.assertNotLocked(ACCOUNT, IP));
    }

    @Test
    @DisplayName("窗口滑过之后失败次数重新计数 —— 不会「上周错 4 次 + 今天错 1 次」就锁号")
    void counterResetsAfterWindowSlides() {
        for (int i = 0; i < 4; i++) {
            attemptFailure(ACCOUNT, IP);
        }
        now.addAndGet(901_000L); // 滑过 900s 窗口

        for (int i = 0; i < 4; i++) {
            attemptFailure(ACCOUNT, IP); // 累计 8 次，但窗口内只有这 4 次
        }
        assertDoesNotThrow(() -> guard.assertNotLocked(ACCOUNT, IP));
    }

    @Test
    @DisplayName("登录成功即清空该账号的失败累计")
    void successClearsAccountCounter() {
        for (int i = 0; i < 4; i++) {
            attemptFailure(ACCOUNT, IP);
        }
        guard.onSuccess(ACCOUNT);

        for (int i = 0; i < 4; i++) {
            // 若没清空，第二批的第 1 次就凑满 5 次并把账号锁掉
            attemptFailure(ACCOUNT, IP);
        }
        assertDoesNotThrow(() -> guard.assertNotLocked(ACCOUNT, IP));
    }

    @Test
    @DisplayName("用户名大小写 / 首尾空白共用同一计数 —— 否则换一种写法就白拿 5 次机会")
    void usernameIsNormalized() {
        for (int i = 0; i < 5; i++) {
            attemptFailure("Alice", IP);
        }
        assertTrue(captureLock("  ALICE  ", IP).getMessage().contains(LOCK_HINT));
        assertTrue(captureLock("alice", IP).getMessage().contains(LOCK_HINT));
    }

    @Test
    @DisplayName("账号维度彼此隔离：alice 被锁不牵连 bob")
    void accountsAreIsolated() {
        lockAccount();
        assertDoesNotThrow(() -> guard.assertNotLocked("bob", IP));
    }

    @Test
    @DisplayName("用户名为空时不抛异常，只按来源维度计数")
    void blankUsernameIsTolerated() {
        assertDoesNotThrow(() -> guard.assertNotLocked(null, IP));
        assertDoesNotThrow(() -> guard.onFailure(null, IP));
        assertDoesNotThrow(() -> guard.onFailure("   ", IP));
        assertDoesNotThrow(() -> guard.assertNotLocked(null, IP));
    }

    // ==================== 来源维度 ====================

    @Test
    @DisplayName("来源维度兜住撞库：100 个不同账号各错 1 次即锁来源（每个账号都远不到阈值）")
    void ipDimensionCatchesCredentialStuffing() {
        for (int i = 0; i < IP_MAX_FAILS; i++) {
            attemptFailure("user" + i, IP);
        }

        // 下一个是全新账号，它自己的计数是 0 —— 被拦只可能是来源维度生效
        BusinessException e = captureLock("brand-new-account", IP);
        assertTrue(e.getMessage().contains(IP_HINT), "应提示来源网络，实际：" + e.getMessage());

        // 换个来源则完全不受影响：锁的是来源，不是全局
        assertDoesNotThrow(() -> guard.assertNotLocked("brand-new-account", "10.0.0.10"));
    }

    @Test
    @DisplayName("登录成功只清账号计数、不清来源计数 —— 否则拿自己的账号登录一次就能把来源计数清零")
    void successDoesNotClearIpCounter() {
        for (int i = 0; i < IP_MAX_FAILS - 1; i++) {
            attemptFailure("user" + i, IP);
        }
        guard.onSuccess("user1"); // 攻击者用自己的正常账号登录一次

        guard.onFailure("user-more", IP); // 第 100 次失败 → 来源锁定
        assertTrue(captureLock("anyone", IP).getMessage().contains(IP_HINT));
    }

    // ==================== 惰性清理 ====================

    @Test
    @DisplayName("惰性清理：锁已到期且窗口已滑过的条目被整体回收")
    void purgeReclaimsStaleEntries() {
        for (int i = 0; i < 300; i++) {
            guard.onFailure("stale" + i, "10.3.3." + i);
        }
        assertEquals(300, guard.trackedAccounts());

        now.addAndGet(1_000_000L); // 越过窗口，这 300 条全成垃圾
        guard.onFailure("fresh", "10.4.4.1");

        assertEquals(1, guard.trackedAccounts(),
                "300 条过期条目应在这一次清理中全部回收，只剩刚写入的 fresh；实际 "
                        + guard.trackedAccounts() + " 条（回收失效会让内存随随机用户名单调增长）");
    }

    @Test
    @DisplayName("惰性清理不会误杀仍处于锁定中的条目")
    void purgeKeepsLiveLock() {
        lockAccount();             // alice 锁 900s
        now.addAndGet(800_000L);   // 锁尚未到期

        for (int i = 0; i < 300; i++) {
            guard.onFailure("flood" + i, "10.5.5." + i); // 灌到水位以上，逼出清理
        }

        assertTrue(guard.trackedAccounts() >= 301, "清理不应把锁定中的条目也带走");
        assertTrue(captureLock(ACCOUNT, IP).getMessage().contains(LOCK_HINT),
                "alice 还在锁定期内，必须仍被拦下");
    }
}
