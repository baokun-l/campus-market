package com.campus.market.security;

import com.campus.market.common.BusinessException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongSupplier;

/**
 * 登录失败闸门：按「账号」与「来源 IP」两个维度累计失败次数，超限临时锁定。
 * <p>
 * ★ 为什么必须有它 ★
 * <p>
 * {@code POST /user/login} 原先没有任何次数约束：一个脚本可以每秒打几百次，
 * 把 {@code t_user} 当字典逐条试。BCrypt 只是把每次尝试的成本抬高（约 100ms），
 * 它<a>不限制尝试次数</a>——离线跑一晚上，任何弱口令都会被撞开。
 * 唯一真正的解法就是「次数 + 时间窗 + 锁定」。
 * <p>
 * ★ 两个维度分工不同，都不能省 ★
 * <ul>
 *   <li><b>账号维度</b>（主）：同账号连续 5 次失败 → 锁 15 分钟。
 *       这是真正拦住「盯着一个账号猛试」的那道闸。</li>
 *   <li><b>IP 维度</b>（辅）：同一来源 15 分钟内累计 100 次失败 → 锁 5 分钟。
 *       账号维度拦不住「用 1 个弱口令去撞 1000 个账号」的撞库（每个账号只错一次，
 *       谁都不到 5 次），这条粗网兜的正是它。</li>
 * </ul>
 * <p>
 * ★ IP 维度的阈值为什么定得这么「松」（100 次）且锁得这么短（5 分钟）★
 * <p>
 * 因为它的假阳性代价远大于漏报代价：校园网、公司出口、反向代理背后的用户
 * <b>共用同一个公网地址</b>，阈值定低会变成「一个人手滑，整栋楼登不上」，
 * 而这是纯功能性的、立刻可见的可用性事故。反过来，100 次失败在 15 分钟内
 * 已经足够暴露脚本行为，5 分钟的停顿也足以打断自动化撞库。
 * 一句话：<b>账号维度负责拦人，IP 维度只负责拦脚本</b>，两者的松紧标准本来就不同。
 * 真要更严，把 {@code app.login-guard.ip-max-fails} 调小即可；
 * 想彻底关掉这条辅网，把它调成一个现实中到不了的大数（如 1000000）。
 * <p>
 * ★ 为什么用内存而不是加依赖（Redis / Bucket4j / Sentinel）★
 * <p>
 * 本项目的部署形态是单实例（见 {@code docs/服务器部署适配清单.md}），
 * 内存计数已经能覆盖当前风险；为此引入 Redis 会凭空多出一个「必须活着」的组件,
 * 而 Redis 挂掉时要么整站登不上、要么闸门静默失效，两种都比现在差。
 * <b>已知边界</b>：多实例部署时每个实例各算各的，总容忍度会放大到 N 倍
 * （与 {@code OrderService} 的单实例自增订单号是同一类问题，见缺陷清单 L5）。
 * 真要多实例部署，把本类内部的 {@code Map} 换成 Redis INCR + EXPIRE 即可，
 * 对外接口（三个方法）不用动。
 * <p>
 * ★ 刻意不读 {@code X-Forwarded-For} ★
 * <p>
 * 该请求头完全由客户端提供，任何人都能随手填一个随机值——一旦采信，
 * IP 维度就形同虚设（攻击者每次换一个假 IP 即可无限试），比不装还糟：
 * 它给人「已经防住了」的错觉。所以这里取的是 TCP 对端地址
 * （{@code request.getRemoteAddr()}）。部署到反向代理之后，
 * 所有请求的对端都会变成代理自己的地址，正确做法是开启 Spring 的
 * forward-headers 处理并**显式声明受信代理**，那是部署期配置项，
 * 已记在部署适配清单里，不在本类里猜。
 * <p>
 * ★ 失败计数为什么在 Service 而不是在拦截器里 ★
 * <p>
 * 「什么算一次失败」是业务判断：口令错误要计，但<b>被封禁的账号输对了口令</b>不算
 * （那是管理动作的结果，不是攻击特征，把它计进去会让被封的人打 5 次就把自己
 * 从「封禁」变成「封禁 + 锁定」，用户看到的信息毫无意义）。放在 Service 层
 * 才能贴着口令校验的位置精确判断，也才测得到。
 */
@Component
public class LoginAttemptGuard {

    private static final Logger log = LoggerFactory.getLogger(LoginAttemptGuard.class);

    /**
     * 触发惰性清理的水位。
     * <p>
     * 条目只在「登录成功」时才被删除，而密码错误得多的账号永远不会成功——
     * 如果每次失败都全表扫一遍过期条目，攻击者可以用大量随机用户名
     * 把单次请求变成 O(n) 扫描。所以只在超过水位时清一次，
     * 正常规模的站点根本不会走到这个分支。
     */
    private static final int PURGE_THRESHOLD = 256;

