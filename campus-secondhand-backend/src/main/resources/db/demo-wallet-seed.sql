-- ====================================================================
-- 演示数据 · 钱包余额（可选执行 / demo profile 自动执行）
-- ====================================================================
-- 用途：钱包支付是三条渠道里唯一「钱真的动」的那条 —— 余额被原子扣减、
--       流水落库、退款原路加回。但**演示库里的余额会被演示过程消耗掉**：
--       你点几次「余额支付」，三个演示账号就把 500 元花完了，
--       之后任何一次「余额支付」都只会提示余额不足，看起来像功能坏了。
--
--       本脚本把演示账号的余额与流水**重置到固定状态**，让演示态永远可复现。
--
-- 用法：
--   mysql -uroot -p123456 campus_market < demo-wallet-seed.sql
--   （demo profile 下由 spring.sql.init.data-locations 自动执行）
--
-- ★ 幂等口径：**先清后建**（重置型）★
--   与 demo-online-seed.sql / demo-data.sql 同一套语义：每次执行结果都一样。
--   为什么不能用「余额为 0 才充值」这种条件：演示到一半重启服务时，
--   恰好花光了余额的账号会被凭空充值 —— 与「重置到固定演示态」的意图不符。
--
-- ★ 为什么余额和流水必须一起重置 ★
--   只重置余额、不清流水，就会出现「余额 500，流水却有 800 元的支出记录」——
--   钱的来源与去向对不上。本次改造建立的不变式是 **余额 = 流水之和**，
--   演示数据同样必须满足它，否则第一次对账演示就会当场穿帮。
--
-- ★ 与 seed-base.sql 的关系 ★
--   新库由 seed-base.sql 的第 ⑥ 段灌入同样的 500 元初始余额；
--   本脚本面向的是「已经存在的演示库」，负责把它拉回同一个状态。
-- ====================================================================

-- ★★ 这里**绝不能**写 `USE campus_market;` ★★
--   同 demo-data.sql：库名应由调用方给定（命令行或 spring.datasource.url），
--   硬编码 USE 会在被自动初始化时把连接切到别的库上 —— 数据灌错库，且一句错都不报。

-- ---------- ① 清空钱包流水 ----------
-- 演示用户 = zhangsan(4) / lisi(5) / wangwu(6)，见 seed-base.sql。
-- 只清这三个人的流水，保留管理员与其它账号的记录（本脚本不该动它们）。
DELETE FROM t_wallet_log
WHERE user_id IN (SELECT id FROM t_user WHERE username IN ('zhangsan', 'lisi', 'wangwu'));

-- ---------- ② 余额归零后再充值 ----------
-- 先归零而不是直接 SET 500：否则「演示中赚到的钱」会累加在下一次重置上，
-- 500 变成 700、900…… 重置就不再是重置。
UPDATE t_user SET balance = 0
WHERE username IN ('zhangsan', 'lisi', 'wangwu');

UPDATE t_user SET balance = 500.00
WHERE username IN ('zhangsan', 'lisi', 'wangwu');

-- ---------- ③ 补上对应的充值流水 ----------
-- 有余额必须有账：这 500 元是「演示初始余额」，不是凭空出现的。
-- balance_after = 500.00 与上一步设置的余额一致，满足「余额 = 流水之和」。
INSERT INTO t_wallet_log (user_id, amount, balance_after, type, biz_id, remark)
SELECT u.id, 500.00, 500.00, 'recharge', NULL, '演示初始余额（校园币）'
FROM t_user u
WHERE u.username IN ('zhangsan', 'lisi', 'wangwu');

-- ---------- ④ 校验 ----------
-- 逐账号核对「余额 = 流水之和」，一眼确认不变式成立。
-- 这条查询同时也是「对账」这件事最小可用的形态：任何一笔金额与流水对不上，
-- 它就会在结果里露出来。
SELECT u.username                                  AS 账号,
       u.balance                                   AS 余额,
       IFNULL(SUM(w.amount), 0)                    AS 流水合计,
       IF(u.balance = IFNULL(SUM(w.amount), 0), 'OK', '不一致') AS 对账
FROM t_user u
LEFT JOIN t_wallet_log w ON w.user_id = u.id
WHERE u.username IN ('zhangsan', 'lisi', 'wangwu')
GROUP BY u.id, u.username, u.balance;
