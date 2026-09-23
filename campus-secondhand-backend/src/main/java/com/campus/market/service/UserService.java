package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.common.OperatorContext;
import com.campus.market.common.Passwords;
import com.campus.market.common.Validators;
import com.campus.market.config.JwtConfig;
import com.campus.market.dto.FavoriteItem;
import com.campus.market.dto.HistoryItem;
import com.campus.market.entity.Address;
import com.campus.market.entity.AuditLog;
import com.campus.market.entity.Favorite;
import com.campus.market.entity.Goods;
import com.campus.market.entity.User;
import com.campus.market.mapper.*;
import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 用户业务逻辑层
 * <p>
 * 职责：登录注册 / 用户管理（后台）/ 个人中心（我的商品·收藏·历史·地址）
 */
@Service
@RequiredArgsConstructor
public class UserService {

    /** 浏览足迹的保留上限：不做限制的话，反复刷商品会把个人中心刷成无限长列表 */
    private static final int HISTORY_MAX = 50;

    /** 管理员类账号，封禁闸门要放行的一批（单个封禁与批量封禁共用同一口径） */
    private static final List<String> ADMIN_ROLES = List.of("admin", "goods_admin", "report_admin");

    /** 与 schema.sql 严格一致：t_user.username / nickname 均为 varchar(50) */
    private static final int NAME_MAX = 50;

    /** 与 schema.sql 严格一致：t_user.password varchar(100)（BCrypt 哈希固定 60 字符） */
    private static final int PASSWORD_MAX = 100;

    /**
     * 口令长度下限 —— 与 {@link #changePassword} 的「至少 6 位」对齐。
     * <p>
     * ★ 之前注册完全不查下限 ★：`Validators.required` 只判「非空 + 不超上限」，
     * 于是 1 位口令也能注册成功，而改密却要求 ≥6 位 —— 用户被锁在一个
     * 「注册得进去、却改不成密码」的账号里。两条入口必须同一条口径。
     */
    private static final int PASSWORD_MIN = 6;

    /**
     * 用户名口径 —— 与前端 `views/auth/Register.vue` 的 `rules.username` 逐条对齐
     * （4-20 位、仅字母/数字/下划线）。
     * <p>
     * 比列宽（50）窄是刻意的：列宽只是存储上限，业务命名规则归业务层管。
     * 前端的 `rules` 只是用户体验，绕过页面直接调接口就没有了 —— 边界必须在后端。
     */
    private static final int USERNAME_MIN = 4;
    private static final int USERNAME_MAX = 20;
    private static final String USERNAME_PATTERN = "^[a-zA-Z0-9_]+$";

    /** 与 schema.sql 严格一致：t_user.avatar varchar(255) */
    private static final int AVATAR_MAX = 255;

    /** 与 schema.sql 严格一致：t_address 各列宽度 */
    private static final int ADDR_RECEIVER_MAX = 50;
    private static final int ADDR_REGION_MAX = 200;
    private static final int ADDR_DETAIL_MAX = 500;
    private static final int ADDR_TAG_MAX = 20;

    /** 平台警告正文上限：t_message.content 是 TEXT，能存 64KB，但站内信不需要那么长 */
    private static final int WARN_REASON_MAX = 500;

    /**
     * 在线时间窗（秒）：{@code last_active_at} 落在最近这么久之内才算「在线」。
     * <p>
     * 取 5 分钟的依据：前端心跳间隔 60 秒，即使连丢 4 次心跳（切换标签页、弱网、
     * 短暂熄屏）也不会被误判成离线；反过来用户关掉页面后最多 5 分钟就会转为离线，
     * 不会出现「关了两个小时还挂着在线」的假象。
     * <p>
     * ★ 这是全站唯一的口径 ★：前端不再自己算在线，只消费 {@link #queryOnlineIds} 的结果。
     */
    private static final int ONLINE_WINDOW_SECONDS = 300;

    /**
     * 单次在线名单查询的 id 上限。
     * <p>
     * 与前端一次渲染的规模对齐（会话列表 + 当前页商品卡片的卖家），100 足够；
     * 设上限是为了挡住「构造一万个 id 打一次 IN 查询」这种低成本压库手法。
     */
    private static final int ONLINE_QUERY_MAX_IDS = 100;

    private final UserMapper userMapper;
    private final GoodsMapper goodsMapper;
    private final FavoriteMapper favoriteMapper;
    private final HistoryMapper historyMapper;
    private final AddressMapper addressMapper;
    private final AuditLogMapper auditLogMapper;
    private final MessageService messageService;
    private final JwtConfig jwtConfig;

    /**
     * 登录失败闸门（防暴力破解）。
     * <p>
     * ★ 放在 Service 而不是拦截器 ★：它要区分「口令错」与「被封禁」——
     * 只有前者算失败。这个判断只有贴着口令校验的地方才做得准。
     */
    private final LoginAttemptGuard loginAttemptGuard;

    /**
     * 鉴权快照缓存（P1-11）。
     * <p>
     * ★ 只为一件事存在：本类里有 4 处会改 {@code status} / {@code token_version} 的地方
     * （approveUser 已随 D11 拆除），
     * 改完必须让 {@link AuthSnapshotCache} 里的条目立即失效 ★ ——
     * 否则「封禁」会退化成「最多慢 10 秒生效」，而改密的吊销效果同样会被拖后。
     * <p>
     * 反过来说，其余那些只写 nickname / phone / credit_score / last_active_at 的方法
     * （如 {@link #heartbeat}，每 60 秒一次）**刻意不失效** ——
     * 见 {@code AuthSnapshotCache} 类注释「关于用任何 t_user 写入就整体清空」那一节。
     */
    private final AuthSnapshotCache authSnapshotCache;

    // ==================== 登录 / 注册 ====================

