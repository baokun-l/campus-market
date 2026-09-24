package com.campus.market.config;

import lombok.Getter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * ---- 支付配置（唯一入口）----
 * <p>
 * ★★ 为什么支付配置要收在一个类里，而不是各处 {@code @Value} 散着写 ★★
 * <p>
 * 本项目吃过一次「一个概念两个名字 = 两个开关」的亏（P0 时区跨源：yml 里的占位符
 * 与代码读的键名不是同一个，于是「改了没反应」而日志里一点错都没有）。
 * 支付这块的概念更多、更容易踩：渠道开关、超时、回调地址、密钥……
 * 一旦同一个概念在三个类里各读一次，就会出现「收银台说这条渠道可用、
 * 结算时却找不到它」这类自相矛盾。
 * <p>
 * 所以：**所有 {@code app.pay.*} 只在这里读一次**，其余类一律注入本对象。
 *
 * ★★ 密钥一律支持环境变量覆盖，且仓库里绝不能有真值 ★★
 * <p>
 * 支付宝私钥一旦泄露，任何人都能以本商户身份发起退款。所以：
 * <ul>
 *   <li>{@code app.pay.alipay.*} 在 yml 里**没有默认值**，只认环境变量；</li>
 *   <li>没配置时 {@code AlipaySandboxPayChannel.available()} 返回 false ——
 *       这条渠道沉默地消失，而不是让启动失败或者让用户点到才报错。</li>
 * </ul>
 *
 * @see com.campus.market.service.pay.PayChannelRegistry
 */
@Getter
@Component
public class PayProperties {

    /* ==================================================================
     * 渠道开关
     * ================================================================== */

    /**
     * 允许使用的渠道编码，逗号分隔。
     * <p>
     * ★ 默认值刻意包含 {@code demo}：本地开发与课堂演示要用它 ★
     * <p>
     * 但 {@code demo} 渠道等于「不付钱也能把订单推进到待发货」——
     * 它在生产环境是一条**白拿商品**的后门。所以：
     * <ul>
     *   <li>{@code application-prod.yml} 把默认值收紧成 {@code wallet}；</li>
     *   <li>{@code DemoPayChannel.available()} 在 prod profile 下**无条件**返回 false，
     *       即使有人显式把它写进环境变量也算不数（失败关闭，而不是信任配置）。</li>
     * </ul>
     */
    @Value("${app.pay.enabled-channels:wallet,demo}")
    private String enabledChannels;

    /* ==================================================================
     * 订单支付时限与超时关单
     * ================================================================== */

    /**
     * 下单后多少分钟内必须完成支付，超时自动关单并回补库存。
     * <p>
     * ★ 这个值必须落进 {@code t_order.pay_expire_at}，不能每次现场算 ★
     * 见 {@code Order#getPayExpireAt()}：现场算会让「改配置」把存量订单的
     * 截止时间一起改掉，判定口径随配置漂移。
     */
    @Value("${app.pay.order-timeout-minutes:1440}")
    private int orderTimeoutMinutes;

    /**
     * ★ 超时关单的周期与开关**刻意不放在本类** ★
     * <p>
     * 周期由 {@code PaymentTimeoutJob} 上的 {@code @Scheduled("${app.pay.close-cron:…}")}
     * 直接消费；开关由同处的 {@code @ConditionalOnProperty} 消费 ——
     * 关掉时那个 Bean 根本不创建、连 {@code @Scheduled} 都不注册。
     * <p>
     * 这里曾经有一个 {@code closeCron} 字段，但它**从来没有被读过**（真正的值取自
     * 那个 {@code @Scheduled} 占位符），于是同一个 key 在代码里出现了两处声明、
     * 只有一处生效 —— 谁照着这个字段去改、或者照着它去改另一处，都会以为改对了。
     * 这正是本项目反复在修的**死配置**形态，所以字段被删掉而不是留着「备用」：
     * 一个概念只能有一个消费点。
     */
    // （无字段：见上）

    /** 一次关单最多处理多少笔（防止某次积压把事务拖成超长事务） */
    @Value("${app.pay.close-batch-size:200}")
    private int closeBatchSize;

    /* ==================================================================
     * 回调丢失后的主动对账（PaymentReconcileJob）
     * ================================================================== */

