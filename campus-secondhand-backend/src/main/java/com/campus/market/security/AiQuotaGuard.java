package com.campus.market.security;

import com.campus.market.common.BusinessException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * AI 调用闸门：按「用户」与「全站」两个维度限制单位时间内的调用次数。
 * <p>
 * ★ 为什么必须有它 ★
 * <p>
 * {@code POST /ai/chat} 与 {@code POST /ai/generate-description} 都要登录才能调，
 * 但这**不等于**安全：任何一个注册过的学生账号，写一个三行的 for 循环就能把这
 * 两个接口打上万次。每一次调用都是一笔真实支出（token 费用）与一次外部依赖占用，
 * 而闸门之前全仓 {@code RateLimit} / 配额相关代码对这两个接口<b>一处都没有</b>
 * —— 也就是说，一个普通学生账号足以把当月额度烧光、把接口拖到全站超时。
 * 登录只是「谁在按」，闸门管的是「能按几下」。两者是两件事。
 * <p>
 * ★ 两个维度分工不同，都不能省 ★
 * <ul>
 *   <li><b>用户维度</b>（主）：单个账号在窗口内最多 {@code user-max-calls} 次。
 *       拦住的是「一个人写脚本」和「一个人反复点按钮」。它管的是**公平**。</li>
 *   <li><b>全站维度</b>（兜底）：全站窗口内最多 {@code global-max-calls} 次。
 *       它管的是**钱** —— 费用是按调用次数产生的，与「是谁在调」无关。
 *       用户维度拦不住「注册 100 个账号各调 29 次」，全站维度才是那条真正兜住
 *       账单的网。反过来说，全站维度也是唯一能在上游开始限流/涨价时保护自己的开关。</li>
 * </ul>
 * 任一维度命中即拒绝，两个维度各自独立计数、互不清零。
 * <p>
 * ★ 为什么是「一个方法」而不是 {@code LoginAttemptGuard} 那样的 assert / record 两步 ★
 * <p>
 * {@code LoginAttemptGuard} 必须把「判定」和「记账」分开，因为「什么算一次失败」是
 * 业务判断，要在口令校验之后才知道。这里没有这个问题：<b>只要请求进来了就算一次消耗</b>，
 * 成功与失败都一样花掉了一次调用额度。既然判定条件在入口处就完全确定，
 * 就应该合成一次原子操作 —— 拆成两步反而制造了一个「判过了但还没记上」的窗口，
 * 并发下多个请求可以同时挤过这个窗口。
 * <p>
 * ★ 为什么用一把锁，而不是像 {@code LoginAttemptGuard} 那样各条目自己加锁 ★
 * <p>
 * 这里有个必须原子的组合动作：<b>先判两个维度有没有超限，再一起把两个计数都 +1</b>。
 * 如果两个维度用两把锁，就可能出现「用户维度判定通过、全站维度同时被另一个线程顶到超限」，
 * 结果是这次调用既不该放行、倒是已经把用户维度的计数吃掉了。
 * 临界区极短（几次整数比较和自增），而 AI 调用本身要以秒计，
 * 一把锁带来的串行化在这个接口上完全不是瓶颈。
 * <p>
 * ★ 0 / 负数 / 缺配置 = 该维度不限（不是「一次就锁」）★
 * <p>
 * 沿用本仓既有的配置口径（见 {@code application.yml} 的 {@code goods-maintenance} 段）：
 * <b>缺配置一律放宽，绝不收紧</b>。把 {@code user-max-calls} 配成 0 表示这条维度关闭，
 * 是为了让课堂演示能连点几次而不必等窗口 —— 它是一个**有意留出的逃生口**，
 * 不是一个「配错了就把用户挡在门外」的坑。
 * <p>
 * 唯一的例外是 {@code window-seconds}：它配成 0 会被收敛到 1 秒，而不是变成 0 毫秒。
 * 0 毫秒的窗口意味着「每次请求窗口都刚滑过」⇒ 计数永远从 0 开始 ⇒ 闸门静默失效，
 * 而配置看起来「只是设小了一点」。1 秒窗口虽然也很松，但它至少还是一个真实的界限。
 * <p>
 * ★ 刻意<b>不</b>读 {@code X-Forwarded-For} ★
 * <p>
 * 与 {@code LoginAttemptGuard} 一致：该请求头完全由客户端提供，任何人都能随手伪造，
 * 采信它等于给攻击者一个「每次换一个身份」的开关。本类用的是登录态里的 userId
 * （由 {@code AuthInterceptor} 从 JWT 解出、并已回查数据库确认账号有效），
 * 这是这个接口上唯一真实可信的身份。
 * <p>
 * ★ 已知边界 ★
 * <p>
 * 纯内存实现，单实例部署下有效；多实例部署时每个实例各算各的，总容忍度会放大到 N 倍
 * （与 {@code LoginAttemptGuard}、{@code InstanceSeqGenerator} 是同一类边界）。
 * 真要多实例，把内部的 {@code Map} 换成 Redis INCR + EXPIRE 即可，对外方法不用动。
 * 重启即清零，所以它挡的是「持续滥用」，不是「重启即绕过」——后者要靠部署侧的调用配额。
 */