    /**
     * 登录：失败次数闸门 → 校验用户名密码 → 状态闸门
     * <p>
     * ★ 封禁账号不允许登录（第一道也是最重要的一道闸门）
     * <p>
     * 口令走 {@link Passwords#matches} 双模式校验；若命中的是历史明文，
     * 登录成功后**顺手把库里那行升级成 BCrypt 哈希** —— 老账号不需要任何人
     * 手动迁移，登录一次就自动收敛。
     * <p>
     * ★ 四步的顺序不能调 ★
     * <ol>
     *   <li>{@link LoginAttemptGuard#assertNotLocked} —— 被锁的账号连库都不查；</li>
     *   <li>口令校验失败 → {@link LoginAttemptGuard#onFailure} 计数，再抛 1001；</li>
     *   <li>状态闸门（被封禁 → 403）—— <b>刻意不计数</b>；</li>
     *   <li>一切通过 → {@link LoginAttemptGuard#onSuccess} 清零。</li>
     * </ol>
     * 第 3 步为什么不计数：能走到那里说明<b>口令已经是对的</b>，被封禁是管理动作的结果，
     * 不是暴力破解特征。若把它计进去，一个被封的用户再输 4 次就会额外收到一条
     * 「尝试次数过多」——既误导用户（以为是自己输错导致），也让日志里混进假攻击信号，
     * 真的有人在撞库时反而看不出来。
     *
     * @param clientIp 来源地址，只供失败闸门的 IP 维度使用；传 null 则该维度自动跳过
     */
    public Map<String, Object> login(String username, String password, String clientIp) {
        // ① 闸门：锁定期间直接拒绝，不查库、不比口令（顺带省掉 BCrypt 那约 100ms 的开销，
        //    于是「锁定期间」比「正常登录」还便宜，攻击者连成本都占不到）
        loginAttemptGuard.assertNotLocked(username, clientIp);

        User user = userMapper.selectByUsername(username);
        if (user == null || !Passwords.matches(password, user.getPassword())) {
            // ② 计入失败。★ 用户不存在也照样计数 ★：否则「锁不锁」本身
            //    就成了账号是否存在的探测器，攻击者可以先批量探明有效用户名再集中撞
            loginAttemptGuard.onFailure(username, clientIp);
            // ★ 这里刻意用 1001 而不是 401 ★
            // 前端 request.ts 对 401 是「弹『登录状态已过期』+ 清 token + 跳 /login」的全局处理，
            // 登录页本身输错密码若返回 401，用户会看到一个语义错乱的过期弹窗。
            throw BusinessException.paramError("用户名或密码错误");
        }
        if ("banned".equals(user.getStatus())) {
            throw BusinessException.forbidden("账号「" + user.getNickname() + "」已被封禁，无法继续使用");
        }
        /*
         * ★ 状态闸门只看 banned（D11 拆除后用户状态只剩 active / banned 两态）★
         *
         * 历史包袱说明：这里曾有一大段「pending 刻意不拦登录、只限制发布」的
         * 契约说明 —— 那是配合「用户待审核」流程的。2026-09-23 已决策拆除该流程
         * （管理员审核注册效率太低，且 pending 本就是无入口的死状态），
         * 登录闸门回归本源：封禁即挡，其余放行。
         */
        // 历史明文 → BCrypt 透明升级（只改 password 列，避免把整个对象回写出去误伤其它字段）
        if (!Passwords.isHashed(user.getPassword())) {
            userMapper.update(null, new LambdaUpdateWrapper<User>()
                    .eq(User::getId, user.getId())
                    .set(User::getPassword, Passwords.encode(password)));
        }
        // ④ 口令正确、状态正常 → 这次是合法尝试，清空该账号的失败累计。
        //    清空必须放在这里（而不是方法入口）：否则「被封禁」与「口令错」都会被
        //    同一句清零抹掉，前面辛苦累计的失败次数就白记了。
        loginAttemptGuard.onSuccess(username);
        String token = jwtConfig.generateToken(user.getId(), user.getUsername(), user.getRole(), user.getTokenVersion());
        user.setPassword(null);
        Map<String, Object> result = new HashMap<>();
        result.put("token", token);
        result.put("user", user);
        return result;
    }

    /**
     * 注册
     * <p>
     * 口令入库前先做 BCrypt 哈希，库里不再出现任何明文密码。
     */
    @Transactional
    public Map<String, Object> register(String username, String password, String nickname) {
        /*
         * ★ 三个字段都要在落库前量长度 ★
         * t_user.username / nickname 都是 varchar(50)、password 是 varchar(100)。
         * 原先只校验了「密码非空」，用户名打 80 个字会一路撞到 MySQL 的严格模式
         * （Data too long for column 'username'）→ 注册页弹「服务器内部错误」。
         * 用户不知道是自己输太长，只会反复重试；监控上它和真实故障也是同一个 500。
         */
        String safeUsername = Validators.required(username, USERNAME_MIN, USERNAME_MAX, "用户名");
        Validators.matches(safeUsername, USERNAME_PATTERN, "用户名");
        String safeNickname = Validators.required(nickname, NAME_MAX, "昵称");
        String safePassword = Validators.required(password, PASSWORD_MIN, PASSWORD_MAX, "密码");

        User exist = userMapper.selectByUsername(safeUsername);
        if (exist != null) {
            throw BusinessException.of("该用户名已被占用，换一个试试");
        }
        User user = new User();
        user.setUsername(safeUsername);
        user.setPassword(Passwords.encode(safePassword));
        user.setNickname(safeNickname);
        user.setAvatar("https://api.dicebear.com/7.x/initials/svg?seed=" + safeUsername);
        user.setCreditScore(100);
        /*
         * ★ D11 决策（2026-09-23）：注册**不走管理员审核**，落库即 active ★
         * 「用户待审核」曾是死状态：全代码没有入口写 pending，approveUser 永远无法成功。
         * 已随 D11 拆除整条审核线（端点 / 服务方法 / 看板计数 / 前端契约），
         * 用户状态只剩 active / banned 两态 —— 治理靠封禁，不靠注册卡口。
         */
        user.setStatus("active");
        user.setRole("user");
        user.setCreateTime(LocalDateTime.now());
        /*
         * ★ 上面的 selectByUsername 只是「友好提示」，不是并发边界 ★
         * check-then-insert 在并发下必然漏：两个请求同时查到「不存在」，然后
         * 先后 insert，后者撞上 `t_user.username UNIQUE`。
         * 拦下它的是**唯一索引**（数据一致性没问题），但抛出来的
         * DuplicateKeyException 会一路走到 GlobalExceptionHandler 的兜底分支 ——
         * 用户在注册页看到的是 **500「服务器内部错误」**，
         * 而这明明是一次完全正常的「用户名被我抢注了」。
         * 所以把唯一键冲突在这层翻译回 1001，与上面的预检**同一句文案**：
         * 用户看到的提示不因「是不是撞上并发」而不同。
         */
        try {
            userMapper.insert(user);
        } catch (DuplicateKeyException e) {
            throw BusinessException.of("该用户名已被占用，换一个试试");
        }

        String token = jwtConfig.generateToken(user.getId(), user.getUsername(), user.getRole(), user.getTokenVersion());
        user.setPassword(null);
        Map<String, Object> result = new HashMap<>();
        result.put("token", token);
        result.put("user", user);
        return result;
    }