    /**
     * 一次对账最多问渠道多少笔。
     * <p>
     * ★ 这个上限不是「性能优化」，是**对渠道的礼貌**★
     * 每一次对账都是一次真实的出站请求。若某次积压（比如渠道回调地址挂了两小时）
     * 留下几百笔待确认支付单，不限量会在下一轮把几百个请求同时打给支付宝，
     * 轻则限流、重则触发风控 —— 而对账这件事，晚几分钟完全无害。
     */
    @Value("${app.pay.reconcile-batch-size:100}")
    private int reconcileBatchSize;

    /**
     * 支付单建出来多久之后才允许被对账问到（分钟）。
     * <p>
     * ★★ 这个「宽限期」防的是**自问自答式的误判**★★
     * 用户刚点「去支付」、人正站在收银台前输入密码，此时支付单是 {@code paying}、
     * 渠道侧是 {@code WAIT_BUYER_PAY}。如果对账立刻去问，问到的必然是「还没成」——
     * 虽然本项目的对账在 {@code NOT_PAID} 上什么都不做（见 {@code PaymentService#reconcileOne}），
     * 但那意味着**每一笔正常支付都要先白白挨一次查单**，把「用户在付款」误当成
     * 「回调可能丢了」来排查。
     * <p>
     * 所以给一个下限：只有建单超过这个时长的支付单才值得怀疑。默认 2 分钟 ——
     * 真实回调通常在秒级到达，2 分钟足够把它和「回调丢了」区分开。
     */
    @Value("${app.pay.reconcile-grace-minutes:2}")
    private int reconcileGraceMinutes;

    /**
     * 支付单**被关掉之后**，还继续对它问渠道多久（分钟）。
     * <p>
     * ★★★ 这个窗口补的是「钱在最后两分钟到了、通知始终不来」这个真空期 ★★★
     * <p>
     * 支付单的生命周期里有一段**两个任务都不管**的时间，而它恰好落在钱最容易出问题的地方：
     * <pre>
     *   …… 用户付款（比如到期前 90 秒） ──► expire_at 到点 ──► 超时关单任务把它写成 closed
     *        ▲                        ▲                                ▲
     *        │                        │                                │
     *     对账在问这里              对账从这里就**不再问**了          对账依然不问（closed 不是候选）
     * </pre>
     * 于是：通知丢了 + 用户在最后两分钟付款 ⇒ 这一笔落在 {@code closed} 上，
     * 而 {@code closed} 既不是「未过期候选」，也不是任何人的待办。
     * 钱在渠道手上，订单已作废，且**没有任何代码会去退它** —— 一笔无痕的进账。
     * <p>
     * 所以对账要往回多看一段：{@code status = 'closed'} 且
     * {@code update_time >= now - 本值} 的支付单一并拿去问渠道。
     * 渠道确认收款的，走的是与回调同一个 {@code settle}；订单已作废时，
     * {@code settle} 里既有的自动原路退回会接管，钱回到用户手里且有完整痕迹。
     * <p>
     * ★ 默认 10 分钟这个数字是怎么来的 ★
     * <ul>
     *   <li><b>必须大于关单周期（5 分钟）</b>：关单任务每 5 分钟一轮，一笔支付单
     *       可能在过期后第 4 分 59 秒才被写成 {@code closed}；窗口若比关单周期短，
     *       就会出现「刚关掉就已经出窗」的候选 —— 等同于没补；</li>
     *   <li><b>要留出重试余量</b>：查单会因为网关抖动/限流而「问不到」（本项目真机
     *       实测过沙箱网关约 1/12 概率返回 404）。对账每 2 分钟一轮，10 分钟约等于
     *       <b>5 次机会</b>，足够扛过偶发失败，又不至于对渠道长时间纠缠；</li>
     *   <li><b>不必更长</b>：支付宝的异步通知会按 4m/10m/10m/1h/2h/6h/15h 一直重推，
     *       超过这个窗口之后仍有回调兜着。窗口的作用是「别让钱只依赖那条不保证到达的通知」，
     *       不是为了替代它。</li>
     * </ul>
     * <p>
     * ★ 与 {@link #reconcileGraceMinutes} 的区别（两个值方向相反，别搞混）★
     * 宽限期是「<b>太新的不问</b>」（避免把用户正在付款当成回调丢了）；
     * 回看窗口是「<b>太旧的也问</b>」（避免关单后那段真空期没人管）。
     * 一个管下界，一个管上界，共同把「值得问」的时间区间框出来。
     */
    @Value("${app.pay.reconcile-lookback-minutes:10}")
    private int reconcileLookbackMinutes;