    private final int maxFails;
    private final long windowMs;
    private final long lockMs;
    private final int ipMaxFails;
    private final long ipLockMs;
    private final LongSupplier clock;

    /** 账号维度：key = 归一化后的用户名 */
    private final Map<String, Attempt> byUsername = new ConcurrentHashMap<>();

    /** IP 维度：key = 对端地址 */
    private final Map<String, Attempt> byIp = new ConcurrentHashMap<>();

    @Autowired
    public LoginAttemptGuard(
            @Value("${app.login-guard.max-fails:5}") int maxFails,
            @Value("${app.login-guard.window-seconds:900}") int windowSeconds,
            @Value("${app.login-guard.lock-seconds:900}") int lockSeconds,
            @Value("${app.login-guard.ip-max-fails:60}") int ipMaxFails,
            @Value("${app.login-guard.ip-lock-seconds:600}") int ipLockSeconds) {
        this(maxFails, windowSeconds, lockSeconds, ipMaxFails, ipLockSeconds, System::currentTimeMillis);
    }

    /**
     * 注入假时钟的构造器（<b>供测试使用</b>）。
     * <p>
     * ★ 为什么这个口子要开在 public ★
     * <p>
     * 「锁到期自动解除」只能靠推进时间验证。若把时钟写死成
     * {@code System.currentTimeMillis()}，这条分支就只能用
     * {@code Thread.sleep(15 分钟)} 去测 —— 那样的用例不会有人跑，
     * 等于它<b>从来没被验证过</b>：一旦有人把锁写成「永不过期」，
     * 上线后凡是输错 5 次密码的账号就被永久锁死，而单测全绿、日志无异常。
     * <p>
     * 而且时钟是个纯内部依赖（只影响「现在几点」这一个输入），
     * 把它做成可注入的完全不影响生产行为：Spring 走上面那个
     * {@code @Autowired} 构造器，永远是真实时钟。
     */
    public LoginAttemptGuard(int maxFails, int windowSeconds, int lockSeconds,
                             int ipMaxFails, int ipLockSeconds, LongSupplier clock) {
        // 允许配置写成 0 或负数：此时收敛到 1，退化成「一次就锁」，
        // 而不是算出 0ms 的窗口（意味着一失败就永久保持锁定，比配错更糟）
        this.maxFails = Math.max(1, maxFails);
        this.windowMs = Math.max(1L, windowSeconds) * 1000L;
        this.lockMs = Math.max(1L, lockSeconds) * 1000L;
        this.ipMaxFails = Math.max(1, ipMaxFails);
        this.ipLockMs = Math.max(1L, ipLockSeconds) * 1000L;
        this.clock = clock;
    }

    /**
     * 登录前置闸门：一旦命中锁定立即拒绝，<b>不查库、不比口令</b>。
     * <p>
     * 放在最前面有两个好处：被锁的账号连 BCrypt 那 100ms 都省了（锁定期间
     * 反而比正常登录更便宜）；同时避免了对已锁定账号继续做无谓的库查询。
     *
     * @param username 原始用户名（大小写/首尾空白不敏感）
     * @param clientIp 来源地址，null 表示拿不到（只跳过 IP 维度）
     */
    public void assertNotLocked(String username, String clientIp) {
        long now = clock.getAsLong();
        String accountKey = accountKey(username);
        if (accountKey != null) {
            Attempt a = byUsername.get(accountKey);
            if (a != null && a.lockedUntilMs > now) {
                long left = a.lockedUntilMs - now;
                log.warn("登录闸门：账号 [{}] 处于锁定中，剩余 {} 秒", accountKey, left / 1000);
                throw BusinessException.paramError(
                        "登录尝试次数过多，该账号已临时锁定，请 " + remainMinutes(left) + " 分钟后再试");
            }
        }
        if (clientIp != null && !clientIp.isBlank()) {
            Attempt a = byIp.get(clientIp.trim());
            if (a != null && a.lockedUntilMs > now) {
                long left = a.lockedUntilMs - now;
                log.warn("登录闸门：来源 IP [{}] 处于锁定中，剩余 {} 秒", clientIp, left / 1000);
                throw BusinessException.paramError(
                        "当前网络登录尝试过于频繁，请 " + remainMinutes(left) + " 分钟后再试");
            }
        }
    }

