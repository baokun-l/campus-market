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
 * 图片上传闸门测试。
 * <p>
 * ★ 时钟必须可注入 ★（与 {@code AiQuotaGuardTest} 同因）
 * <p>
 * 闸门的两条核心行为全是时间驱动的：窗口滑过要重新计数、限流要能自动解除。
 * 时钟写死就只能靠 {@code Thread.sleep(1 分钟)} 去测 —— 没人会跑那种用例，
 * 等于这两条分支<b>永远没被验证过</b>。而它们恰恰最危险：一旦有人把窗口写成「永不过期」，
 * 线上会变成「用户传了 10 张之后再也传不了图」，而单测全绿、日志无异常。
 * <p>
 * ★ 本类有两条用例是「顺序判据」而不是「结果判据」★
 * <p>
 * {@link #globalIsCheckedBeforeUserEntryIsCreated()} 与
 * {@link #userRejectionDoesNotConsumeGlobalQuota()} 证明的是**内部两步的先后**：
 * 前者靠「被全站拒掉的用户没有留下内存痕迹」，后者靠「用户维度被拒后全站额度仍然可用」。
 * 这类「先做污染性的那一步」的写法不会让任何功能出错，只会让少数人的滥用连带影响所有人，
 * ——**唯一能发现它的就是判据的次序**，所以必须专门钉住。
 */
class UploadQuotaGuardTest {

    /** 与 application.yml 的 app.upload-guard.* 默认值一一对应（由 testConstantsMatchApplicationYml 看守） */
    private static final int USER_MAX_UPLOADS = 10;
    private static final int GLOBAL_MAX_UPLOADS = 60;
    private static final int WINDOW_SECONDS = 60;

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
    private UploadQuotaGuard defaults() {
        return new UploadQuotaGuard(USER_MAX_UPLOADS, GLOBAL_MAX_UPLOADS, WINDOW_SECONDS, now::get);
    }

    /**
     * ★ 用例常量必须与 application.yml 的默认值真的相等 ★
     * <p>
     * 有它兜着，改配置的人不可能「只改了 yml」而让下面那些用例继续拿着旧数字自我验证
     * （本仓踩过：审计脚本拿裸正则去匹配 yml，占位符形式让它把已落地项误报成没做）。
     */
    @Test
    @DisplayName("用例里的常量与 application.yml 的 upload-guard 默认值一致 —— 防止拿旧数字自我验证的假绿")
    void testConstantsMatchApplicationYml() throws Exception {
        String yml = readClasspath("/application.yml");
        assertEquals(USER_MAX_UPLOADS, placeholderDefault(yml, "UPLOAD_GUARD_USER_MAX_UPLOADS"),
                "yml 的 user-max-uploads 默认值变了，本类的 USER_MAX_UPLOADS 也必须跟着改");
        assertEquals(GLOBAL_MAX_UPLOADS, placeholderDefault(yml, "UPLOAD_GUARD_GLOBAL_MAX_UPLOADS"),
                "yml 的 global-max-uploads 默认值变了，本类的 GLOBAL_MAX_UPLOADS 也必须跟着改");
        assertEquals(WINDOW_SECONDS, placeholderDefault(yml, "UPLOAD_GUARD_WINDOW_SECONDS"),
                "yml 的 window-seconds 默认值变了，本类的 WINDOW_SECONDS 也必须跟着改");
    }

    // ==================== 用户维度 ====================

    @Test
    @DisplayName("额度用满即拒绝：第 N 张放行、第 N+1 张被拦，且给的是 1001 而不是 401/500")
    void rejectsAfterQuotaExhausted() {
        UploadQuotaGuard guard = new UploadQuotaGuard(3, 0, WINDOW_SECONDS, now::get);

        for (int i = 0; i < 3; i++) {
            assertDoesNotThrow(() -> guard.acquire(ALICE), "第 " + (i + 1) + " 张应放行");
        }

        BusinessException e = assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode(),
                "必须是 1001（业务拒绝）：401 会让前端清 token 把人踢下线，500 会污染服务端异常告警");
        assertTrue(e.getMessage().contains("频繁"), "应说清是被限流，实际：" + e.getMessage());
        /*
         * ★ 提示里的窗口与额度都必须来自**生效配置** ★
         * 这是「配置可到达性」的真机/单测出口：配了 window-seconds / user-max-uploads 之后，
         * 响应里必须能看出这两个数字，否则「改了配置没反应」就无从判断
         * （本仓踩过：占位符名与代码读的键名不一致 ⇒ 静默绑不上）。
         */
        assertTrue(e.getMessage().contains(String.valueOf(WINDOW_SECONDS)),
                "应给出窗口长度（秒），实际：" + e.getMessage());
        assertTrue(e.getMessage().contains("3"), "应给出额度，实际：" + e.getMessage());
    }

    @Test
    @DisplayName("限流会自己解除：窗口滑过后重新放行 —— 防「窗口写成永不过期」这种上线即永久锁死")
    void quotaRestoresAfterWindowSlides() {
        UploadQuotaGuard guard = new UploadQuotaGuard(2, 0, WINDOW_SECONDS, now::get);
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
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 0, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);

        assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
        assertDoesNotThrow(() -> guard.acquire(BOB), "alice 被限流不该影响 bob");
    }

    @Test
    @DisplayName("user-max-uploads 配 0 = 该维度不限（课堂演示的逃生口，不是「一次就锁」）")
    void zeroUserLimitMeansUnlimited() {
        UploadQuotaGuard guard = new UploadQuotaGuard(0, 0, WINDOW_SECONDS, now::get);
        for (int i = 0; i < 50; i++) {
            assertDoesNotThrow(() -> guard.acquire(ALICE));
        }
        assertEquals(0, guard.trackedUsers(), "维度关闭时不该为它建任何内存条目");
    }

    @Test
    @DisplayName("userId 为 null 时只按全站维度计数，不抛 NPE")
    void nullUserIdCountsGlobalOnly() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 2, WINDOW_SECONDS, now::get);
        assertDoesNotThrow(() -> guard.acquire(null));
        assertDoesNotThrow(() -> guard.acquire(null));
        assertThrows(BusinessException.class, () -> guard.acquire(null), "全站维度仍然要兜住");
    }

    // ==================== 全站维度 ====================

    @Test
    @DisplayName("全站维度兜住总量：多个账号各传几次，加起来超过全站上限就拒")
    void globalDimensionCapsTotal() {
        UploadQuotaGuard guard = new UploadQuotaGuard(100, 3, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);
        guard.acquire(BOB);
        guard.acquire(9L);

        BusinessException e = assertThrows(BusinessException.class, () -> guard.acquire(10L),
                "用户维度还很宽裕，但全站已经满了，必须拒");
        // ★ 刻意不告诉调用方全站上限 ★：那是运营侧的容量阈值，回给他等于教他「再注册几个号就能打穿」
        assertTrue(!e.getMessage().contains("3"),
                "全站维度的拒绝提示不该泄露具体阈值，实际：" + e.getMessage());
    }

    @Test
    @DisplayName("全站维度**先判**：被它拒掉的用户不留下内存条目（判得越早代价越小）")
    void globalIsCheckedBeforeUserEntryIsCreated() {
        UploadQuotaGuard guard = new UploadQuotaGuard(100, 1, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);
        assertEquals(1, guard.trackedUsers());

        assertThrows(BusinessException.class, () -> guard.acquire(BOB));
        /*
         * 若实现把用户条目建在了全站判断之前，这里会是 2：
         * 攻击者用海量随机账号猛发请求时，被拒的请求照样把 Map 撑大。
         */
        assertEquals(1, guard.trackedUsers(),
                "被全站维度拒掉的请求不该为它建立用户条目（说明全站判断排在了建条目之后）");
    }

    @Test
    @DisplayName("用户维度被拒**不消耗**全站额度（判定与消耗必须一起原子完成）")
    void userRejectionDoesNotConsumeGlobalQuota() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 2, WINDOW_SECONDS, now::get);
        guard.acquire(ALICE);                                                // 全站 1/2
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE));   // 用户维度命中，全站应仍是 1/2

        /*
         * ★ 这是本用例的唯一判别点 ★
         * bob 还站在全站上限之内（还剩 1 个名额），所以「能放行」本身就证明了
         * 上一次被用户维度拒掉的请求**没有**顺手把全站计数 +1。
         * 若实现写成「判一个、+1、再判下一个」，全站会被提前吃成 2/2，
         * 这里 bob 就会撞在全站分支上 —— 也就是「少数人的滥用连累了所有人」。
         */
        assertDoesNotThrow(() -> guard.acquire(BOB),
                "用户维度被拒的那次不该吃掉全站额度；这里被拒说明全站计数被提前消耗了");
    }

    // ==================== 配置口径 ====================

    @Test
    @DisplayName("window-seconds 配 0 被收敛到 1 秒，而不是变成「窗口恒为零 ⇒ 闸门静默失效」")
    void zeroWindowIsClampedToOneSecond() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 0, 0, now::get);
        guard.acquire(ALICE);
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE),
                "0 秒窗口若原样生效，计数会永远从 0 开始 ⇒ 闸门变成摆设");

        now.addAndGet(1001);
        assertDoesNotThrow(() -> guard.acquire(ALICE));
    }

    @Test
    @DisplayName("惰性清理：窗口内的条目留着（删掉等于放行），窗口外的条目被回收")
    void purgeReclaimsOnlyExpiredEntries() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 0, WINDOW_SECONDS, now::get);
        // 造够触发水位（PURGE_THRESHOLD = 256）的条目
        for (long i = 0; i < 300; i++) {
            guard.acquire(i);
        }
        assertEquals(300, guard.trackedUsers());

        now.addAndGet(WINDOW_MS + 1);
        guard.acquire(999_999L);                     // 这一次会触发清理

        assertEquals(1, guard.trackedUsers(),
                "窗口已滑过的 300 个条目都应被回收，只该剩下刚建的那一个");
    }

    @Test
    @DisplayName("窗口内的条目不会被误删（清理门限不能变成「随手清空」）")
    void purgeKeepsEntriesStillInsideWindow() {
        UploadQuotaGuard guard = new UploadQuotaGuard(2, 0, WINDOW_SECONDS, now::get);
        for (long i = 0; i < 300; i++) {
            guard.acquire(i);
        }
        // 只前进一点点，所有条目仍在窗口内 ⇒ 一个都不能删
        now.addAndGet(WINDOW_MS - 1);
        guard.acquire(888_888L);

        assertEquals(301, guard.trackedUsers(),
                "窗口内的计数还有效，被清掉等于把刚才限的流放开了");
    }

    @Test
    @DisplayName("默认口径自检：10 张 / 60 秒，与 yml 一致且确实会生效")
    void defaultsBehave() {
        UploadQuotaGuard guard = defaults();
        for (int i = 0; i < USER_MAX_UPLOADS; i++) {
            assertDoesNotThrow(() -> guard.acquire(ALICE), "默认额度内第 " + (i + 1) + " 张应放行");
        }
        assertThrows(BusinessException.class, () -> guard.acquire(ALICE));
    }

    // ==================== 辅助 ====================

    private static String readClasspath(String path) throws Exception {
        try (InputStream in = UploadQuotaGuardTest.class.getResourceAsStream(path)) {
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
     * 因为 yml 里的值几乎都是占位符形式。
     */
    private static int placeholderDefault(String yml, String envVar) {
        Matcher m = Pattern.compile(Pattern.quote(envVar) + ":(\\d+)}").matcher(yml);
        assertTrue(m.find(), "application.yml 里找不到 ${" + envVar + ":<数字>}，"
                + "可能是变量名写错、或默认值不再是纯数字");
        return Integer.parseInt(m.group(1));
    }
}