    /* ==================================================================
     * 回调地址
     * ================================================================== */

    /**
     * 外部可访问的站点根地址，用于拼出异步通知地址与支付完成后的跳回地址。
     * <p>
     * ★ 必须是渠道服务器能访问到的公网地址 ★
     * <p>
     * 回调地址填 {@code http://localhost:8080} 时，支付宝的服务器打到的是它自己机器上的
     * 8080 端口 —— 回调永远进不来，而**本地日志里什么都不会有**，
     * 排查时最容易误判成「验签失败」或「回调逻辑没写对」。
     * 所以这个值在 prod 下必须显式配置，且部署文档里单独强调
     * （见 {@code deploy/env.example} 的 {@code APP_PAY_PUBLIC_BASE_URL}）。
     * <p>
     * ★★ 变量名必须带 {@code APP_} 前缀 ★★
     * <p>
     * {@code app.pay.*} 在 yml 里**没有占位符**，只靠 Spring Boot 的 relaxed binding
     * 从环境变量绑定：{@code app.pay.public-base-url} ←→ {@code APP_PAY_PUBLIC_BASE_URL}。
     * 少了 {@code APP_}（写成 {@code PAY_PUBLIC_BASE_URL}）**不会报错，只是绑不上** ——
     * 值保持空 ⇒ {@link #notifyUrl(String)} 返回 null ⇒ 渠道 {@code available()} 为 false
     * ⇒ **从收银台静默消失**。真机对照见 {@code .workbuddy/e2e-pay-env.mjs}。
     */
    @Value("${app.pay.public-base-url:}")
    private String publicBaseUrl;

    /** 异步通知路径（拼在 public-base-url 之后） */
    @Value("${app.pay.notify-path:/api/pay/notify}")
    private String notifyPath;

    /** 支付完成后浏览器跳回的前端地址；留空则不传 return_url（用户停在支付宝的结果页） */
    @Value("${app.pay.return-url:}")
    private String returnUrl;

    /* ==================================================================
     * 支付宝沙箱
     * ================================================================== */

    /** 沙箱应用 appid */
    @Value("${app.pay.alipay.app-id:}")
    private String alipayAppId;

    /** 应用私钥（RSA2 / PKCS8）。支持带 PEM 头尾，也支持用 {@code \n} 表示换行 */
    @Value("${app.pay.alipay.private-key:}")
    private String alipayPrivateKey;

    /** 支付宝公钥（RSA2）。**用来验签回调**，与上面的应用私钥不是一对 */
    @Value("${app.pay.alipay.public-key:}")
    private String alipayPublicKey;

    /**
     * 网关地址。沙箱与生产的地址**不同**，默认给沙箱：
     * 生产是 {@code https://openapi.alipay.com/gateway.do}。
     * <p>
     * 默认值给沙箱是刻意的：万一有人忘了配，打到的也是沙箱而不是真实资金通道。
     */
    @Value("${app.pay.alipay.gateway:https://openapi.alipaydev.com/gateway.do}")
    private String alipayGateway;

    /** 签名算法，固定 RSA2（RSA-SHA256）。支付宝已不支持 RSA1 新接入 */
    @Value("${app.pay.alipay.sign-type:RSA2}")
    private String alipaySignType;

    /* ==================================================================
     * 派生
     * ================================================================== */

