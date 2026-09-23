package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.Passwords;
import com.campus.market.config.JwtConfig;
import com.campus.market.entity.User;
import com.campus.market.mapper.AddressMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.UserMapper;
import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 「改了鉴权列 = 必须让缓存失效」这条契约的看守（P1-11）。
 *
 * <h3>★★ 为什么这条契约值得单独一个测试类 ★★</h3>
 * 引入 {@link AuthSnapshotCache} 之后，「封禁 / 吊销」多了一个新的失效面：
 * 写入点忘了清缓存时，表现是**被封的人还能再进来最多 10 秒** ——
 * 接口全 200、日志无异常、管理员看到的提示还是「已封禁」。这类缺陷不会自己暴露，
 * 只能靠判据抓。于是分两层守：
 * <ol>
 *   <li><b>行为层</b>（本类前半）：用**真缓存**跑每个写入方法，断言「下一个鉴权读就看到新状态」。
 *       它证明的是「已接线的那几处真的接线了」。</li>
 *   <li><b>完整性层</b>（{@link #everyAuthColumnWriteInvalidates()}）：扫 {@code src/main/java}
 *       全部源码，找「写 status / role / token_version」的语句，要求**同一函数体内**必须有失效调用。
 *       它证明的是「没有漏掉任何一处」——包括将来新增的。行为层永远追不上新增的写入点，
 *       这一层才能。</li>
 * </ol>
 *
 * <h3>★ 判据为什么锚「缓存里还能读到什么」而不是「有没有调用 invalidate」★</h3>
 * 「调用了 invalidate」只是手段：真正要保证的能力是**下一个鉴权请求看到的是库里的最新状态**。
 * 所以行为层的断言一律是 {@code cache.get(id)} 的结果，而不是
 * {@code verify(cache).invalidate(...)} —— 后者换一种失效实现（比如改成写时替换条目）
 * 就会误报红，而能力其实没丢。
 */
class AuthCacheInvalidationTest {

    private static final long USER_ID = 10L;

    private UserMapper userMapper;
    private AuthSnapshotCache cache;
    private UserService service;

    @BeforeEach
    void setUp() {
        userMapper = mock(UserMapper.class);
        // ★ 用真缓存，不用 mock ★：本类断言的是「缓存里还能不能读到旧值」，
        // 换成 mock 就变成只断言「方法被调用过」，那正是上面说的「锚手段不锚能力」。
        cache = new AuthSnapshotCache(userMapper);
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
                cache);
        // 走 LambdaUpdateWrapper.set() 解析列名要靠实体元数据；纯单测没有 MyBatis 启动流程
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), User.class);
    }

    private User row(String status, String role, Integer tokenVersion) {
        User u = new User();
        u.setId(USER_ID);
        u.setUsername("tom");
        u.setNickname("汤姆");
        u.setStatus(status);
        u.setRole(role);
        u.setTokenVersion(tokenVersion);
        return u;
    }

    /** 让回源查询读到指定的那一行（每次调用覆盖上一次的桩） */
    private void dbHas(User u) {
        when(userMapper.selectById(USER_ID)).thenReturn(u);
    }

    @Test
    @DisplayName("单个封禁：下一个鉴权读就应该是 banned，不用等 TTL")
    void banIsVisibleOnTheVeryNextAuthRead() {
        dbHas(row("active", "user", 0));
        assertFalse(cache.get(USER_ID).orElseThrow().isBanned(), "前提：他此刻是正常的，缓存已建立");

        service.toggleUserStatus(USER_ID, true);

        // 真实环境里上一步 UPDATE 就是这次库变更；这里手动把库侧摆成结果态
        dbHas(row("banned", "user", 0));
        assertTrue(cache.get(USER_ID).orElseThrow().isBanned(),
                "封禁后第一个鉴权请求必须看到 banned —— 否则那 10 秒 TTL 就是被封者的逃生窗口");
    }

    @Test
    @DisplayName("批量封禁：一次失效要覆盖整批，不能只清一个")
    void batchBanIsVisibleOnTheVeryNextAuthRead() {
        dbHas(row("active", "user", 0));
        cache.get(USER_ID);
        when(userMapper.selectBatchIds(anyList())).thenReturn(List.of(row("active", "user", 0)));

        service.batchToggleUserStatus(List.of(USER_ID), true);

        dbHas(row("banned", "user", 0));
        assertTrue(cache.get(USER_ID).orElseThrow().isBanned(),
                "批量入口漏失效 = 「批量封禁看起来成功了、人却还能进来」");
    }

    @Test
    @DisplayName("管理员重置密码：token_version 当场作废，旧令牌不能多活")
    void resetPasswordRevokesOnTheVeryNextAuthRead() {
        dbHas(row("active", "user", 0));
        assertEquals(0, cache.get(USER_ID).orElseThrow().tokenVersion());

        service.resetUserPassword(USER_ID);

        dbHas(row("active", "user", 1));
        assertEquals(1, cache.get(USER_ID).orElseThrow().tokenVersion(),
                "管理员看到的是「历史登录状态已作废」，缓存里若还是旧 ver，这句提示就是假的");
    }

    @Test
    @DisplayName("自助改密：这是「怀疑被盗号」的自救动作，吊销必须当场生效")
    void changePasswordRevokesOnTheVeryNextAuthRead() {
        User before = row("active", "user", 0);
        before.setPassword(Passwords.encode("oldpass"));
        dbHas(before);
        cache.get(USER_ID);

        service.changePassword(USER_ID, "oldpass", "newpass");

        dbHas(row("active", "user", 1));
        assertEquals(1, cache.get(USER_ID).orElseThrow().tokenVersion(),
                "改密后旧令牌必须当次请求即失效");
    }

    /**
     * ★ 对照组：证明失效锚的是「那三列」而不是「这张表被写过」★
     * <p>
     * {@code heartbeat} 每 60 秒就 UPDATE 一次 t_user（只写 last_active_at）。
     * 如果失效写成「动了 t_user 就清缓存」，缓存会被心跳持续冲掉、命中率趋近 0 ——
     * 加了缓存等于没加。这条用例就是那个设计的反面：它**必须保持绿**。
     * <p>
     * 没有这条，「锚三列」这个决定就只是类注释里的一句话，没人能证明它真的成立。
     */
    @Test
    @DisplayName("对照组：心跳（每 60 秒一次的表写入）不得冲掉鉴权缓存")
    void heartbeatDoesNotFlushTheAuthCache() {
        dbHas(row("active", "user", 0));
        cache.get(USER_ID);

        service.heartbeat(USER_ID);

        cache.get(USER_ID);
        verify(userMapper, times(1)).selectById(USER_ID);
    }

    /* ==================== 完整性层：源码扫描 ==================== */

    /**
     * 「写鉴权列」的两种形态：
     * <ul>
     *   <li>wrapper 单列写：{@code .set(User::getStatus, ...)} / Role / TokenVersion；</li>
     *   <li>原子表达式：{@code .setSql("token_version = token_version + 1")}。</li>
     * </ul>
     * 刻意要求 {@code User::} 限定：{@code u.setStatus(...)} 那种是 POJO 局部赋值，不落库，
     * 把它算进来会让判据变噪音（而噪音会让人开始忽略这个看守）。
     */
    private static final Pattern AUTH_COLUMN_WRITE = Pattern.compile(
            "\\.set\\(\\s*User::get(?:Status|Role|TokenVersion)\\b"
                    + "|"
                    + "\\.setSql\\(\\s*\"[^\"]*\\b(?:status|role|token_version)\\b");

    /** 失效调用（{@code invalidate} 与 {@code invalidateAll} 都以此开头） */
    private static final String INVALIDATE_CALL = "authSnapshotCache.invalidate";

    /** 扫描结果：命中总数 + 违规清单（总数用于「自证扫到了东西」） */
    private record Scan(int total, List<String> offenders) {
    }

    @Test
    @DisplayName("完整性看守：任何写 status/role/token_version 的函数体里都必须有缓存失效")
    void everyAuthColumnWriteInvalidates() throws IOException {
        List<Path> files = javaSources();
        assertTrue(files.size() > 20,
                "只扫到 " + files.size() + " 个源文件 —— 扫描根目录不对，这个看守会假绿。"
                        + "工作目录：" + System.getProperty("user.dir"));

        int total = 0;
        List<String> offenders = new ArrayList<>();
        for (Path f : files) {
            Scan s = scan(blankComments(Files.readString(f, StandardCharsets.UTF_8)));
            total += s.total();
            for (String o : s.offenders()) {
                offenders.add(f.getFileName() + " " + o);
            }
        }

        // ★ 自证：一处都没扫到，说明正则或剥注释写坏了 —— 那种情况下"零违规"是假绿
        // （2026-09-23 D11：approveUser 拆除后 UserService 剩 4 处 + ContentService 1 处）
        assertTrue(total >= 5,
                "只找到 " + total + " 处鉴权列写入，预期至少 5 处"
                        + "（UserService 4 处 + ContentService 1 处）——正则失效时会假绿");
        assertEquals(List.of(), offenders,
                "以下函数改了鉴权列却没让缓存失效，被封/被吊销的人会多活最多 "
                        + AuthSnapshotCache.TTL_SECONDS + " 秒：\n" + String.join("\n", offenders));
    }

    /**
     * ★ 看守自身的对照组 ★
     * <p>
     * 上面那条用例在「实现正确」时是绿的；但一个恒绿的看守与一个写坏的看守长得一模一样。
     * 所以这里喂两段**合成代码**：一段漏了失效（必须被判违规）、一段有失效（必须判干净）。
     * 两条都过，才说明「零违规」是真的零，而不是判据恒真。
     */
    @Test
    @DisplayName("看守自身的对照：漏失效的合成函数必须被抓出，写了的必须判干净")
    void guardHasDiscriminatingPower() {
        String missing = "class X {\n  void f() {\n    w.set(User::getStatus, \"banned\");\n  }\n}\n";
        assertEquals(1, scan(missing).total(), "合成样本本身就该被识别为一次鉴权列写入");
        assertEquals(1, scan(missing).offenders().size(),
                "少了失效调用却没被抓出来 —— 这个看守没有判别力，上面那条用例的绿不作数");

        String present = "class X {\n  void f() {\n    w.set(User::getStatus, \"banned\");\n"
                + "    authSnapshotCache.invalidate(1L);\n  }\n}\n";
        assertEquals(1, scan(present).total());
        assertEquals(0, scan(present).offenders().size(), "有失效调用却被误判违规（假红会把这条看守变成噪音）");

        // 反向对照：POJO 上的局部 setStatus **不该**被算作落库写入
        String pojoSetter = "class X {\n  void f() {\n    u.setStatus(\"banned\");\n  }\n}\n";
        assertEquals(0, scan(pojoSetter).total(),
                "u.setStatus(...) 是内存里的赋值、不落库；把它算进来会产生恒定噪音");
    }

    private static Scan scan(String code) {
        int total = 0;
        List<String> offenders = new ArrayList<>();
        Matcher m = AUTH_COLUMN_WRITE.matcher(code);
        while (m.find()) {
            total++;
            String body = enclosingMethodBody(code, m.start());
            if (!body.contains(INVALIDATE_CALL)) {
                offenders.add("第 " + lineOf(code, m.start()) + " 行 " + snippet(code, m.start()));
            }
        }
        return new Scan(total, offenders);
    }

    /** 源码文件集合。两种工作目录都试一遍，都不通就返回空（由用例里的"扫到几个文件"自证拦下） */
    private static List<Path> javaSources() throws IOException {
        for (String root : List.of("src/main/java", "campus-secondhand-backend/src/main/java")) {
            Path p = Path.of(root);
            if (Files.isDirectory(p)) {
                try (var walk = Files.walk(p)) {
                    List<Path> found = walk.filter(x -> x.toString().endsWith(".java")).toList();
                    if (!found.isEmpty()) {
                        return found;
                    }
                }
            }
        }
        return List.of();
    }

    /**
     * 把注释抹成空格（**保持下标对齐**，这样报出来的行号还是原文行号）。
     * <p>
     * ★ 字符串字面量**保留内容、只把其中的花括号抹掉** ★ —— 这一步是必需的：
     * 判据要抓的 {@code setSql("token_version = token_version + 1")} 恰恰在字符串里，
     * 整段抹掉就再也抓不到了；而保留花括号又会让后面的大括号配对错位。
     * 这也是本项目在审计脚本里踩过的同一类坑（不剥注释与字符串，判据会自骗自）。
     */
    private static String blankComments(String src) {
        char[] out = src.toCharArray();
        boolean line = false, block = false, str = false, chr = false;
        for (int i = 0; i < src.length(); i++) {
            char c = src.charAt(i);
            char n = i + 1 < src.length() ? src.charAt(i + 1) : '\0';
            if (line) {
                if (c == '\n') line = false;
                else out[i] = ' ';
            } else if (block) {
                if (c == '*' && n == '/') {
                    out[i] = ' ';
                    out[i + 1] = ' ';
                    i++;
                    block = false;
                } else if (c != '\n') {
                    out[i] = ' ';
                }
            } else if (str || chr) {
                if (c == '\\') {
                    i++; // 转义序列原样跳过，避免 \" 被当成结束引号
                } else if (str && c == '"') {
                    str = false;
                } else if (chr && c == '\'') {
                    chr = false;
                } else if (c == '{' || c == '}') {
                    out[i] = ' ';
                }
            } else if (c == '/' && n == '/') {
                out[i] = ' ';
                line = true;
            } else if (c == '/' && n == '*') {
                out[i] = ' ';
                block = true;
            } else if (c == '"') {
                str = true;
            } else if (c == '\'') {
                chr = true;
            }
        }
        return new String(out);
    }

    /**
     * 取包含 {@code idx} 的**方法体**（不含签名与花括号）。
     * <p>
     * 做法：把从 idx 往外一层的所有块开括号都收集起来（{@code [最内层, …, 最外层]}），
     * 最外层那个是类体，**倒数第二个就是方法体**。
     * 用大括号配对而不是「往前后找 N 行」——后者在方法变长之后会静默失效
     * （本项目已经因为「附近 N 行」这个写法吃过一次亏）。
     * <p>
     * 找不到（写不在任何块里，比如字段初始化）或只有类体一层时返回空串，
     * 调用方会判它违规：宁可要求显式失效，也不要「不知道在哪所以就放过」。
     */
    private static String enclosingMethodBody(String code, int idx) {
        List<Integer> opens = new ArrayList<>();
        int cursor = idx;
        while (true) {
            int open = enclosingOpenBrace(code, cursor);
            if (open < 0) break;
            opens.add(open);
            cursor = open - 1;
        }
        if (opens.size() < 2) {
            return "";
        }
        int methodOpen = opens.get(opens.size() - 2);
        int close = matchingClose(code, methodOpen);
        return close > methodOpen ? code.substring(methodOpen + 1, close) : "";
    }

    /** 往前找最近的、深度为 0 的 {@code &#123;} —— 即包含 cursor 的那一层块的开括号 */
    private static int enclosingOpenBrace(String code, int cursor) {
        int depth = 0;
        for (int i = Math.min(cursor, code.length() - 1); i >= 0; i--) {
            char c = code.charAt(i);
            if (c == '}') {
                depth++;
            } else if (c == '{') {
                if (depth == 0) return i;
                depth--;
            }
        }
        return -1;
    }

    /** 与 open 处花括号配对的闭括号下标 */
    private static int matchingClose(String code, int open) {
        int depth = 0;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    private static int lineOf(String code, int idx) {
        int line = 1;
        for (int i = 0; i < idx && i < code.length(); i++) {
            if (code.charAt(i) == '\n') line++;
        }
        return line;
    }

    private static String snippet(String code, int idx) {
        String s = code.substring(idx, Math.min(code.length(), idx + 60)).replaceAll("\\s+", " ");
        return s;
    }
}
