package com.campus.market.security;

import com.campus.market.entity.User;
import com.campus.market.mapper.UserMapper;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Ticker;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Collection;
import java.util.Optional;

/**
 * 鉴权快照本地缓存（部署适配清单 P1-11）
 * <p>
 * 缓存 {@code t_user} 上**只与鉴权有关**的三列：{@code status} / {@code role} / {@code token_version}。
 *
 * <h3>★★ 起因：每请求一次主键查询 ★★</h3>
 * {@code AuthInterceptor} 为了「撤销撤得干净」而**每个已登录请求都回查一次 t_user**
 * （理由见该类的「以数据库为准，不信 Token 里的快照」）。这个决定本身是对的 ——
 * 没有它，封禁与降权在旧 token 到期前完全无效。代价是每次请求都多一次数据库往返：
 * 前端一个页面的加载期会并发好几个接口，一个用户刷列表就等于几十次 `SELECT * FROM t_user WHERE id=?`。
 * <p>
 * 这些查询读的是**同一行、几乎不变的三个字段**（role 建号后就不再变；status 极少变；
 * token_version 只在改密/重置时 +1），是典型的「读多写极少」—— 正该缓存。
 *
 * <h3>★★ 缓存会不会让「封禁即时生效」失效：这是本类唯一需要认真回答的问题 ★★</h3>
 * 会，如果只靠 TTL。所以正确性**不押在 TTL 上**，而是分两层：
 * <ol>
 *   <li><b>显式失效（正确性，立即生效）</b>：凡是改了这三列的地方，
 *       必须紧接着调用 {@link #invalidate(Long)} / {@link #invalidateAll(Collection)}。
 *       已接线的写入点共 6 处（{@code UserService} 的审核通过 / 单个封禁 / 批量封禁 /
 *       重置密码 / 自助改密，{@code ContentService} 的举报处置「封禁」）。
 *       由 {@code AuthSnapshotCacheTest#everyAuthColumnWriteInvalidates()} 反向看守 ——
 *       它扫源码找「写这三列」的语句，要求同一函数体内必须出现失效调用，
 *       这样以后新增写入点若忘了失效，测试会红。</li>
 *   <li><b>TTL（兜底，最多 {@value #TTL_SECONDS} 秒）</b>：万一有没接线的写入路径
 *       （直接改库、将来新写的代码），过期后自动回源，不会永久残留。</li>
 * </ol>
 *
 * <h3>★ 为什么不走 spring-boot-starter-cache / @Cacheable ★</h3>
 * 那套需要 {@code @EnableCaching} + AOP 代理，而注解式缓存的失效点写在**调用方**，
 * 与本类「谁写谁清」的显式契约相比只是换了个地方藏，却多引入一层代理语义
 * （同类内自调用不走代理、事务内外顺序等）。本项目已经反复栽在「改了没生效且不报错」上，
 * 所以这里选择**没有魔法的显式调用**，并配一条源码级看守测试兜住「忘了清」。
 *
 * <h3>★ 关于「用任何 t_user 写入就整体清空」这个看似更省事的做法 ★</h3>
 * 不采用，而且是有实测依据的：{@code UserService#heartbeat}（在线心跳）**每 60 秒就 UPDATE 一次 t_user**
 * （只写 {@code last_active_at}）。若按「动了 t_user 就清」来，缓存会被心跳持续清空，
 * 命中率趋近于 0 —— 加了缓存等于没加，还多了一份内存。所以失效必须**锚到那三列**，
 * 而不是锚到「这张表被写过」。
 *
 * <h3>★ TTL 为什么是常量，不做成配置项 ★</h3>
 * 这个数字是**安全边界**（「失效生效前，最坏情况能多活多久」），不是性能旋钮。
 * 做成配置项等于给运维留了一个「把它调到 3600 能让接口快一点」的坑，
 * 而这么做的后果（被踢下线的账号还能继续访问一小时）**不会报任何错**。
 * 常量 + 这里写明理由，比一个能被调坏的开关更适合放在这道闸上。
 *
 * <h3>★ 负缓存（查不到也缓）★</h3>
 * token 里的 userId 查库为空时缓存 {@link Optional#empty()}。
 * 这是刻意的：删号后手上还留着 token 的请求会反复打库，负缓存把这类无效流量挡在数据库之外。
 * 它不会造成「注册后立刻访问被当成不存在」——token 只可能为**已经存在过**的 id 签发，
 * 而在删号/建号之间不存在「同一 id 先查空、后被创建」的时序。
 */
@Component
public class AuthSnapshotCache {

