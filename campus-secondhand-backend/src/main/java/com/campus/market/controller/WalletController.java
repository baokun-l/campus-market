package com.campus.market.controller;

import com.campus.market.common.BusinessException;
import com.campus.market.common.Result;
import com.campus.market.dto.WalletRechargeRequest;
import com.campus.market.dto.WalletRechargeResult;
import com.campus.market.dto.WalletSummary;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.service.WalletService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

/**
 * 校园钱包控制器：余额 / 流水查询，以及充值入金。
 * <p>
 * ★★ 为什么这两个接口**都**必须登录，且都不在白名单里 ★★
 * <p>
 * {@link AuthInterceptor} 的白名单是「默认拒绝、逐条放行」：不在
 * {@code PUBLIC_GET} / {@code PUBLIC_POST} / {@code PUBLIC_ANY} 里的路径一律要求有效凭证。
 * 本控制器的两个接口刻意什么都不加，于是天然需要登录 —— 这正是我们要的：
 * <ul>
 *   <li>{@code GET /wallet} —— 余额与流水是**私人财务数据**。放到白名单等于
 *       把「谁有多少钱、什么时候花的」公开给全网；</li>
 *   <li>{@code POST /wallet/recharge} —— 入金接口。它不鉴权就等于
 *       任何人都能给自己无限加钱。</li>
 * </ul>
 * 注意 {@code /wallet/**} 不在 {@code /admin/**} 的角色分区里，所以
 * {@code isRoleAllowed} 对任何**已登录**用户都返回 true —— 充值对全体用户开放，
 * 这是刻意的：管理员账号同样有余额、同样需要充值（他们此前余额恒为 0）。
 *
 * ★★ 充值接口的安全要点：金额与主体都不能来自请求体 ★★
 * <ul>
 *   <li><b>主体</b>取自 JWT（{@link AuthInterceptor#ATTR_USER_ID}），
 *       {@link WalletRechargeRequest} 里**没有** userId 字段。见该 record 的注释；</li>
 *   <li><b>金额</b>虽然必须由用户输入，但它的上下限、精度、以及"允不允许加"
 *       全部由 {@code WalletService} 在服务端重新判定 —— 前端 {@code el-input-number}
 *       的 min/max 只是体验层，绕过页面直接发请求就没了。</li>
 * </ul>
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class WalletController {

    private final WalletService walletService;

    /**
     * 钱包概览：当前余额 + 最近流水。
     * <p>
     * 收银台、设置页的钱包卡片都用它 —— 而不是复用 {@code GET /pay/channels}。
     * 后者为了渲染收银台，只能顺带回一个余额，且**只在钱包渠道可用时**才有值；
     * 拿它当"查余额"用，一旦钱包渠道在某个 profile 下被关掉，余额就查不到了。
     */
    @GetMapping("/wallet")
    public Result<WalletSummary> summary(HttpServletRequest request) {
        return Result.success(walletService.summary(currentUserId(request)));
    }

    /**
     * 校园币充值。
     * <p>
     * 请求体：{@code {"amount": 100.00, "requestId": "可选的幂等键"}}
     * <p>
     * {@code requestId} 允许省略（老客户端、脚本、Swagger 手工调都能用），
     * 但**前端必须带**：它是"用户连点两下不重复加钱"的唯一依据。
     * 见 {@code WalletService#recharge} 的幂等三层。
     */
    @PostMapping("/wallet/recharge")
    public Result<WalletRechargeResult> recharge(HttpServletRequest request,
                                                 @RequestBody(required = false) WalletRechargeRequest body) {
        Long userId = currentUserId(request);
        if (body == null || body.amount() == null) {
            /*
             * ★ 这里必须单独拦一次，而不是靠 Service 的「必须大于 0.01」★
             * Service 收到的是 normalize(null) = 0，报出来的是「充值金额必须大于 ¥0.01」——
             * 对一个**压根没填金额**的请求，这句话会让人以为是自己填错了数字。
             * 缺参数与参数越界是两件事，话术要分开。
             */
            throw BusinessException.paramError("请填写充值金额");
        }
        return Result.success(walletService.recharge(userId, body.amount(), body.requestId()));
    }

    /* ==================================================================
     * 内部工具
     * ================================================================== */

    /**
     * 取当前登录用户 id。
     * <p>
     * 与其它控制器同一写法：只认拦截器写进 request attribute 的值，**不读任何入参**。
     * 这个值来自 JWT 验签后的 subject，客户端伪造不了。
     * 返回 null 时由 {@code WalletService} 抛 401 —— 保留 null 而不是在这里抛，
     * 是为了让「未登录」这件事在所有钱包操作上有一处统一的判定与话术。
     */
    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }
}
