package com.campus.market.service.pay;

import com.campus.market.common.BusinessException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 支付渠道注册表：按 {@link PayChannel#code()} 索引全部渠道，并负责「可用性」判定。
 * <p>
 * ★★ 为什么要有这一层，而不是让 Service 直接注入 {@code List<PayChannel>} ★★
 * <p>
 * 三个地方都要问「有哪些渠道」，而且问的是**同一件事**：
 * <ul>
 *   <li>收银台：要列出用户可选的渠道（只看可用的）；</li>
 *   <li>发起支付：要把 code 换成渠道实例（不可用的必须拒绝）；</li>
 *   <li>退款：要按支付单上记录的历史 code 找回当时那条渠道
 *       （**这里必须允许"现在不可用"** —— 见 {@link #find}）。</li>
 * </ul>
 * 如果让每个调用方各自遍历 {@code List<PayChannel>} 自己过滤，三处的口径迟早漂移，
 * 最典型的后果是「收银台显示了某渠道，点下去却报不支持」。
 * <p>
 * ★★ code 重复 = 启动失败 ★★
 * <p>
 * 两条渠道用同一个 code 时，{@code Map.put} 会**静默覆盖**后者：
 * 收银台列一个、实际用的可能是另一个，而且一点错都不报。
 * 所以这里在构造时就断死 —— 配置/代码错误必须响亮地失败。
 */
@Slf4j
@Component
public class PayChannelRegistry {

    /** code → 渠道。用 LinkedHashMap 保持注入顺序，收银台列表的顺序才是稳定的 */
    private final Map<String, PayChannel> byCode = new LinkedHashMap<>();

    public PayChannelRegistry(List<PayChannel> channels) {
        for (PayChannel ch : channels) {
            PayChannel existed = byCode.put(ch.code(), ch);
            if (existed != null) {
                throw new IllegalStateException("支付渠道 code 重复：" + ch.code()
                        + "（" + existed.getClass().getSimpleName() + " 与 "
                        + ch.getClass().getSimpleName() + "）—— code 会落进 t_payment.channel，"
                        + "重复会导致「收银台显示一条、实际结算走另一条」，必须唯一");
            }
        }
        if (byCode.isEmpty()) {
            // 一条渠道都没有 = 整站无法支付。这属于装配错误，不该等到用户点付款才发现
            throw new IllegalStateException("没有任何支付渠道 Bean 被注册，请检查 service.pay 包下的实现类");
        }
        log.info("[pay] channels registered: {}", byCode.keySet());
    }

    /** 全部渠道（含当前不可用的），按注入顺序 */
    public List<PayChannel> all() {
        return new ArrayList<>(byCode.values());
    }

    /**
     * 当前**可用**的渠道 —— 收银台据此渲染选项。
     * <p>
     * 只保留 {@link PayChannel#available()} 为 true 的：未配置密钥的支付宝沙箱、
     * 未启用的演示渠道都不该出现在用户面前。
     */
    public List<PayChannel> available() {
        List<PayChannel> out = new ArrayList<>();
        for (PayChannel ch : byCode.values()) {
            if (ch.available()) {
                out.add(ch);
            }
        }
        return out;
    }

    /**
     * 取渠道，不可用则拒绝。
     * <p>
     * 用于**发起支付**：用户点了某条渠道，而它此刻不可用 —— 必须当场给出明确提示，
     * 而不是建一张永远不会有结果的支付单。
     *
     * @throws BusinessException 渠道不存在或被禁用（1001，业务规则拒绝）
     */
    public PayChannel require(String code) {
        PayChannel ch = byCode.get(code);
        if (ch == null) {
            throw BusinessException.of("不支持的支付方式：" + code);
        }
        if (!ch.available()) {
            throw BusinessException.of("支付方式「" + ch.label() + "」当前不可用，请换一种方式");
        }
        return ch;
    }

    /**
     * 按 code 找渠道，**不管它现在可不可用**。
     * <p>
     * ★ 退款链路必须走这个方法，不能走 {@link #require} ★
     * <p>
     * 场景很现实：用户昨天用支付宝沙箱付了款，今天管理员把沙箱密钥从配置里删了
     * （或者临时关闭了这条渠道）。退款时若走 {@code require}，会直接报
     * 「支付方式当前不可用」—— 而**钱明明收在支付宝那边**，必须退回去。
     * 此时正确行为是尝试退款，让渠道（或缺失的密钥）自己报错，
     * 而不是在本地就把这条路堵死。「能不能退」由渠道的失败信息回答，
     * 而不是由「这个渠道现在开没开」回答。
     *
     * @return 渠道；{@code code} 为空或找不到时返回 null（历史数据可能的形态）
     */
    public PayChannel find(String code) {
        return code == null ? null : byCode.get(code);
    }
}