    /** 允许的渠道集合（去重、去空白、全小写） */
    public Set<String> enabledChannelSet() {
        Set<String> out = new LinkedHashSet<>();
        if (enabledChannels == null) {
            return out;
        }
        Arrays.stream(enabledChannels.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(s -> s.toLowerCase(java.util.Locale.ROOT))
                .forEach(out::add);
        return out;
    }

    /** 某条渠道是否被允许启用 */
    public boolean channelEnabled(String code) {
        return code != null && enabledChannelSet().contains(code.toLowerCase(java.util.Locale.ROOT));
    }

    /**
     * 某条渠道的异步通知完整地址。
     * <p>
     * ★★ 必须把渠道代码拼进去 ★★
     * 控制器的映射是 {@code POST /pay/notify/{channel}} —— 渠道名是路径的**最后一段**，
     * 不是查询参数。只拼到 {@code /api/pay/notify} 的话，渠道服务器回调的是一个**不存在**的地址。
     * <p>
     * 这个错误的隐蔽程度极高：
     * <ul>
     *   <li>本项目的 {@code NoResourceFoundException} 也被兜成 HTTP 200 ⇒ 渠道看到的是
     *       「200 但响应体不是 success」，于是**按失败处理、持续重推约 15 小时**；</li>
     *   <li>而本地日志里只有一条 WARN 都没有 —— 因为请求压根没进到业务代码；</li>
     *   <li>用户侧的表现是「钱付了、订单永远停在待付款」，正是 {@code available()} 注释里
     *       点名要避免的那种半可用状态。</li>
     * </ul>
     * 所以这里**不做**「拼前缀」和「拼完整路径」两个方法 —— 一个概念两个入口迟早被用错，
     * 只留这一个必须传渠道的签名，漏传就编译不过。
     *
     * @param channel 渠道代码（如 {@code alipay_sandbox}），必须与控制器路径变量一致
     * @return 配置了 {@code public-base-url} 时返回完整地址，否则返回 null
     *         （渠道实现要据此决定「不传 notify_url」还是传一个假的 —— 都不该做，
     *         正确做法是渠道直接判定不可用，见 {@code AlipaySandboxPayChannel.available()}）
     */
    public String notifyUrl(String channel) {
        if (publicBaseUrl == null || publicBaseUrl.isBlank()) {
            return null;
        }
        String base = publicBaseUrl.endsWith("/")
                ? publicBaseUrl.substring(0, publicBaseUrl.length() - 1)
                : publicBaseUrl;
        String path = notifyPath == null ? "" : notifyPath;
        while (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        return base + path + "/" + channel;
    }

    /**
     * 支付时限（支付宝 {@code timeout_express} 的写法）。
     * <p>
     * ★ 这个字段必须传给渠道，否则两侧的倒计时会不一致 ★
     * 我们自己在 {@code pay_expire_at} 到点关单，支付宝也在它自己的时限到点关交易。
     * 若不显式告诉支付宝我们的时限，它默认给 15 天 —— 于是出现：
     * 「我们 24 小时就把订单关了，用户第 3 天在支付宝里还能付款」。
     * 钱收了、订单已作废，只能走自动退回；用户看到的是「付完款订单没了」。
     * 所以这里把同一个 {@code order-timeout-minutes} 翻译成渠道的写法传下去，
     * 让两侧的截止时间**由同一个配置决定**。
     * <p>
     * 单位换算刻意选「能整除的最大单位」：{@code 1440 → 1d}、{@code 90 → 90m}。
     * 支付宝接受 {@code 15d} 这样的值，但对超大分钟数的解析没有明确保证，
     * 用它自己文档里的示例单位最稳。
     */
    /**
     * 支付时限的**分钟口径**（与 {@link #timeoutExpress()} 同一来源，避免两处各解析一遍）。
     * <p>
     * 之所以单独暴露：渠道侧有**环境上限**要判断（沙箱 15 小时），
     * 若渠道自己去解析 {@code "1d"} 这种字面量，就成了「一个概念两个解析器」。
     */
    public int timeoutExpressMinutes() {
        return orderTimeoutMinutes > 0 ? orderTimeoutMinutes : 1440;
    }

    public String timeoutExpress() {
        /*
         * ≤0 一律退回默认 1440（24 小时），而不是取 1 分钟。
         * 「支付时限」这个概念里 0 不代表"不限" —— 它代表订单一下单就过期。
         * 配置写错一个 0 就让全站订单秒过期，比默认值宽松一点危险得多。
         */
        int m = timeoutExpressMinutes();
        if (m >= 1440 && m % 1440 == 0) {
            return (m / 1440) + "d";
        }
        if (m >= 60 && m % 60 == 0) {
            return (m / 60) + "h";
        }
        return m + "m";
    }
}
