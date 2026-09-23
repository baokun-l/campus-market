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
 * 图片上传闸门：按「用户」与「全站」两个维度限制单位时间内的上传次数。
 * <p>
 * ★ 为什么上传接口也需要闸门 ★
 * <p>
 * {@code POST /upload/image} 需要登录（{@code /upload/**} 不在 {@code AuthInterceptor.PUBLIC_GET} 里），
 * 但登录只回答「谁在传」，不回答「能传几下」。闸门之前这个接口的约束只有两条：
 * 「单张 ≤ 2MB」与「扩展名在白名单里」——**两条都与次数无关**。
 * 于是任何一个学生账号写个 for 循环，就能在几分钟内往服务器磁盘写进几万个文件：
 * <ul>
 *   <li><b>磁盘会满</b>。上传目录里的内容是**业务数据，不可回收、不能随部署覆盖**
 *       （见 {@code application-prod.yml} 里把 {@code app.upload.dir} 移出源码树的理由），
 *       写满了影响的不只是上传，还可能连带数据库与日志写不进去。</li>
 *   <li><b>文件本身是攻击面</b>。哪怕有魔数嗅探（{@link com.campus.market.common.ImageType}），
 *       一个合法图片里仍能塞进超大体积或畸形结构的东西去撞后续的图片处理环节。</li>
 *   <li><b>它比 AI 便宜，但不等于免费</b>。每次上传都占一次网络往返、一次磁盘写、一份长期存储。</li>
 * </ul>
 * 次数与内容这是两个正交的维度：魔数管「传的是什么」，闸门管「能传多少」。
 * 缺任何一条，另一条都能被绕开。
 * <p>
 * ★ 两个维度分工不同，都不能省 ★
 * <ul>
 *   <li><b>用户维度</b>（主）：单个账号在窗口内最多 {@code user-max-uploads} 张。它管的是**公平**
 *       —— 拦住「一个人写脚本」和「一个人连续点上传按钮」。</li>
 *   <li><b>全站维度</b>（兜底）：全站窗口内最多 {@code global-max-uploads} 张。它管的是**容量**
 *       —— 磁盘占用与「是谁在传」无关。用户维度拦不住「注册 100 个账号各传 9 张」，
 *       全站维度才是那条真正兜住磁盘的网。</li>
 * </ul>
 * 任一维度命中即拒绝，两个维度各自独立计数、互不清零。
 * <p>
 * ★ 判定与消耗合成一次原子操作、共用一把锁 ★
 * <p>
 * 与 {@link AiQuotaGuard} 同理、且与 {@link LoginAttemptGuard} 的 assert/record 两步不同：
 * 「每次请求进来就算消耗一次额度」，判定条件在入口处就完全确定，不存在「什么算一次」的业务判断。
 * 需要原子的组合动作是「先判两个维度，再一起 +1」—— 分两把锁会出现「用户维度判过、全站同时被别人顶满」，
 * 结果是这次上传既不该放行、用户维度的计数却已经被吃掉。临界区只有几次整数比较与自增，
 * 而上传本身要落盘，一把锁在这个接口上完全不是瓶颈。
 * <p>
 * ★ 闸门必须放在方法最前面（其它检查之前）★
 * <p>
 * 它是整个方法里**唯一不需要读文件内容的检查**：越早拒，越省一次 multipart 解析、一次磁盘写。
 * 更重要的是，把它放在魔数/大小检查之后会出现一个反直觉的后果 ——
 * 攻击者用**永远不合法**的文件反复请求时，每次都在更贵的分支上被拒，闸门却一次都没计数。
 * <p>
 * ★ 0 / 负数 / 缺配置 = 该维度不限 ★
 * <p>
 * 沿用本仓既有口径（见 {@code AiQuotaGuard} 类注释与 {@code application.yml} 的
 * {@code goods-maintenance} 段）：**缺配置一律放宽，绝不收紧**。配 0 表示该维度关闭，
 * 是给课堂演示留的逃生口。唯一例外是 {@code window-seconds}：配 0 会收敛到 1 秒，
 * 否则窗口恒为零 ⇒ 计数永远从 0 开始 ⇒ 闸门静默失效而配置看起来「只是设小了一点」。
 * <p>
 * ★ 刻意<b>不</b>读 {@code X-Forwarded-For} ★
 * <p>
 * 与 {@link LoginAttemptGuard}、{@link AiQuotaGuard} 一致：该头完全由客户端提供，
 * 采信它等于给攻击者一个「每次换一个身份」的开关。本类用的是登录态里的 userId
 * （由 {@code AuthInterceptor} 解析 JWT 并回查数据库确认账号有效）。
 * <p>
 * ★ 已知边界 ★
 * <p>
 * 纯内存实现、单实例有效；多实例部署时各实例各算各的，总容忍度放大到 N 倍
 * （与 {@link LoginAttemptGuard}、{@link AiQuotaGuard} 同一类边界）。重启即清零，
 * 挡的是「持续滥用」，不是「重启即绕过」——后者要靠部署侧的磁盘配额与监控。
 */
@Component
public class UploadQuotaGuard {

    private static final Logger log = LoggerFactory.getLogger(UploadQuotaGuard.class);

    /** 触发惰性清理的水位（与 LoginAttemptGuard / AiQuotaGuard 同一思路，防随机账号把单次请求拖成 O(n)） */
    private static final int PURGE_THRESHOLD = 256;

    /** 单个用户在窗口内的最大上传张数；&lt;= 0 表示该维度不限 */
    private final int userMaxUploads;

    /** 全站在窗口内的最大上传张数；&lt;= 0 表示该维度不限 */
    private final int globalMaxUploads;

    /** 计数窗口长度。下限 1 秒 —— 见类注释「窗口不能是 0」 */
    private final long windowMs;

    private final LongSupplier clock;

    /** 判定与消耗必须落在同一个临界区里（见类注释），所以用一把独立锁 */
    private final Object lock = new Object();

    /** 用户维度：key = userId 的字符串形式 */
    private final Map<String, Window> byUser = new ConcurrentHashMap<>();

    /** 全站维度：只有一个计数器，但它与用户维度共享同一把锁 */
    private final Window global = new Window();

    @Autowired
    public UploadQuotaGuard(
            @Value("${app.upload-guard.user-max-uploads:10}") int userMaxUploads,
            @Value("${app.upload-guard.global-max-uploads:60}") int globalMaxUploads,
            @Value("${app.upload-guard.window-seconds:60}") int windowSeconds) {
        this(userMaxUploads, globalMaxUploads, windowSeconds, System::currentTimeMillis);
    }

    /**
     * 注入假时钟的构造器（<b>供测试使用</b>）。
     * <p>
     * 理由与 {@code AiQuotaGuard} 完全相同：本类核心行为全是时间驱动的（窗口滑过要重新计数、
     * 限流要能自动解除）。时钟写死就只能靠 {@code Thread.sleep(1 分钟)} 去测 ——
     * 没人会跑那种用例，等于「限流到期自动恢复」这条分支**永远没被验证过**。
     * 一旦有人把窗口写成「永不过期」，线上会变成「用户传了 10 张之后再也传不了图」，
     * 而单测全绿、日志无异常。
     * <p>
     * Spring 走上面那个 {@code @Autowired} 构造器，永远是真实时钟。
     */
    public UploadQuotaGuard(int userMaxUploads, int globalMaxUploads, int windowSeconds, LongSupplier clock) {
        this.userMaxUploads = userMaxUploads;
        this.globalMaxUploads = globalMaxUploads;
        this.windowMs = Math.max(1L, windowSeconds) * 1000L;
        this.clock = clock;
    }

    /**
     * 申请一次上传额度：超限抛 {@link BusinessException}（业务码 1001），否则计数 +1。
     * <p>
     * <b>调用它就算消耗一次额度</b>，无论这个文件最终是否通过校验、是否落盘成功 ——
     * 被魔数拒掉的那次同样占用了 multipart 解析与一次请求的处理开销，没有理由退还额度。
     *
     * @param userId 当前登录用户 id（由 {@code AuthInterceptor} 解析）；为 null 时只按全站维度计数
     */
    public void acquire(Long userId) {
        long now = clock.getAsLong();
        synchronized (lock) {
            rollWindow(global, now);

            /*
             * ★ 全站维度先判，而且要在建用户条目之前判 ★
             * 判得越早代价越小：全站已满的那个窗口里，攻击者继续猛发也只会在这一行被拒，
             * 不会逐个 computeIfAbsent 把 byUser 撑大。
             */
            if (globalMaxUploads > 0 && global.count >= globalMaxUploads) {
                // ★ 刻意不告诉调用方全站上限是多少 ★：那是运营侧的容量阈值，
                // 回给他等于告诉他「再注册几个账号就能把这条网打穿」。
                log.warn("上传闸门：全站 {} 秒内已上传 {} 张，达到上限 {}，本次拒绝",
                        windowMs / 1000, global.count, globalMaxUploads);
                throw BusinessException.paramError("当前上传的人较多，请稍后再试");
            }

            Window user = null;
            if (userMaxUploads > 0 && userId != null) {
                user = byUser.computeIfAbsent(userId.toString(), k -> newWindow(now));
                rollWindow(user, now);
            }

            /*
             * ★ 两个维度都判完，才一起 +1 ★
             * 写成「判一个 +1 再判下一个」的话，用户维度超限时全站计数已经被吃掉了
             * —— 少数人的滥用会连带把全站额度提前耗光，本来只该影响他自己。
             */
            if (user != null && user.count >= userMaxUploads) {
                long waitMs = user.windowStartMs + windowMs - now;
                log.warn("上传闸门：用户 [{}] 在 {} 秒窗口内已上传 {} 张，本次拒绝（约 {} 秒后恢复）",
                        userId, windowMs / 1000, user.count, Math.max(0L, waitMs / 1000));
                throw BusinessException.paramError(
                        "上传过于频繁，请 " + remainSeconds(waitMs) + " 秒后再试（每 "
                                + ceilSeconds(windowMs) + " 秒最多 " + userMaxUploads + " 张）");
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
     * ★ 只为测试而存在 ★：内存回收是「不写用例就等于没写过」的那类逻辑 ——
     * 回收失效不报错、不影响功能，只会让进程内存随随机 userId 单调增长。
     */
    int trackedUsers() {
        return byUser.size();
    }

    // ==================== 内部实现 ====================

    /** 窗口滑过就重新起一段（本类没有「锁定期」这个独立状态，超限只是「本窗口内不许再传」） */
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

    /** 剩余时长折算成秒，向上取整且至少 1（「请 0 秒后再试」等于没说） */
    private static long remainSeconds(long leftMs) {
        return Math.max(1L, (Math.max(0L, leftMs) + 999L) / 1000L);
    }

    /** 窗口长度折算成秒，向上取整且至少 1（窗口配成 0.5 秒时不能显示成「每 0 秒」） */
    private static long ceilSeconds(long ms) {
        return Math.max(1L, (ms + 999L) / 1000L);
    }

    /** 单个维度的计数状态：窗口起点 + 窗口内已用次数（只在 {@link #lock} 保护下读写） */
    private static final class Window {
        private long windowStartMs;
        private int count;
    }
}
