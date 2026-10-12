package com.campus.market.mapper;

import org.apache.ibatis.annotations.Param;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Mapper 参数绑定一致性测试（离线：不启动 Spring、不连数据库）。
 * <p>
 * ★ 守的是哪一类缺陷 ★
 * <p>
 * MyBatis 的取值规则：方法参数上只要出现 <b>任意一个</b> {@code @Param}，
 * 整个参数列表就被「命名」（见 {@code ParamNameResolver#getNamedParams}），
 * XML 里可用的名字只剩 {@code [各 @Param 的值, param1..paramN]}。
 * 此时若 XML 写成 {@code #{pageSize}}，而 {@code pageSize} 其实是
 * {@code @Param("query")} 那个 Map 里的一个键，就会抛：
 * <pre>
 *   BindingException: Parameter 'pageSize' not found.
 *   Available parameters are [query, param1]
 * </pre>
 * <p>
 * 这个异常属于「最难查」的那一类，原因有三：
 * <ol>
 *   <li>它抛在 {@code BaseExecutor.createCacheKey}（算缓存 key 时），<b>比 SQL 解析还早</b>，
 *       所以 SQL 日志里看不到任何线索 —— 只有一条与 SQL 无关的栈；</li>
 *   <li>被 {@code GlobalExceptionHandler} 兜底脱敏成「服务器内部错误，请稍后再试」，
 *       调用方看到的信息与真实原因完全无关；</li>
 *   <li>同一个 XML 里其它语句都写对了，只有漏了前缀的那一条会炸，
 *       人工 review 时眼睛会自动跳过「看起来很正常」的那一行。</li>
 * </ol>
 * <p>
 * 真实案例：{@code OrderMapper.xml} 的 {@code selectAdminOrdersForExport} 写了
 * {@code LIMIT #{pageSize}}，而同一个文件里 {@code adminFilter} 每一处都是
 * {@code query.xxx} —— 于是管理端点「导出当前筛选」稳定 500，列表却一切正常。
 * <p>
 * ★ 为什么用「反射 + 文本交叉比对」而不是跑一次查询 ★
 * <p>
 * 跑查询需要 Spring 上下文与 MySQL，既慢又依赖环境；
 * 而这里要守的规则纯粹是「名字对不对得上」，静态即可判定。
 * 因此本测试能秒级执行，且覆盖<b>全部</b> Mapper —— 而不是只盯着已经出过问题的那一个。
 * 接口签名用反射读（拿 {@code @Param} 最可靠，不用解析 Java 源码），
 * XML 读源文件原文（部署时就是这一份）。
 */
class MapperParamBindingTest {

    /** Mapper XML 源文件目录（surefire 的工作目录是项目根） */
    private static final Path XML_DIR = Paths.get("src", "main", "resources", "mapper");

    /** 一个语句可用的参数名集合 */
    private record Binding(Set<String> names, boolean expandable, String signature) {
    }

    /** 一处非法引用 */
    private record Problem(String file, String statementId, String ref, Set<String> allowed, String signature) {
    }

    private static final Pattern NAMESPACE = Pattern.compile("namespace=\"([\\w.]+)\"");
    private static final Pattern FRAGMENT = Pattern.compile(
            "<sql\\s+id=\"(\\w+)\"[^>]*>(.*?)</sql>", Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern STATEMENT = Pattern.compile(
            "<(select|insert|update|delete)\\s+id=\"(\\w+)\"[^>]*>(.*?)</\\1>",
            Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern INCLUDE = Pattern.compile(
            "<include\\s+refid=\"(\\w+)\"\\s*/?>", Pattern.CASE_INSENSITIVE);
    private static final Pattern HASH_REF = Pattern.compile("#\\{([^}]*)}");
    private static final Pattern DOLLAR_REF = Pattern.compile("\\$\\{([^}]*)}");
    private static final Pattern TEST_ATTR = Pattern.compile("test=\"([^\"]*)\"");
    private static final Pattern STRING_LITERAL = Pattern.compile("'[^']*'");
    private static final Pattern PROPERTY_CHAIN = Pattern.compile("[a-zA-Z_]\\w*(?:\\.\\w+)*");
    private static final Pattern FOREACH_ITEM = Pattern.compile("<foreach[^>]*\\bitem=\"(\\w+)\"");
    private static final Pattern FOREACH_INDEX = Pattern.compile("<foreach[^>]*\\bindex=\"(\\w+)\"");
    private static final Pattern BIND_NAME = Pattern.compile("<bind[^>]*\\bname=\"(\\w+)\"");

    /** OGNL 的字面量与逻辑运算符：出现在 test 表达式里但不是变量，必须排除 */
    private static final Set<String> OGNL_KEYWORDS =
            Set.of("null", "true", "false", "and", "or", "not");

    @Test
    @DisplayName("Mapper XML 的 #{} / ${} / test 只能引用方法参数命名空间内的名字")
    void xmlReferencesMustBeBindable() throws Exception {
        List<Problem> problems = new ArrayList<>();
        List<Path> xmlFiles = listXmlFiles();
        int statementCount = 0;

        for (Path xml : xmlFiles) {
            String text = Files.readString(xml, StandardCharsets.UTF_8);
            Matcher nsMatcher = NAMESPACE.matcher(text);
            if (!nsMatcher.find()) {
                continue;
            }
            String namespace = nsMatcher.group(1);
            Class<?> iface;
            try {
                iface = Class.forName(namespace);
            } catch (ClassNotFoundException e) {
                problems.add(new Problem(xml.getFileName().toString(), "(namespace)",
                        namespace, Set.of(), "找不到该 Mapper 接口：" + namespace));
                continue;
            }

            Map<String, Binding> bindings = analyze(iface);
            Map<String, String> fragments = new HashMap<>();
            Matcher fm = FRAGMENT.matcher(text);
            while (fm.find()) {
                fragments.put(fm.group(1), fm.group(2));
            }

            Matcher sm = STATEMENT.matcher(text);
            while (sm.find()) {
                String id = sm.group(2);
                statementCount++;
                Binding binding = bindings.get(id);
                if (binding == null) {
                    // XML 里有、接口里没有 —— 调用时不会被触发，但说明文件已经腐化
                    problems.add(new Problem(xml.getFileName().toString(), id,
                            "(该 id 在 " + namespace + " 中没有对应方法)", Set.of(), "(无)"));
                    continue;
                }
                if (binding.expandable()) {
                    // 单参数且无 @Param：MyBatis 直接展开该参数（Map 展开成键 / POJO 展开成属性），
                    // 任意名字都能取到，静态无法也不应判定
                    continue;
                }
                String body = expandIncludes(sm.group(3), fragments, new LinkedHashSet<>());
                for (String ref : collectRefs(body, binding)) {
                    problems.add(new Problem(xml.getFileName().toString(), id, ref,
                            binding.names(), binding.signature()));
                }
            }
        }

        // 防止「目录不存在 / 正则失配」导致的永远通过的假绿
        assertTrue(statementCount > 0,
                "没有扫描到任何 Mapper 语句，测试已失效（XML_DIR=" + XML_DIR.toAbsolutePath() + "）");

        if (!problems.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            sb.append("发现 ").append(problems.size()).append(" 处 XML 引用了方法参数命名空间之外的名字：\n");
            for (Problem p : problems) {
                sb.append("\n  · ").append(p.file()).append("  语句 ").append(p.statementId()).append('\n');
                sb.append("      引用了   -> ").append(p.ref()).append('\n');
                sb.append("      可用名   -> ").append(p.allowed()).append('\n');
                sb.append("      方法签名 -> ").append(p.signature()).append('\n');
            }
            sb.append("""

                    修法二选一：
                      1) XML 补上前缀（本项目惯例）：#{pageSize} -> #{query.pageSize}
                      2) 或把该参数改成独立形参并加 @Param("pageSize")

                    注意：SQL 是能编译、能启动、列表页也正常的 —— 只有走到这条语句才炸，
                    别用「启动没报错」当作通过。
                    """);
            fail(sb.toString());
        }
    }

    /** 至少能读到几个 Mapper 文件，否则说明路径变了、测试在空跑 */
    @Test
    @DisplayName("扫描器自身有效：能读到 Mapper 目录与文件")
    void scannerMustSeeMapperFiles() {
        List<Path> files = listXmlFiles();
        assertTrue(files.size() >= 3,
                "只找到 " + files.size() + " 个 Mapper XML（期望 >= 3），扫描路径可能已失效：" + XML_DIR.toAbsolutePath());
    }

    // ==================== 内部工具 ====================

    private List<Path> listXmlFiles() {
        if (!Files.isDirectory(XML_DIR)) {
            fail("找不到 Mapper 目录：" + XML_DIR.toAbsolutePath()
                    + "（测试工作目录应为项目根，当前为 " + Paths.get("").toAbsolutePath() + "）");
            return List.of();
        }
        try (Stream<Path> s = Files.list(XML_DIR)) {
            return s.filter(p -> p.getFileName().toString().endsWith(".xml"))
                    .sorted(Comparator.comparing(Path::toString))
                    .toList();
        } catch (IOException e) {
            fail("读取 Mapper 目录失败：" + e.getMessage());
            return List.of();
        }
    }

    /**
     * 反射读出接口方法的可绑定参数名。
     * <p>
     * 规则与 {@code ParamNameResolver} 对齐：只要出现过 @Param，就整体命名；
     * 无注解的形参此时用其真实参数名（编译带 {@code -parameters} 时可用，
     * Spring Boot 的 parent 默认开启）并始终额外注册 {@code paramN}。
     */
    private Map<String, Binding> analyze(Class<?> iface) {
        Map<String, Binding> out = new HashMap<>();
        for (Method m : iface.getDeclaredMethods()) {
            if (m.isBridge() || m.isSynthetic()) {
                continue;
            }
            Parameter[] params = m.getParameters();
            Set<String> names = new LinkedHashSet<>();
            boolean hasParamAnnotation = false;
            StringBuilder sig = new StringBuilder(m.getName()).append('(');
            for (int i = 0; i < params.length; i++) {
                Param ann = params[i].getAnnotation(Param.class);
                if (ann != null) {
                    hasParamAnnotation = true;
                    names.add(ann.value());
                }
                names.add("param" + (i + 1));
                if (i > 0) {
                    sig.append(", ");
                }
                sig.append(params[i].getType().getSimpleName()).append(' ').append(params[i].getName());
            }
            sig.append(')');
            boolean expandable = params.length == 1 && !hasParamAnnotation;
            out.put(m.getName(), new Binding(names, expandable, sig.toString()));
        }
        return out;
    }

    /** 把 &lt;include refid="x"/&gt; 就地展开为片段正文，否则片段里的引用会被漏检 */
    private String expandIncludes(String body, Map<String, String> fragments, Set<String> visiting) {
        Matcher m = INCLUDE.matcher(body);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String ref = m.group(1);
            String frag = fragments.get(ref);
            if (frag == null || !visiting.add(ref)) {
                m.appendReplacement(sb, Matcher.quoteReplacement(m.group()));
                continue;
            }
            String expanded = expandIncludes(frag, fragments, visiting);
            visiting.remove(ref);
            m.appendReplacement(sb, Matcher.quoteReplacement(expanded));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /** 抽出该语句里所有「取不到就会报错」的引用；能取到的与局部变量直接丢弃 */
    private List<String> collectRefs(String body, Binding binding) {
        Set<String> local = new LinkedHashSet<>();
        Matcher mi = FOREACH_ITEM.matcher(body);
        while (mi.find()) {
            local.add(mi.group(1));
        }
        Matcher mx = FOREACH_INDEX.matcher(body);
        while (mx.find()) {
            local.add(mx.group(1));
        }
        Matcher mb = BIND_NAME.matcher(body);
        while (mb.find()) {
            local.add(mb.group(1));
        }

        List<String> raw = new ArrayList<>();
        Matcher mh = HASH_REF.matcher(body);
        while (mh.find()) {
            raw.add(mh.group(1).split(",")[0].trim());
        }
        Matcher md = DOLLAR_REF.matcher(body);
        while (md.find()) {
            raw.add(md.group(1).split(",")[0].trim());
        }
        Matcher mt = TEST_ATTR.matcher(body);
        while (mt.find()) {
            // ★ 先剔除引号内的字符串常量（'price_asc' 是常量不是变量），
            //   否则满屏假阳性；再按「属性链」整条抓取，
            //   否则 query.sort 里的 sort 会被误当成独立变量。
            String expr = STRING_LITERAL.matcher(mt.group(1)).replaceAll(" ");
            Matcher pc = PROPERTY_CHAIN.matcher(expr);
            while (pc.find()) {
                if (expr.substring(pc.end()).stripLeading().startsWith("(")) {
                    continue;   // 方法调用形态，如 statuses.size()
                }
                raw.add(pc.group());
            }
        }

        List<String> bad = new ArrayList<>();
        for (String ref : raw) {
            if (ref.isEmpty()) {
                continue;
            }
            String root = ref.split("\\.")[0].trim();
            if (root.isEmpty() || !Character.isJavaIdentifierStart(root.charAt(0))) {
                continue;
            }
            if (OGNL_KEYWORDS.contains(root)) {
                // null / true / false / and / or / not 是字面量与运算符，不是变量。
                // 漏掉这一条，`test="rating != null"` 会被判成引用了名为 null 的参数。
                continue;
            }
            if (binding.names().contains(root) || local.contains(root)) {
                continue;
            }
            bad.add(ref);
        }
        return bad;
    }
}