    /**
     * 记一次失败。达到阈值即锁定，同一个失败请求不会既计数又立刻被自己锁死
     * （调用方先过 {@link #assertNotLocked}，所以第 5 次失败的响应仍然是
     * 「用户名或密码错误」，第 6 次才会看到锁定提示——这是刻意的：
     * 用户输错第 5 次时该看到的仍然是「密码错了」，而不是一条看不懂的锁定通知）。
     * <p>
     * ★ 不存在的用户名同样计数 ★：否则「锁不锁」本身就成了账号是否存在的探测器。
     */
    public void onFailure(String username, String clientIp) {
        long now = clock.getAsLong();
        purgeIfNeeded(byUsername, now);
        purgeIfNeeded(byIp, now);

        String accountKey = accountKey(username);
        if (accountKey != null) {
            record(byUsername, accountKey, now, maxFails, lockMs, "账号");
        }
        if (clientIp != null && !clientIp.isBlank()) {
            record(byIp, clientIp.trim(), now, ipMaxFails, ipLockMs, "来源 IP");
        }
    }

    /**
     * 登录成功：清空该账号的失败记录。
     * <p>
     * ★ 刻意<b>不</b>清 IP 计数 ★：攻击者只要手上有一个自己的正常账号，
     * 就能靠「撞几次 → 登录一次自己的账号 → 再撞几次」把 IP 计数无限清零，
     * 那条辅网会被完全绕开。账号计数没有这个问题（成功登录的账号正是他不再需要撞的那个），
     * 所以两个维度的清理策略不同 —— 看起来不对称，是有意的。
     */
    public void onSuccess(String username) {
        String accountKey = accountKey(username);
        if (accountKey != null) {
            byUsername.remove(accountKey);
        }
    }

    // ==================== 内部实现 ====================

    /**
     * 当前跟踪的账号条目数。
     * <p>
     * ★ 只为测试而存在 ★：内存回收属于「不写用例就等于没写过」的那类逻辑 ——
     * 回收失效不会报错、不会影响任何功能，只会让进程的内存随随机用户名
     * 单调增长，直到某天 OOM。没有这个可观测点，测试就只能靠反射去掏私有字段。
     */
    int trackedAccounts() {
        return byUsername.size();
    }

    private void record(Map<String, Attempt> map, String key, long now,
                        int limit, long lockMillis, String label) {
        Attempt a = map.computeIfAbsent(key, k -> new Attempt(now));
        synchronized (a) {
            if (now - a.windowStartMs > windowMs) {
                // 窗口已滑过：前面的失败不再算数，重新起一段
                a.windowStartMs = now;
                a.fails.set(0);
            }
            if (a.lockedUntilMs > now) {
                // 已锁定期间的请求根本进不来（assertNotLocked 已挡掉），
                // 这里只是兜底：不重复计数，更不因继续尝试而延长锁定
                return;
            }
            if (a.fails.incrementAndGet() >= limit) {
                a.lockedUntilMs = now + lockMillis;
                a.fails.set(0);
                a.windowStartMs = now;
                log.warn("登录闸门：{} [{}] 连续失败 {} 次，锁定 {} 秒",
                        label, key, limit, lockMillis / 1000);
            }
        }
    }

    /**
     * 用户名归一化。
     * <p>
     * ★ 必须忽略大小写 ★：{@code t_user.username} 上的唯一索引在 utf8mb4_general_ci
     * 下也是大小写不敏感的，而登录查的是精确匹配。若按原样计数，
     * 攻击者把 Alice / alice / ALICE 当三个 key 用，就能拿到 3 倍尝试次数。
     * 归一化后同一账号的所有大小写变体共用一个计数，且不会误伤真实用户
     * （本人当然知道自己注册时用的是哪个大小写）。
     */
    private static String accountKey(String username) {
        if (username == null || username.isBlank()) {
            return null;
        }
        return username.trim().toLowerCase(Locale.ROOT);
    }

    private void purgeIfNeeded(Map<String, Attempt> map, long now) {
        if (map.size() < PURGE_THRESHOLD) {
            return;
        }
        map.entrySet().removeIf(e -> {
            Attempt a = e.getValue();
            // 只有「锁已到期 且 窗口已滑过」的条目才是真正的垃圾：
            // 前者还在锁定中，后者还可能在窗口内继续累计
            return a.lockedUntilMs <= now && now - a.windowStartMs > windowMs;
        });
    }

    /** 剩余时长折算成分钟，向上取整且至少 1（「请 0 分钟后再试」等于没说） */
    private static int remainMinutes(long leftMs) {
        return (int) Math.max(1L, (leftMs + 59_999L) / 60_000L);
    }

    /** 单个 key 的计数状态：失败次数 + 窗口起点 + 锁定截止时刻 */
    private static final class Attempt {
        private final AtomicInteger fails = new AtomicInteger();
        private volatile long windowStartMs;
        private volatile long lockedUntilMs;

        private Attempt(long now) {
            this.windowStartMs = now;
        }
    }
}
