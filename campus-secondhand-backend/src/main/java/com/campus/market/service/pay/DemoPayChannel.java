package com.campus.market.service.pay;

import com.campus.market.config.PayProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 演示渠道：不产生任何真实资金往来，直接判定支付成功。
 * <p>
 * ★★ 它为什么必须存在（而不是"反正有钱包了，删掉"）★★
 * <p>
 * 课堂演示/评审现场不可能让老师真的去注册支付宝沙箱、拿密钥、扫码付款。
 * 但演示要展示的**不是付钱**，而是付款之后的那一整条链路：
 * 订单怎么从待付款变成待发货、支付记录长什么样、超时怎么关单、退款怎么走。
 * 这些都不需要真钱。演示渠道让这些在 3 秒内跑完。
 * <p>
 * ★★ 它同时是一把「白拿商品」的后门 —— 所以有两道锁 ★★
 * <ol>
 *   <li>{@link PayProperties#channelEnabled} 必须显式包含 {@code demo}
 *       （默认包含，但 {@code application-prod.yml} 把默认值收紧成了只有 {@code wallet}）；</li>
 *   <li>**prod profile 下无条件不可用**，哪怕有人在环境变量里把它写回来 ——
 *       见 {@link #available()}。这是"失败关闭"而不是"信任配置"：
 *       一条让订单无需付款即可推进的路径，绝不能只靠「部署时记得别开」来防。</li>
 * </ol>
 * <p>
 * ★ 它走的是**同一套**建单 → 结算 → 退款流程 ★
 * <p>
 * 唯一的差别是 {@link #create} 内部什么也不做、直接返回「已完成」。
 * 所以「演示跑得通」这件事是有意义的：它证明的是同一条路径，
 * 换的只是末端那一下。若演示渠道是一条专用假路径，它就什么都证明不了。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DemoPayChannel implements PayChannel {

    public static final String CODE = "demo";

    private final PayProperties props;
    private final Environment environment;

    @Override
    public String code() {
        return CODE;
    }

    @Override
    public String label() {
        return "演示渠道";
    }

    @Override
    public String hint() {
        return "课堂演示用：不产生真实资金往来，点击后直接完成支付";
    }

    @Override
    public boolean available() {
        if (!props.channelEnabled(CODE)) {
            return false;
        }
        /*
         * ★ 生产环境无条件关闭，且**不是静默关闭** ★
         *
         * 即使 APP_PAY_ENABLED_CHANNELS 里显式写了 demo 也一律不认 ——
         * 这条渠道等于「不付钱就把订单推进到待发货」，是资损级后门。
         * 打完 WARN 再返回 false，是为了让「我明明配了怎么没生效」能在启动日志里
         * 一眼看到原因，而不是又一次掉进「改了没反应、日志无痕迹」的坑。
         */
        if (environment.acceptsProfiles(Profiles.of("prod"))) {
            log.warn("[pay] demo channel is disabled under the 'prod' profile "
                    + "regardless of app.pay.enabled-channels "
                    + "(it lets orders advance without any payment)");
            return false;
        }
        return true;
    }

    /**
     * 「发起支付」= 什么也不做。
     * <p>
     * 返回 {@link CreateResult.Kind#DONE} 表示钱已经收了（同步渠道），
     * 调用方 {@code PaymentService} 会立即走结算流程 ——
     * 与钱包渠道返回 DONE 时走的是**同一段代码**。
     */
    @Override
    public CreateResult create(CreateContext ctx) {
        return CreateResult.done("演示渠道：已模拟支付成功");
    }

    /** 同步渠道，没有异步回调（回调接口会拒绝这个 code，避免凭空多出一个攻击面） */
    @Override
    public boolean asyncNotify() {
        return false;
    }

    @Override
    public NotifyResult parseNotify(Map<String, String> params) {
        // 不该被调用：asyncNotify() == false 时回调入口直接拒绝
        return NotifyResult.rejected("演示渠道不支持异步回调");
    }

    /**
     * 演示渠道「可退款」但**没有钱可退**。
     * <p>
     * 返回 true 是刻意的：演示里必须能完整走通「买家申请 → 管理员同意 → 订单关闭」
     * 这条售后链路，否则演示到一半会卡在「渠道不支持退款」。
     * 实现上只是如实说明「没有真实资金往来」，绝不假装退了一笔钱。
     */
    @Override
    public boolean refundable() {
        return true;
    }

    @Override
    public RefundResult refund(RefundContext ctx) {
        return RefundResult.ok(null,
                "演示渠道无真实资金往来，已在平台侧记录退款 ¥" + ctx.refundAmount());
    }
}