    /**
     * 兜底过期时间（秒）。见类注释「缓存会不会让封禁即时生效失效」。
     * <p>
     * 取 10 秒的依据：它要明显长于「一个页面加载期的并发请求跨度」（几百毫秒级），
     * 才能真正吃到命中；又要短到「万一漏了显式失效」也不会让人白蹭太久。
     */
    public static final int TTL_SECONDS = 10;

    /**
     * 条目数上界。取 10000 是因为本项目规模下同时活跃用户远小于它（在线口径见
     * {@code UserService#queryOnlineIds}），上界的意义只是**防无界增长**（有人拿一批
     * 伪造/历史 userId 打接口时，条目不会一直堆下去），而不是做容量规划。
     */
    public static final int MAX_SIZE = 10_000;

    /**
     * 该用户与鉴权有关的那三列。
     * <p>
     * ★ 刻意**不缓存整个 User 实体** ★：一是没必要（拦截器只读这三列），
     * 二是避免密码哈希这类字段在缓存里多留一份，三是挡掉「顺手拿缓存对象去渲染个人资料」
     * ——那样会拿到可能已过期的昵称/头像，属于本缓存不该承担的语义。
     */
    public record Snapshot(String status, String role, int tokenVersion) {

        /** 封禁判定口径与 {@code AuthInterceptor} 一致（唯一取值 {@code "banned"}） */
        public boolean isBanned() {
            return "banned".equals(status);
        }
    }

    private final UserMapper userMapper;
    private final Cache<Long, Optional<Snapshot>> cache;

    @Autowired
    public AuthSnapshotCache(UserMapper userMapper) {
        this(userMapper, TTL_SECONDS, MAX_SIZE, Ticker.systemTicker());
    }

    /**
     * 供测试注入假时钟与短 TTL。
     * <p>
     * ★ 时钟必须可注入 ★（与 {@code UploadQuotaGuardTest} / {@code AiQuotaGuardTest} 同因）：
     * 「TTL 到点要回源」是本类唯一的保命属性，写死时钟就只能靠
     * {@code Thread.sleep(10_000)} 去测 —— 没人会跑那种用例，
     * 等于这条分支**永远没被验证过**。而它一旦被改成「永不过期」，
     * 表现是「服务一切正常、只是封禁要多等一会儿」，没有任何报错，日志上也看不出来。
     * <p>
     * package-private：只给同包测试用，生产装配路径永远走上面那个单参构造。
     */
    AuthSnapshotCache(UserMapper userMapper, long ttlSeconds, long maxSize, Ticker ticker) {
        this.userMapper = userMapper;
        this.cache = Caffeine.newBuilder()
                .maximumSize(maxSize)
                .expireAfterWrite(Duration.ofSeconds(ttlSeconds))
                .ticker(ticker)
                .build();
    }

    /**
     * 取该用户的鉴权快照，未命中则回源一次数据库。
     *
     * @return 用户不存在时返回 {@link Optional#empty()}（调用方据此回 401）
     */
    public Optional<Snapshot> get(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        return cache.get(userId, this::load);
    }

    /**
     * 回源：读整行后**只取三列**。
     * <p>
     * 这里用 {@code selectById}（整行）而不是单独写一条只选三列的 SQL：
     * 回源频率已经被 TTL 压到每用户 10 秒最多一次，为此给 {@code UserMapper}
     * 增一条自定义查询，收益抵不过「多一处 SQL 要跟着表结构改」的维护成本。
     * 落到缓存里的只有 {@link Snapshot} 三个字段，整行对象随即释放。
     */
    private Optional<Snapshot> load(Long userId) {
        User u = userMapper.selectById(userId);
        if (u == null) {
            return Optional.empty();
        }
        return Optional.of(new Snapshot(u.getStatus(), u.getRole(),
                u.getTokenVersion() == null ? 0 : u.getTokenVersion()));
    }

    /**
     * 让某个用户的缓存立即失效 —— **改 status / role / token_version 之后必须调用**。
     * <p>
     * 不做「清空全部」：心跳等高频写库不该影响别人的缓存条目（见类注释）。
     */
    public void invalidate(Long userId) {
        if (userId != null) {
            cache.invalidate(userId);
        }
    }

    /** 批量失效（批量封禁 / 解封用） */
    public void invalidateAll(Collection<Long> userIds) {
        if (userIds != null && !userIds.isEmpty()) {
            cache.invalidateAll(userIds);
        }
    }

    /**
     * 当前缓存条目数（估算值，Caffeine 的清理是异步的）。
     * <p>
     * 只给测试用：用它证明「命中时不回源」（同一用户连续两次 get，mapper 只被调用一次）
     * 与「失效后条目被移除」，而不是靠计时去猜。
     */
    long cachedCount() {
        return cache.estimatedSize();
    }
}
