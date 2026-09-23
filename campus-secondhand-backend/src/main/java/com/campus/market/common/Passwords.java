package com.campus.market.common;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.util.regex.Pattern;

/**
 * 密码哈希工具（BCrypt）
 * <p>
 * ★ 为什么要有这个类 ★
 * <p>
 * 之前 {@code t_user.password} 是**明文**存的：登录直接
 * {@code user.getPassword().equals(password)}，注册直接写原串。
 * 只要有人能看到数据库（导出的 sql、截图、连库权限），所有账号的密码
 * 立刻就是可用的 —— 而且因为是同一个人在不同站点复用同一密码，
 * 危害会外溢。种子账号 admin/admin123 更是写死在 schema.sql 里。
 * <p>
 * ★ 兼容策略（关键）★
 * <p>
 * 直接改成「只认哈希」会让**已经建好的库全部登不进去**（老库里躺的是明文），
 * 演示前还得重新导入数据，风险太高。所以这里走双模式：
 * <ul>
 *   <li>口令以 {@code $2a$/$2b$/$2y$} 开头 → 按 BCrypt 校验；</li>
 *   <li>否则按历史明文比对，**校验通过后由调用方顺手升级成哈希**（见 UserService#login）。</li>
 * </ul>
 * 这样：新注册、重置密码、以及任何老账号登录一次之后，库里都不再是明文，
 * 而 schema.sql 的种子账号 admin/admin123 依然能直接登录，演示流程零改动。
 */
public final class Passwords {

    /** 与 Spring Security 默认强度一致（10 轮），单次校验约几十毫秒 */
    private static final BCryptPasswordEncoder ENCODER = new BCryptPasswordEncoder();

    /** BCrypt 输出形如 $2a$10$...；带版本前缀便于识别历史明文 */
    private static final Pattern BCRYPT = Pattern.compile("^\\$2[aby]?\\$\\d{2}\\$[./A-Za-z0-9]{53}$");

    private Passwords() {
    }

    /** 生成哈希（注册 / 重置密码 / 改密都用它） */
    public static String encode(String raw) {
        if (raw == null) throw BusinessException.paramError("密码不能为空");
        return ENCODER.encode(raw);
    }

    /** 是否已经是哈希（用于判断要不要升级） */
    public static boolean isHashed(String stored) {
        return stored != null && BCRYPT.matcher(stored).matches();
    }

    /**
     * 校验口令。
     * <p>
     * 注意这里的 null 保护：老数据里 password 列可能为空，
     * 原先直接 {@code user.getPassword().equals(password)} 会 NPE 打到 500。
     */
    public static boolean matches(String raw, String stored) {
        if (raw == null || stored == null || stored.isEmpty()) return false;
        if (isHashed(stored)) return ENCODER.matches(raw, stored);
        // 历史明文：定长比较意义不大（库里就是明文），保持与旧行为一致
        return stored.equals(raw);
    }
}