@Component
public class AiQuotaGuard {

    private static final Logger log = LoggerFactory.getLogger(AiQuotaGuard.class);

    /**
     * 触发惰性清理的水位。
     * <p>
     * 条目只有在窗口滑过之后才是垃圾，而窗口本身通常以分钟计 —— 所以正常规模的站点
     * 根本走不到这个分支。设水位是为了防「用海量随机账号把单次请求拖成 O(n) 全表扫描」，
     * 与 {@code LoginAttemptGuard} 同一思路。
     */
    private static final int PURGE_THRESHOLD = 256;

    /** 单个用户在窗口内的最大调用次数；&lt;= 0 表示该维度不限 */
    private final int userMaxCalls;

    /** 全站在窗口内的最大调用次数；&lt;= 0 表示该维度不限 */
    private final int globalMaxCalls;

    /** 计数窗口长度。下限 1 秒 —— 见类注释「为什么窗口不能是 0」 */
    private final long windowMs;

    private final LongSupplier clock;

    /** 判定与消耗必须落在同一个临界区里（见类注释），所以用一把独立锁 */
    private final Object lock = new Object();

    /** 用户维度：key = userId 的字符串形式 */
    private final Map<String, Window> byUser = new ConcurrentHashMap<>();

    /** 全站维度：只有一个计数器，但它与用户维度共享同一把锁 */
    private final Window global = new Window();

    @Autowired
    public AiQuotaGuard(
            @Value("${app.ai-guard.user-max-calls:30}") int userMaxCalls,
            @Value("${app.ai-guard.global-max-calls:300}") int globalMaxCalls,
            @Value("${app.ai-guard.window-seconds:600}") int windowSeconds) {
        this(userMaxCalls, globalMaxCalls, windowSeconds, System::currentTimeMillis);
    }

    /**
     * 注入假时钟的构造器（<b>供测试使用</b>）。
     * <p>
     * 理由与 {@code LoginAttemptGuard} 完全相同：本类的核心行为全是时间驱动的
     * （窗口滑过要重新计数、限流要能自动解除），时钟写死就只能靠
     * {@code Thread.sleep(10 分钟)} 去测 —— 没人会跑那种用例，
     * 等于「限流到期」这条分支<b>永远没被验证过</b>。
     * 一旦有人把窗口写成「永不过期」，线上会变成「用户用了 30 次之后永远用不了 AI」，
     * 而单测全绿、日志无异常。
     * <p>
     * Spring 走上面那个 {@code @Autowired} 构造器，永远是真实时钟；
     * 这个口子只影响「现在几点」这一个输入，不影响任何生产行为。
     */
    public AiQuotaGuard(int userMaxCalls, int globalMaxCalls, int windowSeconds, LongSupplier clock) {
        this.userMaxCalls = userMaxCalls;
        this.globalMaxCalls = globalMaxCalls;
        this.windowMs = Math.max(1L, windowSeconds) * 1000L;
        this.clock = clock;
    }

