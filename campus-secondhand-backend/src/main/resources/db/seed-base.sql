-- ====================================================================
-- 校园二手集市 - 基础种子数据（幂等）
-- ====================================================================
-- 用途：由 application.yml 的 `spring.sql.init.data-locations` 在
--       schema-auto.sql 建表之后自动执行 —— 新环境启动即可登录，不必手敲 mysql。
--
-- ★ 幂等口径：**表为空才灌**，不是「逐行跳过已存在的」★
--   为什么不用 INSERT IGNORE：那要求每张表都有唯一键。实测只有
--     t_user(username UNIQUE) / t_category(uk_category_name) 有，
--     而 t_settings、t_notice 只有自增主键 —— INSERT IGNORE 对它们完全失效，
--     每次启动都会再灌一份，公告和系统设置会越滚越多。
--   所以统一用「先问这张表是不是空的，空才整表灌入」：
--       SET @need = (SELECT COUNT(*) = 0 FROM t);
--       INSERT INTO t (...) SELECT ... FROM (...) s WHERE @need;
--   这张表已经有数据（哪怕只有一行、且不是我们灌的），就一行都不插。
--
-- ★ 为什么不能直接自动执行 schema.sql ★
--   schema.sql 是重建型脚本（17 张表全是 DROP + CREATE），配到启动流程里
--   等于每次启动清空全库。结构部分见 schema-auto.sql 的说明。
--
-- ★ 与 schema.sql 的关系 ★
--   本文件的每一行数据都必须与 schema.sql「初始数据」段保持一致；
--   向 schema.sql 新增种子用户/分类/公告时，必须同步加到这里。
--   校验：node .workbuddy/gen-schema-auto.mjs --check —— 会逐条比对种子覆盖度。
--
-- 执行顺序：schema-auto.sql（建表）→ 本文件（种子）→ demo profile 的演示数据
-- ====================================================================


-- ==================== ① 用户 ====================
-- 密码一律存 BCrypt 哈希（$2a$10$...），禁止再写入明文。
--   对应明文：admin/admin123、goods_admin/goods123456、report_admin/report123456，
--   zhangsan / lisi / wangwu 均为 123456。
--   UserService 保留「明文兼容」分支用于历史数据平滑升级，但种子必须是哈希形态，
--   否则新部署的环境里密码就是明文，一拖库即泄露。
--
-- ★ 在线状态种子的用意 ★
--   用 NOW() 相对量而不是写死时刻：装库那一刻就有一批「刚活跃过」的用户，
--   新环境首次启动就能在消息页/商品卡片看到在线标识，不用等谁去登录一次。
--   ⚠️ 但 NOW() 只定格在「装库那一刻」。若几天后才演示，这些时间戳全部过期、
--      会变成一片离线（看着像功能坏了）→ 演示前跑一次 db/demo-online-seed.sql 刷新。
--   lisi 刻意设成「活跃但隐藏」（5 分钟前活跃过、show_online = 0）：
--      这是隐私开关唯一能被肉眼验证的形态 —— 他明明刚用过，别人看他却是离线。
SET @need_seed_user = (SELECT COUNT(*) = 0 FROM t_user);

INSERT INTO t_user (username, password, nickname, avatar, role, status, last_active_at, show_online)
SELECT * FROM (
              SELECT 'admin'        AS username,
                     '$2a$10$N21sdzxwdEGjNJcqCf.FNufP3lm1M/okNTxUV0PRKh1utbjGQ9koy' AS password,
                     '系统管理员'    AS nickname,
                     'https://api.dicebear.com/7.x/initials/svg?seed=admin' AS avatar,
                     'admin'        AS role,
                     'active'       AS status,
                     NOW() - INTERVAL 1 MINUTE AS last_active_at,
                     1              AS show_online
    UNION ALL SELECT 'goods_admin',  '$2a$10$XiYaVMKAe2m5NzuRTqgP3.iDjyMszKCKDH03K0RFeFV90fzPM78jO', '商品审核员', 'https://api.dicebear.com/7.x/initials/svg?seed=GA', 'goods_admin',  'active', NOW() - INTERVAL 2 MINUTE, 1
    UNION ALL SELECT 'report_admin', '$2a$10$0njqX4VbjzpAKqr7QTdsg.tlwkCb7PJxlAM1vpI5fxn3GuenjTaGO', '举报审核员', 'https://api.dicebear.com/7.x/initials/svg?seed=RA', 'report_admin', 'active', NOW() - INTERVAL 2 DAY,    1
    UNION ALL SELECT 'zhangsan',     '$2a$10$zFHnHBp8EoIXkBq7K3g0Ou.L.LQwn171/4CJsxtKtigsPx1gwbs4e', '计算机小张', 'https://api.dicebear.com/7.x/initials/svg?seed=zs', 'user',         'active', NOW() - INTERVAL 3 MINUTE, 1
    UNION ALL SELECT 'lisi',         '$2a$10$NIA5WzTZ7kHHDCeYDTM89ek/ZQsGRLNpKBwt57uYLnYllJj9nlcc.', '图书小李',   'https://api.dicebear.com/7.x/initials/svg?seed=ls', 'user',         'active', NOW() - INTERVAL 5 MINUTE, 0
    UNION ALL SELECT 'wangwu',       '$2a$10$yRzU8mDvyqzlVmxZ0E3aTOC.lm1kL.Hj0wxojwNXf4BTFUsb3vysm', '数码小王',   'https://api.dicebear.com/7.x/initials/svg?seed=ww', 'user',         'active', NOW() - INTERVAL 1 DAY,    1
) AS seed_user
WHERE @need_seed_user;