    /** 获取当前用户信息 */
    public User getProfile(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw BusinessException.notFound("用户不存在");
        }
        if ("banned".equals(user.getStatus())) {
            throw BusinessException.forbidden("账号已被封禁");
        }
        user.setPassword(null);
        return user;
    }

    /**
     * 修改个人资料（昵称 / 头像 / 手机号）
     * <p>
     * ★ 为什么入参是 {@code Map} 而不是 {@code User} 实体 ★
     * <p>
     * 这里要表达的是「**局部**更新」：请求体里出现了哪个字段就改哪个，
     * 没出现的一律不碰。如果直接收 {@code @RequestBody User}，就没法区分
     * 「没传 nickname」和「传了 nickname=null」—— 后者会把非空的昵称列写成 NULL
     * （{@code t_user.nickname} 是 {@code NOT NULL}，直接抛 SQL 异常变 500）。
     * 用 {@code containsKey} 判断「有没有出现」，是唯一能表达这个语义的写法。
     * <p>
     * ★ 只 SET 指定列，绝不用 {@code updateById} 整实体回写 ★
     * <p>
     * 整实体回写会把「同一时刻别人改过的列」覆盖回旧值：用户 A 在改昵称的同时，
     * 管理员刚把信用分从 60 调到 80，回写会把 80 抹回读出来的 60。
     * 本项目已经在 {@code favorite_count} / 浏览数上栽过同类病根
     * （见 {@code refreshFavoriteCount} 的注释），这里不再重复。
     * <p>
     * ★ 手机号是「可选但一旦填了就必须合法」★
     * 空串视为「清空该字段」（置 NULL），非空则必须过 {@link Validators#phone}。
     *
     * @throws com.campus.market.common.BusinessException 1001 参数错误 / 404 用户不存在
     */
    @Transactional
    public void updateProfile(Long userId, Map<String, Object> body) {
        if (body == null || body.isEmpty()) {
            throw BusinessException.paramError("没有需要修改的字段");
        }

        LambdaUpdateWrapper<User> wrapper = new LambdaUpdateWrapper<User>().eq(User::getId, userId);
        boolean touched = false;

        if (body.containsKey("nickname")) {
            // 昵称是非空列：空白值不能「什么都不改」地放过去，必须有明确提示
            wrapper.set(User::getNickname, Validators.required(str(body.get("nickname")), NAME_MAX, "昵称"));
            touched = true;
        }
        if (body.containsKey("avatar")) {
            // 头像可清空（置 NULL 是可以接受的：前端会回落到默认头像）
            wrapper.set(User::getAvatar, Validators.optional(str(body.get("avatar")), AVATAR_MAX, "头像地址"));
            touched = true;
        }
        if (body.containsKey("phone")) {
            // Validators.phone 已经同时管了长度上限与格式，这里不必再判一次长度
            String phone = Validators.phone(str(body.get("phone")), "手机号");
            wrapper.set(User::getPhone, (phone == null || phone.isEmpty()) ? null : phone);
            touched = true;
        }

        if (!touched) {
            // 传了 body，但键名全是后端不认识的（如拼错的 "nickName"）——
            // 静默成功会让用户以为改好了，下次刷新发现没变，只能反复重试
            throw BusinessException.paramError("没有需要修改的字段");
        }
        if (userMapper.update(null, wrapper) == 0) {
            throw BusinessException.notFound("用户不存在");
        }
    }

    /** 从请求体里取值并转成字符串（数字等类型统一按 toString 处理，null 原样返回） */
    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    // ==================== 在线状态（心跳 / 名单 / 隐私开关） ====================

    /**
     * 心跳：把当前用户的最后活跃时间刷新成「现在」。
     * <p>
     * ★ 为什么用「时间戳 + 时间窗」而不是一个 online 布尔列 ★
     * 布尔列有两个死穴：① 用户直接关页面/断网，没人来把它改回 0 → 永久在线；
     * ② 必须再加一个定时任务去扫「僵尸在线」。记时间戳后，在线是每次查询现场算出来的，
     * 客户端掉线不需要通知服务端，时间窗一过自然变离线。
     * <p>
     * ★ 为什么用单列 UPDATE 而不是「查出来改完再回写实体」★
     * 整实体回写会把同一时刻别人改的 credit_score / status / nickname 一起覆盖回旧值，
     * 属于本项目已经栽过的同类病根（见 {@code refreshFavoriteCount} 一节的注释）。
     */
    @Transactional
    public void heartbeat(Long userId) {
        if (userId == null) {
            throw BusinessException.of(BusinessCode.UNAUTHORIZED, "未登录");
        }
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, userId)
                .set(User::getLastActiveAt, LocalDateTime.now()));
    }

    /**
     * 查询一批用户里「当前在线」的 id 列表。
     * <p>
     * 判定口径（全站唯一）：{@code show_online = 1} 且 {@code last_active_at} 落在
     * {@link #ONLINE_WINDOW_SECONDS} 秒内。
     * <p>
     * ★ 两个条件都必须发生在 SQL 里 ★
     * <ul>
     *   <li><b>时间以服务端为准</b>：若把 {@code last_active_at} 捞到前端再比，
     *       改一下本机时钟就能把离线的人显示成在线；</li>
     *   <li><b>隐私条件不能漏</b>：{@code show_online} 一旦不在 SQL 里过滤，
     *       关掉开关的人照样出现在名单中。这正是这个开关此前的病根 ——
     *       过滤发生在「观看者的浏览器」里，等于开关只遮住了自己的眼睛。</li>
     * </ul>
     * <p>
     * ★ 关于 SQL 里直接拼 {@code ONLINE_WINDOW_SECONDS} ★
     * 该值是 {@code private static final int} 编译期常量，不是用户输入，
     * 因此拼进 SQL 不存在注入面；这样做是为了让「窗口秒数」只有一个定义处，
     * 避免常量改了、SQL 里还写着 300 的口径漂移。
     *
     * @param ids 待查询的用户 id（允许重复 / 含 null / 含非法值，内部统一清洗）
     * @return 在线用户 id，升序；无人在线时返回空列表（返回空列表而非 null，前端免判空）
     */
    public List<Long> queryOnlineIds(List<Long> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        List<Long> clean = ids.stream()
                .filter(id -> id != null && id > 0)
                .distinct()
                .limit(ONLINE_QUERY_MAX_IDS)
                .toList();
        if (clean.isEmpty()) {
            return List.of();
        }
        return userMapper.selectList(new LambdaQueryWrapper<User>()
                        .select(User::getId)
                        .in(User::getId, clean)
                        .eq(User::getShowOnline, true)
                        .apply("last_active_at > DATE_SUB(NOW(), INTERVAL " + ONLINE_WINDOW_SECONDS + " SECOND)"))
                .stream()
                .map(User::getId)
                .sorted()
                .toList();
    }

    /**
     * 更新本人的隐私设置：是否对外展示在线状态。
     * <p>
     * ★ 越权约束进 SQL ★
     * 目标 id 只从登录态取（不由客户端指定），UPDATE 的 WHERE 再钉一次，
     * 客户端无法借这个接口改别人的开关。
     * <p>
     * ★ 为什么这里不需要动 {@code last_active_at} ★
     * 可见性闸门在查询语句里（{@code show_online = 1}），所以关掉开关的效果是**立刻**的，
     * 不存在「要等心跳超时 5 分钟才消失」的空窗；重新打开时，用户正在使用页面，
     * 心跳已经把 {@code last_active_at} 刷成当前时刻，也就立刻恢复在线。
     * 反过来若在关闭时顺手清空 {@code last_active_at}，等于为了一个查询条件
     * 去销毁真实的活跃数据，纯属多余且不可逆。
     *
     * @return 落库后的开关状态，供前端回填（不让前端凭乐观更新的结果自己猜）
     */
    @Transactional
    public boolean updateShowOnline(Long userId, Boolean showOnline) {
        if (userId == null) {
            throw BusinessException.of(BusinessCode.UNAUTHORIZED, "未登录");
        }
        if (showOnline == null) {
            throw BusinessException.paramError("请指定是否展示在线状态");
        }
        if (userMapper.selectById(userId) == null) {
            throw BusinessException.notFound("用户不存在");
        }
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, userId)
                .set(User::getShowOnline, showOnline));
        return showOnline;
    }

    // ==================== 用户管理（后台） ====================

    public IPage<User> fetchUsers(int page, int pageSize, String keyword, String status) {
        LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
        if (keyword != null && !keyword.isBlank()) {
            wrapper.and(w -> w.like(User::getUsername, keyword).or().like(User::getNickname, keyword));
        }
        if (status != null && !status.isBlank()) {
            wrapper.eq(User::getStatus, status);
        }
        wrapper.orderByDesc(User::getCreateTime);
        IPage<User> p = userMapper.selectPage(new Page<>(page, pageSize), wrapper);
        p.getRecords().forEach(u -> u.setPassword(null));
        return p;
    }

    /** 用户公开主页 */
    public Map<String, Object> fetchPublicProfile(Long id) {
        User u = userMapper.selectById(id);
        // ★ 不存在要报 1002 而不是 data:null ★：null 会让前端把「查无此人」当成
        // 「成功但没数据」，页面拿到一把 undefined 字段；业务码才能走统一的错误提示
        if (u == null) throw BusinessException.notFound("用户不存在");
        Map<String, Object> result = new HashMap<>();
        result.put("id", u.getId());
        result.put("nickname", u.getNickname());
        result.put("avatar", u.getAvatar());
        result.put("creditScore", u.getCreditScore());
        result.put("role", u.getRole());
        result.put("createTime", u.getCreateTime());
        return result;
    }

    /*
     * ★ approveUser（用户审核通过）已随 D11 拆除（2026-09-23）★
     * 决策：注册不走管理员审核（效率太低），注册落库即 active；
     * 「待审核」是无入口的死状态，approveUser 永远无法成功。
     * 由此释放的「改 status 必须失效鉴权快照」纪律由 toggleUserStatus / batchToggleUserStatus
     * 继续钉死（见 AuthCacheInvalidationTest 的封禁用例）。
     */

    /**
     * 封禁/解封
     * <p>
     * ★ 管理员类账号不允许被封禁 ★：批量入口（{@link #batchToggleUserStatus}）有这道闸，
     * 单个入口原先没有 —— 两个管理员互相封、或者手滑封了自己，审核后台就没人能进了
     * （解封接口也在后台里，全被封死等于把钥匙锁进保险柜）。
     * 解封不受限：万一历史数据里已有被封的管理员，得留一条放行的恢复路径。
     */
    @Transactional
    public void toggleUserStatus(Long id, boolean banned) {
        User u = userMapper.selectById(id);
        if (u == null) throw BusinessException.notFound("用户不存在");
        if (banned && ADMIN_ROLES.contains(u.getRole())) {
            throw BusinessException.of("管理员与审核员账号不允许被封禁");
        }
        // ★ 只 SET status 一列（禁整实体回写，见上方类级纪律）：封禁的意义是「立刻把人挡在外面」，
        // 而堵门靠的正是 token_version 与 status 两列同时生效；
        // 整实体回写会把读到的旧 token_version 盖回去 —— 等于一边封人、一边
        // 把他此前已经吊销掉的令牌重新放行。
        String nextStatus = banned ? "banned" : "active";
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, id)
                .set(User::getStatus, nextStatus));
        u.setStatus(nextStatus);
        /*
         * ★ P1-11：封禁必须**立即**生效 —— 这是缓存最不能出错的地方 ★
         * 被封的人手上还握着有效 token，那 10 秒 TTL 就是他白蹭的逃生时间。
         * 显式失效把窗口压到 0：他下一个请求就 401 被踢下线。
         */
        authSnapshotCache.invalidate(id);
        addAuditLog(banned ? "user.ban" : "user.unban",
                banned ? "封禁用户" : "解封用户",
                "用户 #" + u.getId(),
                u.getNickname() + "（" + u.getUsername() + "）");
    }

    /**
     * 批量封禁 / 解封
     * <p>
     * 管理员类账号（admin / goods_admin / report_admin）一律跳过 ——
     * 否则一次误操作就会把审核后台的人全部锁在门外，没人能再解封。
     */
    @Transactional
    public int batchToggleUserStatus(List<Long> ids, boolean banned) {
        if (ids == null || ids.isEmpty()) return 0;
        List<User> targets = userMapper.selectBatchIds(ids).stream()
                .filter(u -> !ADMIN_ROLES.contains(u.getRole()))
                .peek(u -> u.setStatus(banned ? "banned" : "active"))
                .toList();
        if (targets.isEmpty()) return 0;
        // ★ 逐条只 SET status 一列，绝不 updateById 整实体回写 ★
        // selectBatchIds 拿到的是一批**快照**，整实体回写会把每行的旧 token_version
        // 一并盖回去 —— 一次「批量封禁」等于给所有目标把此前已吊销的令牌重新放行，
        // 封禁命令发出去了、人却还能用旧 token 进来（单个入口 toggleUserStatus 同理，
        // 两处必须一致，改一处必查另一处）。
        for (User u : targets) {
            userMapper.update(null, new LambdaUpdateWrapper<User>()
                    .eq(User::getId, u.getId())
                    .set(User::getStatus, u.getStatus()));
        }
        /*
         * ★ P1-11：批量封禁同理，一次失效一批 ★
         * 单个入口与批量入口必须一致 —— 只做单个而漏掉批量，等于把
         * 「批量封禁」变成一条「看起来成功了、人却还能进来」的捷径
         * （与上面「只 SET status 一列」那段注释同一个道理：两处必须同步改）。
         */
        authSnapshotCache.invalidateAll(targets.stream().map(User::getId).toList());
        addAuditLog(banned ? "user.batchBan" : "user.batchUnban",
                banned ? "批量封禁用户" : "批量解封用户",
                targets.size() + " 个用户",
                targets.stream().map(User::getNickname).collect(Collectors.joining("、")));
        return targets.size();
    }

    /**
     * 重置密码
     * <p>
     * 固定重置为一个弱口令并由前端提示用户尽快修改。
     * 重置密码：写 BCrypt 哈希入库，返回值仍是明文初始口令（后台需要一次性展示给管理员）。
     */
    @Transactional
    public String resetUserPassword(Long id) {
        User u = userMapper.selectById(id);
        if (u == null) throw BusinessException.notFound("用户不存在");
        final String initial = "123456";
        /*
         * 两件事一起做，且都用**单列 UPDATE**：
         *  ① 换密码；
         *  ② token_version +1 —— 管理员重置密码的场景恰恰是「这个号可能已经被别人用了」，
         *     此刻把旧令牌全部作废才是这个按钮的主要意义，否则盗号者手上的 token
         *     还能继续用到自然过期。
         * 原先的 `selectById` → `setPassword` → `updateById` 是整体回写：
         * 管理员点重置的同时，用户正好自己改了昵称/头像，这一次回写会把那些改动盖回旧值；
         * 加 token_version 之后这个风险更大（会把自增结果覆盖掉）。
         * 改成只 set 需要的列，逻辑上就不可能碰到别的字段。
         */
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, id)
                .set(User::getPassword, Passwords.encode(initial))
                .setSql("token_version = token_version + 1"));
        /*
         * ★ P1-11：token_version 变了 = 旧令牌全部作废，缓存必须立即失效 ★
         * 这是「吊销」语义里最容易静默失效的一条：管理员重置密码后看到的提示是
         * 「历史登录状态已作废」，若缓存里还留着旧的 ver，盗号者手上的 token
         * 会继续被判定为有效 —— 提示与事实相反，且没有任何报错。
         */
        authSnapshotCache.invalidate(id);
        addAuditLog("user.resetPassword", "重置用户密码", "用户 #" + u.getId(),
                u.getNickname() + "（" + u.getUsername() + "）密码已被管理员重置，历史登录状态已作废");
        return initial;
    }

    /**
     * 修改密码（用户自助，设置页入口）
     * <p>
     * ★ 原密码必须校验 ★ —— 改密码是账号安全的最后一道闸门，任何人拿到
     * 一个未过期的 token 都不该能绕过原密码直接改密（否则 token 被盗即丢号）。
     * 校验规则：原密码 BCrypt 匹配；新密码 ≥ 6 位且不能与原密码相同。
     */
    @Transactional
    public void changePassword(Long userId, String oldPassword, String newPassword) {
        if (newPassword == null || newPassword.length() < 6) {
            throw BusinessException.paramError("新密码至少 6 位");
        }
        User u = userMapper.selectById(userId);
        if (u == null) throw BusinessException.notFound("账号不存在，请重新登录");
        if (oldPassword == null || !Passwords.matches(oldPassword, u.getPassword())) {
            throw BusinessException.paramError("原密码不正确");
        }
        if (Passwords.matches(newPassword, u.getPassword())) {
            throw BusinessException.paramError("新密码不能与原密码相同");
        }
        /*
         * ★ 改密码必须同时把 token_version +1（否则这次改密等于没改）★
         * t_user.password 换掉了，但已经签发的 JWT 是**自包含**的：
         * 里面只有 userId / username / role，不含任何口令派生信息，
         * 所以旧令牌在剩下的 24 小时里照样能通过鉴权 ——
         * 「怀疑账号被盗 → 赶紧改密码」这个最常用的自救动作会完全失效。
         * 让 AuthInterceptor 每请求比对 token_version，一改密旧令牌当次请求即 401。
         *
         * ★ 用 SQL 原子自增，不要「读出来 +1 再写回」★
         * 同一账号并发改密、或用户自助改密的同时管理员又重置了密码时，
         * 读改写会让两次 +1 塌缩成一次，被漏掉的那批令牌仍然有效。
         */
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .eq(User::getId, userId)
                .set(User::getPassword, Passwords.encode(newPassword))
                .setSql("token_version = token_version + 1"));
        /*
         * ★ P1-11：改密的吊销必须**当场**生效，不能等 TTL ★
         * 这个动作的语义是「我怀疑号被盗了，赶紧改密码把别人踢下线」，
         * 慢 10 秒虽然不至于失守，但把这条自救路径的确定性交给了缓存过期时间 ——
         * 一旦将来有人把 TTL 调大，这里就会悄悄变差且不报错。所以显式失效。
         */
        authSnapshotCache.invalidate(userId);
        addAuditLog("user.changePassword", "修改密码", "用户 #" + u.getId(),
                u.getNickname() + "（" + u.getUsername() + "）自助修改了登录密码，历史登录状态已作废");
    }

    /** 发送平台警告（站内信 + 审计留痕） */
    @Transactional
    public void warnUser(Long operatorId, Long id, String reason) {
        /*
         * reason 会同时落进 t_message.content 与 t_audit_log.detail（都是 TEXT），
         * 列宽上撑不爆，但站内信是要给用户看的正文：探针实测原本能塞进 2000 字，
         * 用户的警告栏会被一篇小作文刷屏。补一道业务上限。
         */
        String safeReason = Validators.optional(reason, WARN_REASON_MAX, "警告内容");
        User u = userMapper.selectById(id);
        if (u == null) throw BusinessException.notFound("用户不存在");
        messageService.sendPlatformWarning(operatorId, id, safeReason);
        addAuditLog("user.warn", "发送平台警告", "用户 #" + u.getId(),
                u.getNickname() + "：" + (safeReason == null ? "" : safeReason));
    }

    /** 调整信用分 */
    @Transactional
    public User setUserCredit(Long id, Integer delta, Integer value) {
        User u = userMapper.selectById(id);
        if (u == null) throw BusinessException.notFound("用户不存在");
        int before = u.getCreditScore();

        /*
         * ★ 增减语义必须交给数据库原子累加，不能在 Java 里「读-改-写」★
         * 原先无论传 value 还是 delta，都走「读出整行 → 在内存里算新分 → updateById 整体回写」。
         * 并发两条「扣 5 分」时，两次都读到 100 → 都写 95 → **只扣了一次**（丢失更新）。
         * 信用分是累积副作用，扣漏了不报错、也没有任何痕迹，只能靠对账才发现。
         *   - 传 value（后台直接设成分数）→ 单行绝对写，本身就是幂等的最后写入者胜；
         *   - 传 delta（加/减）      → 走 `credit_score + (n)` 的原子表达式；
         * 两种情况都用 LEAST/GREATEST 把结果夹在 [0,100]，与原来 Math.min/Math.max 口径一致。
         * （括号里的 d 是 Integer，不可能构成注入面 —— 与订单扣库存的 setSql 同一写法。）
         */
        LambdaUpdateWrapper<User> w = new LambdaUpdateWrapper<User>().eq(User::getId, id);
        if (value != null) {
            w.set(User::getCreditScore, Math.min(100, Math.max(0, value)));
        } else {
            int d = delta != null ? delta : 0;
            w.setSql("credit_score = LEAST(100, GREATEST(0, credit_score + (" + d + ")))");
        }
        userMapper.update(null, w);

        // 回读真实结果：返回给前端的必须与库里一致（而不是我在内存里算出来的那个值）
        User after = userMapper.selectById(id);
        addAuditLog("user.credit", "调整信用分", "用户 #" + after.getId(),
                after.getNickname() + "：" + before + " → " + after.getCreditScore());
        after.setPassword(null);
        return after;
    }

    // ==================== 个人中心 ====================

    /** 我发布的商品 */
    public IPage<Goods> fetchMyGoods(Long userId, int page, int pageSize, String status, String keyword) {
        return goodsMapper.selectGoodsPage(new Page<>(page, pageSize), keyword, null, userId, status, null, "new");
    }

    /**
     * 我的收藏（分页，并内嵌商品档案）
     * <p>
     * 前端 `fetchFavorites()` 声明的是 `PageResult<Favorite>`，且 `Favorite.goods`
     * 里要有标题/价格/封面 —— 只回一批 {id, goodsId} 的话收藏页是一片空白。
     * <p>
     * 实现上先取该用户**全部**收藏行再在内存里分页：收藏量是个位数，
     * 而 SQL 分页会先切页再回填商品，一旦命中「商品已被删除」的孤儿行，
     * 这一页就会缺行、total 也对不上。
     */
    public IPage<FavoriteItem> fetchFavorites(Long userId, int page, int pageSize) {
        List<Favorite> rows = favoriteMapper.selectList(
                new LambdaQueryWrapper<Favorite>().eq(Favorite::getUserId, userId)
                        .orderByDesc(Favorite::getCreateTime));
        Map<Long, Goods> goodsById = loadGoods(rows.stream().map(Favorite::getGoodsId).toList());
        List<FavoriteItem> all = rows.stream()
                .map(f -> {
                    FavoriteItem item = new FavoriteItem();
                    item.setId(f.getId());
                    item.setGoodsId(f.getGoodsId());
                    item.setCreateTime(f.getCreateTime());
                    item.setGoods(goodsById.get(f.getGoodsId()));
                    return item;
                })
                .filter(i -> i.getGoods() != null)
                .toList();
        return slice(all, page, pageSize);
    }

    /** 浏览足迹（分页，并内嵌商品档案） */
    public IPage<HistoryItem> fetchHistory(Long userId, int page, int pageSize) {
        List<com.campus.market.entity.History> rows = historyMapper.selectList(
                new LambdaQueryWrapper<com.campus.market.entity.History>()
                        .eq(com.campus.market.entity.History::getUserId, userId)
                        .orderByDesc(com.campus.market.entity.History::getViewTime));
        Map<Long, Goods> goodsById = loadGoods(rows.stream()
                .map(com.campus.market.entity.History::getGoodsId).toList());
        List<HistoryItem> all = rows.stream()
                .map(h -> {
                    HistoryItem item = new HistoryItem();
                    item.setId(h.getId());
                    item.setGoodsId(h.getGoodsId());
                    item.setViewTime(h.getViewTime());
                    item.setGoods(goodsById.get(h.getGoodsId()));
                    return item;
                })
                .filter(i -> i.getGoods() != null)
                .toList();
        return slice(all, page, pageSize);
    }

    /** 一次 selectBatchIds 建索引，避免逐行查商品造成 N+1 */
    private Map<Long, Goods> loadGoods(List<Long> goodsIds) {
        List<Long> ids = goodsIds.stream().filter(java.util.Objects::nonNull).distinct().toList();
        if (ids.isEmpty()) return Map.of();
        return goodsMapper.selectBatchIds(ids).stream()
                .collect(Collectors.toMap(Goods::getId, g -> g, (a, b) -> a));
    }

    /** 内存分页（收藏 / 足迹总量很小，切页成本可忽略） */
    private <T> IPage<T> slice(List<T> all, int page, int pageSize) {
        int p = Math.max(1, page);
        int size = Math.max(1, pageSize);
        int from = Math.min((p - 1) * size, all.size());
        int to = Math.min(from + size, all.size());
        Page<T> out = new Page<>(p, size, all.size());
        out.setRecords(all.subList(from, to));
        return out;
    }

    /**
     * 切换收藏：已收藏则取消，未收藏则添加
     *
     * ★ 连点 / 并发安全 ★
     * t_favorite 上有唯一键 uk_user_goods(user_id, goods_id)。原来是
     * 「先 selectOne 判断有没有 → 再 insert」，前端连点两下收藏按钮（或一次网络重试）
     * 会让两个请求同时判出「未收藏」并双双 insert，后到的撞唯一键抛
     * DuplicateKeyException，冒到 GlobalExceptionHandler 的兜底分支 → 用户看到 500。
     * （实测 8 次并发切换有 4 次返回 500，见 .workbuddy/verify-out.txt 的 D7 一节。）
     *
     * 修法就是**把唯一键冲突认下来**：能走到 DuplicateKeyException，说明
     * 「已收藏」这个目标状态已经被并发的另一个请求达成了 —— 对本次调用来说目标已满足，
     * 属于成功而不是失败，更不该是 500。这样无论连点多少次都不会再报内部错误，
     * 且唯一键保证库里绝不会有重复收藏行。
     *
     * ⚠️ 不要把这里改成「先用 WHERE 删、再插入」★
     * 看起来更「原子」，实际会引入更难查的 InnoDB 死锁：在 REPEATABLE READ 下，
     * `DELETE ... WHERE user_id=? AND goods_id=?` 命中不到行时会对该唯一索引的**间隙加锁**，
     * N 个并发事务各持间隙锁、又都要拿插入意向锁去 INSERT 同一行 → 互相等待成环，
     * MySQL 随机挑一个 victim 回滚，报 `Deadlock found when trying to get lock` → 同样是 500。
     * （这条是实测踩出来的：改成 WHERE 删之后，8 次并发变成 0,0,500,500,0,0,500,0。）
     * 按主键 deleteById 只在**确实存在**的记录上加行锁，不会留间隙锁，所以不会成环。
     *
     * @return true 表示当前处于「已收藏」状态
     */
    @Transactional
    public boolean toggleFavorite(Long userId, Long goodsId) {
        Goods g = goodsMapper.selectById(goodsId);
        if (g == null) throw BusinessException.notFound("商品不存在");
        Favorite exist = favoriteMapper.selectOne(new LambdaQueryWrapper<Favorite>()
                .eq(Favorite::getUserId, userId)
                .eq(Favorite::getGoodsId, goodsId));
        if (exist != null) {
            favoriteMapper.deleteById(exist.getId());
            refreshFavoriteCount(goodsId);
            return false;
        }
        Favorite f = new Favorite();
        f.setUserId(userId);
        f.setGoodsId(goodsId);
        f.setCreateTime(LocalDateTime.now());
        try {
            favoriteMapper.insert(f);
        } catch (DuplicateKeyException ignored) {
            // 并发下另一个请求刚刚写入同一条收藏：目标状态已达成，无需重试也无需报错
        }
        refreshFavoriteCount(goodsId);
        return true;
    }

    /** 取消收藏（幂等：没收藏过也算成功，前端不必先查状态） */
    @Transactional
    public void removeFavorite(Long userId, Long goodsId) {
        favoriteMapper.delete(new LambdaQueryWrapper<Favorite>()
                .eq(Favorite::getUserId, userId)
                .eq(Favorite::getGoodsId, goodsId));
        refreshFavoriteCount(goodsId);
    }

    /** 收藏数重算并回写商品表，避免计数与实际收藏行数长期漂移 */
    private void refreshFavoriteCount(Long goodsId) {
        long count = favoriteMapper.selectCount(
                new LambdaQueryWrapper<Favorite>().eq(Favorite::getGoodsId, goodsId));
        /*
         * ★ 只写 favorite_count 一列，且不再「先读整行」★
         * 原先是 selectById 读出整个 Goods → set 计数 → updateById 整体回写。
         * 两个问题：
         *  ① 并发 toggle 时后写覆盖前写，计数会漂移（重算出来的值反而不是最新的）；
         *  ② 整体回写会把**读到的旧快照**盖回去 —— 同一时刻别人增加的 view_count、
         *     或卖家改过的 price，会连同这次收藏一起被还原成旧值。
         * 现在只发一条单列 UPDATE：不读整行，就不可能覆盖别的列。
         * 商品已不存在时影响 0 行，与原实现「g == null 直接 return」等价。
         */
        goodsMapper.update(null, new LambdaUpdateWrapper<Goods>()
                .eq(Goods::getId, goodsId)
                .set(Goods::getFavoriteCount, (int) count));
    }

    /**
     * 记录浏览足迹
     * <p>
     * 同一件商品只保留最近一次：先按 goodsId 去重再插入，
     * 否则反复看同一件商品会把足迹列表刷成一模一样的条目。
     * 超过 {@link #HISTORY_MAX} 条时丢弃最旧的。
     */
    @Transactional
    public void recordHistory(Long userId, Long goodsId) {
        historyMapper.delete(new LambdaQueryWrapper<com.campus.market.entity.History>()
                .eq(com.campus.market.entity.History::getUserId, userId)
                .eq(com.campus.market.entity.History::getGoodsId, goodsId));
        com.campus.market.entity.History h = new com.campus.market.entity.History();
        h.setUserId(userId);
        h.setGoodsId(goodsId);
        h.setViewTime(LocalDateTime.now());
        historyMapper.insert(h);
        trimHistory(userId);
    }

    /** 删除一条足迹（越权保护：只能删自己的） */
    @Transactional
    public void deleteHistory(Long userId, Long id) {
        com.campus.market.entity.History h = historyMapper.selectById(id);
        if (h == null) return;
        if (!userId.equals(h.getUserId())) {
            throw BusinessException.forbidden("只能删除自己的浏览足迹");
        }
        historyMapper.deleteById(id);
    }

    /** 清空浏览历史 */
    @Transactional
    public void clearHistory(Long userId) {
        historyMapper.delete(new LambdaQueryWrapper<com.campus.market.entity.History>()
                .eq(com.campus.market.entity.History::getUserId, userId));
    }

    /** 超出上限时裁掉最旧的几条 */
    private void trimHistory(Long userId) {
        List<com.campus.market.entity.History> all = historyMapper.selectList(
                new LambdaQueryWrapper<com.campus.market.entity.History>()
                        .eq(com.campus.market.entity.History::getUserId, userId)
                        .orderByDesc(com.campus.market.entity.History::getViewTime));
        if (all.size() <= HISTORY_MAX) return;
        all.subList(HISTORY_MAX, all.size())
                .forEach(h -> historyMapper.deleteById(h.getId()));
    }

    /** 收货地址列表（默认地址排最前） */
    public List<Address> fetchAddresses(Long userId) {
        return addressMapper.selectList(
                new LambdaQueryWrapper<Address>()
                        .eq(Address::getUserId, userId)
                        .orderByDesc(Address::getIsDefault));
    }

    /** 新增 / 修改地址 */
    @Transactional
    public Address saveAddress(Long userId, Address addr) {
        /*
         * ★ 地址六列全是窄 varchar，一个都不能漏 ★
         * receiver(50) / phone(20) / region(200) / detail(500) / tag(20)。
         * 原先这里一条校验都没有，直接把实体 insert 出去 —— 收货人写 80 个字，
         * 用户看到的是 500「服务器内部错误」而不是「收货人最多 50 个字」。
         * 电话尤其不能只判长度：它是快递员唯一能联系到买家的方式，
         * 写错的代价是包裹退件，所以补了格式校验。
         */
        addr.setReceiver(Validators.required(addr.getReceiver(), ADDR_RECEIVER_MAX, "收货人"));
        addr.setPhone(Validators.phone(addr.getPhone(), "联系电话"));
        if (addr.getPhone() == null || addr.getPhone().isBlank()) {
            throw BusinessException.paramError("联系电话不能为空");
        }
        addr.setRegion(Validators.required(addr.getRegion(), ADDR_REGION_MAX, "所在地区"));
        addr.setDetail(Validators.required(addr.getDetail(), ADDR_DETAIL_MAX, "详细地址"));
        addr.setTag(Validators.optional(addr.getTag(), ADDR_TAG_MAX, "地址标签"));

        if (addr.getIsDefault() != null && addr.getIsDefault()) {
            // 取消其他默认地址
            List<Address> all = addressMapper.selectList(
                    new LambdaQueryWrapper<Address>().eq(Address::getUserId, userId));
            all.forEach(a -> {
                if (a.getIsDefault() != null && a.getIsDefault()) {
                    a.setIsDefault(false);
                    addressMapper.updateById(a);
                }
            });
        }
        if (addr.getId() != null) {
            // 越权保护：地址只能改自己的
            Address exist = addressMapper.selectById(addr.getId());
            if (exist != null && !userId.equals(exist.getUserId())) {
                throw BusinessException.forbidden("只能修改自己的收货地址");
            }
            addr.setUserId(userId);
            addressMapper.updateById(addr);
        } else {
            addr.setUserId(userId);
            addr.setCreateTime(LocalDateTime.now());
            addressMapper.insert(addr);
        }
        return addr;
    }

    /** 删除地址（越权保护：只能删自己的） */
    @Transactional
    public void deleteAddress(Long userId, Long id) {
        Address exist = addressMapper.selectById(id);
        if (exist == null) return;
        if (!userId.equals(exist.getUserId())) {
            throw BusinessException.forbidden("只能删除自己的收货地址");
        }
        addressMapper.deleteById(id);
    }

    // ==================== 内部工具 ====================

    private void addAuditLog(String action, String label, String target, String detail) {
        AuditLog log = new AuditLog();
        log.setAction(action);
        log.setActionLabel(label);
        log.setTarget(target);
        log.setDetail(detail);
        // 管理员封禁 / 用户自助改密要各归各名，不能一律记 admin
        log.setOperator(OperatorContext.currentOperator());
        log.setCreateTime(LocalDateTime.now());
        auditLogMapper.insert(log);
    }
}