    /**
     * 申请一次 AI 调用额度：超限抛 {@link BusinessException}（业务码 1001），否则计数 +1。
     * <p>
     * <b>调用它就算消耗了一次额度</b>，无论后续 AI 调用成功与否 —— 失败的调用同样
     * 占用了外部依赖、同样可能已经产生费用，没有理由退还额度。
     * <p>
     * ★ 必须在拼 prompt 之前、且必须在业务的 try/catch <b>之外</b>调用 ★
     * <p>
     * 放进降级用的 try/catch 里会被静默吃掉：AI 明明已经被限流，用户拿到的却是
     * 一段看起来完全正常的模板文案（本类异常的文案里有「过于频繁」，模板文案里没有），
     * 于是「限流生效了」这件事在界面上和日志里都看不出来。
     *
     * @param userId 当前登录用户 id（由 {@code AuthInterceptor} 解析）；为 null 时只按全站维度计数
     */
    public void acquire(Long userId) {
        long now = clock.getAsLong();
        synchronized (lock) {
            rollWindow(global, now);

            /*
             * ★ 全站维度先判，而且要在建用户条目之前判 ★
             *
             * 判得越早，代价越小：在全站已经被打满的那个窗口里，攻击者继续猛调
             * 也只会在这一行被拒，不会逐个 computeIfAbsent 把 byUser 撑大。
             * 反过来说，如果先建用户条目再判全站，被拒的请求一样留下了内存痕迹。
             */
            if (globalMaxCalls > 0 && global.count >= globalMaxCalls) {
                // ★ 刻意不告诉调用方全站上限是多少 ★
                // 那是运营侧的账单阈值，与单个用户的行为无关；把具体数字回给他，
                // 等于免费告诉他「再注册几个账号就能把这条网打穿」。
                log.warn("AI 闸门：全站 {} 秒内已调用 {} 次，达到上限 {}，本次拒绝",
                        windowMs / 1000, global.count, globalMaxCalls);
                throw BusinessException.paramError("AI 助手当前使用人数较多，请稍后再试");
            }

            Window user = null;
            if (userMaxCalls > 0 && userId != null) {
                user = byUser.computeIfAbsent(userId.toString(), k -> newWindow(now));
                rollWindow(user, now);
            }

            /*
             * ★ 判定与消耗分开写：两个维度都判完，才一起 +1 ★
             *
             * 写成「判一个、+1、再判下一个」的话，用户维度超限时全站计数已经被吃掉了
             * —— 少数人的滥用会连带把全站额度提前耗光，本来只该影响他自己。
             * （这正是「用户维度管公平、全站维度管钱」两条网必须互不污染的原因。）
             */
            if (user != null && user.count >= userMaxCalls) {
                long waitMs = user.windowStartMs + windowMs - now;
                log.warn("AI 闸门：用户 [{}] 在 {} 秒窗口内已调用 {} 次，本次拒绝（约 {} 秒后恢复）",
                        userId, windowMs / 1000, user.count, Math.max(0L, waitMs / 1000));
                throw BusinessException.paramError(
                        "AI 助手调用过于频繁，请在 " + remainMinutes(waitMs) + " 分钟后重试（每 "
                                + ceilMinutes(windowMs) + " 分钟最多 " + userMaxCalls + " 次）");
            }

            global.count++;
            if (user != null) {
                user.count++;
            }
        }
        // 清理放在锁外：它是 O(n) 的，没必要占着临界区
        purgeIfNeeded(now);
    }

    /**
     * 当前跟踪的用户条目数。
     * <p>
     * ★ 只为测试而存在 ★：内存回收属于「不写用例就等于没写过」的那类逻辑 ——
     * 回收失效不会报错、不影响任何功能，只会让进程的内存随随机 userId 单调增长。
     * 没有这个可观测点，测试就只能靠反射去掏私有字段。
     */
    int trackedUsers() {
        return byUser.size();
    }

    // ==================== 内部实现 ====================

    /**
     * 窗口滑过就重新起一段。
     * <p>
     * 注意与 {@code LoginAttemptGuard} 的一处差别：那里除了窗口还要判「是否仍在锁定期」，
     * 因为锁定是一个独立于窗口的状态。这里没有锁定态 —— 超限只是「本窗口内不许再用」，
     * 下一个窗口自然恢复，所以只需要判窗口。
     */
    private void rollWindow(Window w, long now) {
        if (now - w.windowStartMs >= windowMs) {
            w.windowStartMs = now;
            w.count = 0;
        }
    }

    private static Window newWindow(long now) {
        Window w = new Window();
        w.windowStartMs = now;
        return w;
    }

    private void purgeIfNeeded(long now) {
        if (byUser.size() < PURGE_THRESHOLD) {
            return;
        }
        // 只有「窗口已滑过」的条目才是垃圾：窗口内的计数还有效，删掉等于放行
        byUser.entrySet().removeIf(e -> now - e.getValue().windowStartMs >= windowMs);
    }

    /** 剩余时长折算成分钟，向上取整且至少 1（「请 0 分钟后再试」等于没说） */
    private static long remainMinutes(long leftMs) {
        return Math.max(1L, (Math.max(0L, leftMs) + 59_999L) / 60_000L);
    }

    /** 窗口长度折算成分钟，向上取整且至少 1（窗口配成 30 秒时不能显示成「每 0 分钟」） */
    private static long ceilMinutes(long ms) {
        return Math.max(1L, (ms + 59_999L) / 60_000L);
    }

    /** 单个维度的计数状态：窗口起点 + 窗口内已用次数（只在 {@link #lock} 保护下读写） */
    private static final class Window {
        private long windowStartMs;
        private int count;
    }
}
