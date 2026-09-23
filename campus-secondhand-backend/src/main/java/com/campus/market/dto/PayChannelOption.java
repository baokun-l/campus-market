package com.campus.market.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.math.BigDecimal;

/**
 * 收银台上的一个支付方式选项。
 * <p>
 * ★ 列表由**服务端**决定，而不是前端写死 ★
 * <p>
 * 支付宝沙箱在没配密钥时、演示渠道在生产环境下都不可用。若前端写死三个按钮，
 * 用户点下去才会收到「该支付方式当前不可用」—— 这是最差的交互，
 * 也让人误以为功能坏了。服务端只返回**当前真的能用**的渠道，
 * 前端照着渲染，永远不会出现点了才知道不能用的情况。
 *
 * @param code    渠道编码（wallet / demo / alipay_sandbox）
 * @param label   显示名
 * @param hint    一句说明（告诉用户下一步会发生什么）
 * @param balance 钱包渠道专用：当前余额。其它渠道为 null
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PayChannelOption(String code, String label, String hint, BigDecimal balance) {
}
