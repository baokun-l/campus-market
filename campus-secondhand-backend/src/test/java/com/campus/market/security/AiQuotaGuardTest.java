package com.campus.market.security;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AI 调用闸门测试。
 * <p>
 * ★ 时钟必须可注入 ★
 * <p>
 * 闸门的两条核心行为全是「时间驱动」的：窗口滑过要重新计数、限流要能自动解除。
 * 时钟写死成 {@code System.currentTimeMillis()} 就只能靠
 * {@code Thread.sleep(10 分钟)} 去测 —— 没人会跑那种用例，等于这两条分支
 * <b>永远没被验证过</b>。而它们恰恰是最危险的：一旦有人把窗口写成「永不过期」，
 * 线上会变成「用户用满额度之后永远用不了 AI」，而单测全绿、日志无异常。
 * <p>
 * ★ 本类比 {@code LoginAttemptGuardTest} 多走了一步 ★
 * <p>
 * 那个类的注释里写着「参数必须与 application.yml 的默认值一致，改配置时这里要一起改」——
 * 但那条纪律<b>只写在了注释里</b>，没人会真的去比对。这里把它变成一条会失败的用例
 * （{@link #testConstantsMatchApplicationYml()}）：直接读 {@code /application.yml}
 * 把占位符里的默认值抠出来比对，对不上就红。
 * 这才是「配置调了、用例还在拿旧数字自我验证」这种假绿的真正解法。
 * <p>
 * ★ 本类刻意不复用 {@code LoginAttemptGuard} 的类 ★
 * <p>
 * 两者形似而神不同：登录闸门计的是**失败**、并且有独立的「锁定」状态；
 * AI 闸门计的是**消耗**（成功失败都算）、没有锁定态。合并成一个类会逼着两边
 * 共用一套语义含混的参数，「这个 0 到底表示不限还是一次就锁」将无法判断。
 */
class AiQuotaGuardTest {

    /** 与 application.yml 的 app.ai-guard.* 默认值一一对应（由 testConstantsMatchApplicationYml 看守） */
    private static final int USER_MAX_CALLS = 30;
    private static final int GLOBAL_MAX_CALLS = 300;
    private static final int WINDOW_SECONDS = 600;

    private static final long WINDOW_MS = WINDOW_SECONDS * 1000L;

    private static final long ALICE = 7L;
    private static final long BOB = 8L;

    /** 可控时钟：一个「秒表」，用例自己决定它走多快 */
    private AtomicLong now;

    @BeforeEach
    void setUp() {
        now = new AtomicLong(1_700_000_000_000L);
    }

    /** 按 yml 默认值构造（多数用例用这个） */
    private AiQuotaGuard defaults() {
        return new AiQuotaGuard(USER_MAX_CALLS, GLOBAL_MAX_CALLS, WINDOW_SECONDS, now::get);
    }

    /**
     * ★ 用例常量必须与 application.yml 的默认值真的相等 ★
     * <p>
     * 不相等时本用例报红并直接点名是哪一项、yml 里是什么、用例里是什么。
     * 有它兜着，改配置的人不可能「只改了 yml」而让下面那些用例继续拿着旧数字自我验证。
     */
    @Test
    @DisplayName("用例里的常量与 application.yml 的 ai-guard 默认值一致 —— 防止拿旧数字自我验证的假绿")
    void testConstantsMatchApplicationYml() throws Exception {
        String yml = readClasspath("/application.yml");
        assertEquals(USER_MAX_CALLS, placeholderDefault(yml, "AI_GUARD_USER_MAX_CALLS"),
                "yml 的 user-max-calls 默认值变了，本类的 USER_MAX_CALLS 也必须跟着改");
        assertEquals(GLOBAL_MAX_CALLS, placeholderDefault(yml, "AI_GUARD_GLOBAL_MAX_CALLS"),
                "yml 的 global-max-calls 默认值变了，本类的 GLOBAL_MAX_CALLS 也必须跟着改");
        assertEquals(WINDOW_SECONDS, placeholderDefault(yml, "AI_GUARD_WINDOW_SECONDS"),
                "yml 的 window-seconds 默认值变了，本类的 WINDOW_SECONDS 也必须跟着改");
    }

    // ==================== 用户维度 ====================

    @Test
    @DisplayName("额度用满即拒绝：第 N 次放行、第 N+1 次被拦，且给的是 1001 而不是 401/500")
    void rejectsAfterQuotaExhausted() {
        AiQuotaGuard guard = new AiQuotaGuard(3, 0, WINDOW_SECONDS, now::get);

        for (int i = 0; i < 3; i++) {
            assertDoesNotThrow(() -> guard.acquire(ALICE), "第 " + (i + 1) + " 次应放行");
        }

        BusinessException e = assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode(),
                "必须是 1001（业务拒绝）：401 会让前端清 token 把人踢下线，500 会污染服务端异常告警");
        assertTrue(e.getMessage().contains("频繁"), "应说清是被限流，实际：" + e.getMessage());
        assertTrue(e.getMessage().contains("10 分钟"),
                "应给出窗口长度（600 秒 = 10 分钟），实际：" + e.getMessage());
        assertTrue(e.getMessage().contains("30") || e.getMessage().contains("3"),
                "应给出额度，实际：" + e.getMessage());
    }

    @Test
    @DisplayName("限流会自己解除：窗口滑过后重新放行 —— 防「窗口写成永不过期」这种上线即永久锁死")
    void quotaRestoresAfterWindowSlides() {
        AiQuotaGuard guard = new AiQuotaGuard(2, 0, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);
        guard.acquire(ALICE);
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE));

        now.addAndGet(WINDOW_MS - 1);
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE),
                "还差 1 毫秒就到期，必须仍然拦着（差一点就放行说明窗口边界写错了）");

        now.addAndGet(2);
        assertDoesNotThrow(() -> guard.acquire(ALICE), "越过窗口后必须恢复");
    }

    @Test
    @DisplayName("用户维度彼此隔离：alice 用满不牵连 bob")
    void usersAreIsolated() {
        AiQuotaGuard guard = new AiQuotaGuard(1, 0, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
        assertDoesNotThrow(() -> guard.acquire(BOB));
    }

    @Test
    @DisplayName("userId 为 null 时只按全站维度计数，不抛异常也不新建条目")
    void nullUserIdOnlyCountsGlobal() {
        AiQuotaGuard guard = new AiQuotaGuard(1, 5, WINDOW_SECONDS, now::get);
        assertDoesNotThrow(() -> guard.acquire(null));
        assertDoesNotThrow(() -> guard.acquire(null), "null 不该被当成同一个「用户」限流");
        assertEquals(0, guard.trackedUsers(), "不该为 null 建条目（否则会有一个永远清不掉的 key）");
    }

    // ==================== 全站维度 ====================

    @Test
    @DisplayName("全站维度兜住「多账号分摊」：每人都远没到自己的额度，但全站到顶后一律拒绝")
    void globalDimensionCatchesManyAccounts() {
        // 用户额度 100（谁都到不了），全站额度 5
        AiQuotaGuard guard = new AiQuotaGuard(100, 5, WINDOW_SECONDS, now::get);
        for (int i = 0; i < 5; i++) {
            final long uid = 1000L + i;
            assertDoesNotThrow(() -> guard.acquire(uid));
        }

        // 这是一个全新的用户，它自己的计数是 0 —— 被拦只可能是全站维度生效
        BusinessException e = assertThrows(BusinessException.class, () -> guard.acquire(9999L));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode());
        assertTrue(e.getMessage().contains("稍后") || e.getMessage().contains("较多"),
                "全站维度的文案应与用户维度区分开（用户看到的不该是自己的额度用完了），实际：" + e.getMessage());
        assertTrue(!e.getMessage().contains("每 "),
                "★ 全站上限的具体数字不许回给调用方 ★：那是运营侧账单阈值，告诉他等于告诉他"
                        + "「再注册几个账号就能把这条网打穿」。实际：" + e.getMessage());

        // 全站恢复后，新用户又能用
        now.addAndGet(WINDOW_MS + 1);
        assertDoesNotThrow(() -> guard.acquire(9999L));
    }

    // ==================== 拒绝时不消耗另一个维度 ====================

    @Test
    @DisplayName("用户维度超限时，全站计数不被吃掉 —— 否则少数人的滥用会提前耗光全站额度")
    void rejectedByUserDoesNotConsumeGlobal() {
        AiQuotaGuard guard = new AiQuotaGuard(1, 3, WINDOW_SECONDS, now::get);

        guard.acquire(ALICE);                       // 全站 1/3，alice 1/1
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE)); // 被用户维度拦下
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE));

        // 全站只剩 2 次，若上面两次被计入，这里第 3 个用户就会失败
        assertDoesNotThrow(() -> guard.acquire(BOB));
        assertDoesNotThrow(() -> guard.acquire(100L));
        assertThrows(BusinessException.class, () -> guard.acquire(101L), "全站 3 次用满，第 4 次才该被拦");
    }

    @Test
    @DisplayName("全站维度超限时，用户计数不被吃掉、也不为该用户建条目")
    void rejectedByGlobalDoesNotConsumeUser() {
        int globalCap = 100;
        // 用户额度 3，全站额度 100
        AiQuotaGuard guard = new AiQuotaGuard(3, globalCap, WINDOW_SECONDS, now::get);

        // 先用 100 个不同用户把全站打满（每个用户自己只用了 1/3，谁都到不了自己的额度）
        for (int i = 0; i < globalCap; i++) {
            guard.acquire(1000L + i);
        }
        assertEquals(globalCap, guard.trackedUsers());

        // 全站已满：alice 的请求被全站维度拦下
        BusinessException e = assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
        assertTrue(e.getMessage().contains("较多") || e.getMessage().contains("稍后"),
                "应是被全站维度拦下，实际：" + e.getMessage());
        assertEquals(globalCap, guard.trackedUsers(),
                "★ 被全站拦下的请求不该为 alice 建条目 ★：判得越早代价越小，"
                        + "否则在全站打满的窗口里猛调就能逐个撑大 byUser");

        // 窗口滑过后，alice 的额度必须是完整的 3 次（被拒的那次没被记进她的账）
        now.addAndGet(WINDOW_MS + 1);
        assertDoesNotThrow(() -> guard.acquire(ALICE));
        assertDoesNotThrow(() -> guard.acquire(ALICE));
        assertDoesNotThrow(() -> guard.acquire(ALICE));
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE),
                "alice 的窗口内恰好 3 次，第 4 次才该被自己的额度拦下");
    }

    // ==================== 配置口径 ====================

    @Test
    @DisplayName("0 表示该维度不限（不是「一次就锁」）—— 这是留给课堂演示的逃生口")
    void zeroMeansUnlimited() {
        AiQuotaGuard guard = new AiQuotaGuard(0, 0, WINDOW_SECONDS, now::get);
        for (int i = 0; i < 500; i++) {
            guard.acquire(ALICE);
        }
        assertEquals(0, guard.trackedUsers(), "两个维度都关掉时不该再记账（省内存）");
    }

    @Test
    @DisplayName("负数同样表示不限 —— 「配错了」不该把用户挡在门外")
    void negativeMeansUnlimited() {
        AiQuotaGuard guard = new AiQuotaGuard(-1, -1, WINDOW_SECONDS, now::get);
        for (int i = 0; i < 100; i++) {
            guard.acquire(ALICE);
        }
    }

    @Test
    @DisplayName("窗口配 0 会被收敛到 1 秒，而不是 0 毫秒 —— 0 毫秒窗口等于闸门静默失效")
    void zeroWindowIsClampedToOneSecond() {
        AiQuotaGuard guard = new AiQuotaGuard(2, 0, 0, now::get);
        guard.acquire(ALICE);
        guard.acquire(ALICE);
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE),
                "若窗口是 0 毫秒，计数每次都会归零，第 3 次会被放行 —— 那等于闸门没装");

        now.addAndGet(1001); // 越过 1 秒
        assertDoesNotThrow(() -> guard.acquire(ALICE));
    }

    @Test
    @DisplayName("窗口不足 1 分钟时，提示不会出现「请 0 分钟后再试」")
    void shortWindowStillReportsAtLeastOneMinute() {
        AiQuotaGuard guard = new AiQuotaGuard(1, 0, 30, now::get);
        guard.acquire(ALICE);
        BusinessException e = assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
        assertTrue(!e.getMessage().contains("0 分钟"), "30 秒窗口被折算成「0 分钟」等于什么都没说，实际：" + e.getMessage());
        assertTrue(e.getMessage().contains("1 分钟"), "应向上取整到 1 分钟，实际：" + e.getMessage());
    }

    // ==================== 惰性清理 ====================

    @Test
    @DisplayName("惰性清理：窗口已滑过的条目被整体回收（内存不会随随机 userId 单调增长）")
    void purgeReclaimsStaleEntries() {
        AiQuotaGuard guard = defaults();
        for (int i = 0; i < 300; i++) {
            guard.acquire((long) i);
        }
        assertEquals(300, guard.trackedUsers());

        now.addAndGet(WINDOW_MS + 1);
        guard.acquire(90001L);

        assertEquals(1, guard.trackedUsers(),
                "300 条过期条目应在这一次清理中全部回收，只剩刚写入的；实际 "
                        + guard.trackedUsers() + " 条（回收失效会让内存随随机 userId 单调增长）");
    }

    @Test
    @DisplayName("惰性清理不误杀窗口内的条目 —— 删掉有效计数等于放行")
    void purgeKeepsLiveCounters() {
        AiQuotaGuard guard = new AiQuotaGuard(2, 0, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);          // alice 1/2，窗口才开始
        now.addAndGet(WINDOW_MS - 1000); // 仍在本窗口内

        for (int i = 0; i < 300; i++) {
            guard.acquire(10000L + i);  // 灌到水位以上，逼出清理
        }

        assertTrue(guard.trackedUsers() >= 301, "清理不该把窗口内的 alice 带走");
        guard.acquire(ALICE);          // 第 2 次，应放行（说明计数没被清掉）
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE),
                "alice 窗口内已 2 次，第 3 次应被拦 —— 若清理误删了计数，这里会被放行");
    }

    // ==================== 辅助 ====================

    private static String readClasspath(String path) throws Exception {
        try (InputStream in = AiQuotaGuardTest.class.getResourceAsStream(path)) {
            if (in == null) {
                throw new IllegalStateException("类路径下找不到 " + path + "，无法核对默认值");
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /**
     * 从 {@code ${ENV_VAR:默认值}} 里抠出默认值。
     * <p>
     * ★ 必须连变量名一起匹配 ★：只搜 {@code key:\s*(\d+)} 会全部落空，
     * 因为 yml 里的值几乎都是占位符形式（本仓踩过：审计脚本因此把已落地项误报成没做）。
     */
    private static int placeholderDefault(String yml, String envVar) {
        Matcher m = Pattern.compile(Pattern.quote(envVar) + ":(\\d+)}").matcher(yml);
        assertTrue(m.find(), "application.yml 里找不到 ${" + envVar + ":<数字>}，"
                + "可能是变量名写错、或默认值不再是纯数字");
        return Integer.parseInt(m.group(1));
    }
}