-- ==================== ② 商品分类 ====================
-- ★ id 1..8 的语义不能变（1 教材 / 2 数码 / 3 代步 / 4 服饰 / 5 生活 / 6 运动 / 7 家电 / 8 艺术）★
-- 前端把 24 张实拍图按分类 id 组织在 public/goods/cat{1..8}-{1..3}.jpg，
-- 封面渐变配色、运营看板分类占比饼图也都按这 8 个分类设计。
-- 曾经这里写的是「教材书籍/数码电子/…」，与前端错位后出现「乐器分类下显示家电照片」。
-- id 9「其他」是兜底分类：发布页需要「什么都不像」时的落点，且饼图本来就含「其他」一项。
SET @need_seed_category = (SELECT COUNT(*) = 0 FROM t_category);

INSERT INTO t_category (name, icon)
SELECT * FROM (
              SELECT '教材' AS name, '📚' AS icon
    UNION ALL SELECT '数码', '🎮'
    UNION ALL SELECT '代步', '🚲'
    UNION ALL SELECT '服饰', '👕'
    UNION ALL SELECT '生活', '🪑'
    UNION ALL SELECT '运动', '🏀'
    UNION ALL SELECT '家电', '🍳'
    UNION ALL SELECT '艺术', '🎨'
    UNION ALL SELECT '其他', '📦'
) AS seed_category
WHERE @need_seed_category;


-- ==================== ③ 系统设置 ====================
-- t_settings 是「单行配置表」：整表为空才灌，避免出现两行配置让后台读到哪行看运气。
SET @need_seed_settings = (SELECT COUNT(*) = 0 FROM t_settings);

INSERT INTO t_settings (site_name, service_phone, announce_text, goods_audit_required,
                        max_publish_per_day, auto_offline_days, report_auto_hide, commission_rate)
SELECT * FROM (
              SELECT '校园二手集市' AS site_name,
                     '400-000-0000'  AS service_phone,
                     '欢迎使用校园二手集市，请诚信交易！' AS announce_text,
                     1        AS goods_audit_required,
                     10       AS max_publish_per_day,
                     30       AS auto_offline_days,
                     0        AS report_auto_hide,
                     0.0000   AS commission_rate
) AS seed_settings
WHERE @need_seed_settings;


-- ==================== ④ 平台公告 ====================
-- t_notice 无唯一键（自增主键），所以同样走「表空才灌」。
SET @need_seed_notice = (SELECT COUNT(*) = 0 FROM t_notice);

INSERT INTO t_notice (title, content, pinned)
SELECT * FROM (
              SELECT '欢迎使用校园二手集市' AS title,
                     '本平台仅供校园内部二手交易使用，请同学们诚信交易，注意安全。' AS content,
                     1 AS pinned
    UNION ALL SELECT '交易安全提示',
                     '请尽量选择校内面交，避免线上先付款后发货的交易方式。',
                     0
) AS seed_notice
WHERE @need_seed_notice;


-- ==================== ⑤ 限时活动 ====================
-- 这里**刻意不灌**：t_activity 由 ActivityService.seedIfEmpty() 在查询入口惰性补种。
-- 为什么交给 Java 而不是 SQL：活动的 start_at / duration_days 要与服务端时钟对齐，
-- 补种逻辑里还要写 highlights / claims 两段 JSON 与 fund_source 口径，
-- 用 SQL 重写一份等于把同一套规则维护两遍，改一处忘一处就会让新库的活动与老库不一样。
-- 惰性补种在「表为空」时触发，与本文件的口径一致。


-- ==================== ⑥ 钱包初始余额 ====================
-- ★ 为什么新环境必须给用户一点余额 ★
--
-- 「钱包支付」是本项目三条支付渠道里唯一**钱真的动**的那条：余额被原子扣减、
-- 流水被落库、退款时会原路加回。余额默认 0 时，新装的环境里点「余额支付」永远只能
-- 看到「余额不足」——一条能跑通、却被初始数据堵死的功能，看起来和没做一样。
--
-- ★ 余额与流水必须同时给 ★
-- 只写 t_user.balance 会出现「余额 500，但流水表一条都没有」——
-- 钱凭空出现，对账时无法解释，正好违背了本次改造要建立的不变式
-- （余额 = 流水之和）。所以两件事一起做。
--
-- ★ 幂等口径与上面一致：t_wallet_log 为空才灌 ★
-- 不能按「balance = 0 就重置」来判断：用户在界面上把钱花光后重启服务，
-- 余额会被悄悄变回 500（凭空造钱）。空流水表是新库唯一可靠的标志。
SET @need_seed_wallet = (SELECT COUNT(*) = 0 FROM t_wallet_log);

UPDATE t_user SET balance = 500.00
WHERE username IN ('zhangsan', 'lisi', 'wangwu') AND @need_seed_wallet;

INSERT INTO t_wallet_log (user_id, amount, balance_after, type, biz_id, remark)
SELECT u.id, 500.00, 500.00, 'recharge', NULL, '演示初始余额（校园币）'
FROM t_user u
WHERE u.username IN ('zhangsan', 'lisi', 'wangwu') AND @need_seed_wallet;


-- ==================== 复核输出 ====================
-- 启动日志里能看到这段结果，一眼确认种子是否就位（手动执行时也一样）。
SELECT '基础种子复核' AS 项目,
       (SELECT COUNT(*) FROM t_user)     AS 用户数,
       (SELECT COUNT(*) FROM t_category) AS 分类数,
       (SELECT COUNT(*) FROM t_settings) AS 设置行数,
       (SELECT COUNT(*) FROM t_notice)   AS 公告数,
       (SELECT COALESCE(SUM(balance), 0) FROM t_user) AS 钱包余额合计;
