-- ====================================================================
-- 增量升级脚本：校园币充值能力（t_wallet_log 唯一索引）
-- ====================================================================
-- 适用对象：**已经建过库**的旧环境。
--   schema.sql     只对新库有效（DROP + CREATE）；
--   schema-auto.sql 全是 CREATE TABLE IF NOT EXISTS，对**已存在**的表整条跳过
--   ⇒ 它补得上新表，但补不了旧表的索引。所以老库升级必须跑本脚本。
--
-- 本次变更只有一条 DDL：给 t_wallet_log 加唯一索引 uk_wallet_type_biz (type, biz_id)。
--   ★ 它是充值幂等的**唯一硬保证**，不是可选的优化 ★
--   充值的业务层做了「先查后写」，但那只挡得住**顺序**重放（用户连点两下）。
--   两个真正并发的请求在业务层都查不到对方，会各自加一次钱 —— 用户余额凭空翻倍。
--   唯一索引把判定挪进数据库内部：写入即校验，没有竞争窗口，
--   后到的那一条插入失败 → 整个事务回滚 → 多加的钱被撤销。
--   没有这个索引，充值接口在并发下会**静默错账**（余额 ≠ 流水之和），
--   而错账是本项目唯一不能接受的结果。
--
-- 为什么键是 (type, biz_id) 而不是只有 biz_id：
--   支付与退款共用同一个支付单号作为 biz_id（type 分别是 pay / refund）。
--   单列唯一会让「退款」直接撞上「支付」那条记录，退款功能被挡死。
--
-- 为什么容忍 NULL（不加 NOT NULL）：
--   MySQL 的唯一索引允许多个 NULL。演示种子脚本（demo-wallet-seed.sql /
--   seed-base.sql）灌入的「演示初始余额」流水 biz_id 就是 NULL，
--   而且要求能**反复重灌**（先清后建的重置语义）——加 NOT NULL 会让它第二次就失败。
--
-- 幂等：重复执行不会报错、不会改数据 —— 每一步都先探测对象是否已存在。
-- 安全：加索引前会先体检「是否已存在重复的 (type, biz_id)」。
--       有重复就**不加索引并打印提示**，而不是让 ALTER 抛一个
--       看不懂的 Duplicate entry —— 那种报错会让人以为是脚本写错了。
--
-- 执行方式（在库外，非 mysql 客户端内的 SOURCE）：
--   mysql -uroot -p123456 campus_market < upgrade-wallet-recharge.sql
-- ====================================================================

USE campus_market;

-- ====================================================================
-- ① 前置体检：是否已存在重复的 (type, biz_id)
-- ====================================================================
-- 唯一索引加不上只有一个原因：存量数据里已经有重复行。
-- 先把它查出来，而不是等 ALTER 失败。biz_id IS NULL 的行要排除 ——
-- 它们在唯一索引里不算重复（MySQL 允许多个 NULL）。
SET @dup := (
    SELECT COUNT(*) FROM (
        SELECT type, biz_id
        FROM t_wallet_log
        WHERE biz_id IS NOT NULL
        GROUP BY type, biz_id
        HAVING COUNT(*) > 1
    ) AS d
);

SELECT @dup AS 重复组数,
       IF(@dup = 0,
          '体检通过：可以安全加唯一索引',
          '体检未通过：存在重复流水，请先排查上表') AS 体检结论;

-- ====================================================================
-- ② 加唯一索引（幂等：已存在则跳过）
-- ====================================================================
SET @has_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 't_wallet_log'
      AND INDEX_NAME = 'uk_wallet_type_biz'
);

SET @ddl := IF(
    @has_idx > 0,
    'SELECT ''[skip] uk_wallet_type_biz 已存在，无需变更'' AS notice',
    IF(
        @dup > 0,
        'SELECT ''[abort] 检测到重复的 (type, biz_id)，未加唯一索引。请先排查 t_wallet_log 中的重复流水'' AS notice',
        'ALTER TABLE t_wallet_log ADD UNIQUE KEY uk_wallet_type_biz (type, biz_id)'
    )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ====================================================================
-- ③ 验收：索引确实存在，且对账不变式仍然成立
-- ====================================================================
-- 期望看到一行：uk_wallet_type_biz，Non_unique = 0（0 表示唯一索引）。
SHOW INDEX FROM t_wallet_log WHERE Key_name = 'uk_wallet_type_biz';

-- 「余额 = 流水之和」是本次改造守住的核心不变式。
-- 加索引不该改变任何数据，所以这里应当**全部是 OK**。
-- 一旦出现 MISMATCH，说明存量库本来就有错账，与本脚本无关，
-- 但必须查清楚 —— 有错账的库上做充值，问题只会越滚越大。
SELECT u.id                       AS 用户ID,
       u.username                 AS 账号,
       u.balance                  AS 账面余额,
       IFNULL(SUM(w.amount), 0)   AS 流水之和,
       IF(u.balance = IFNULL(SUM(w.amount), 0), 'OK', 'MISMATCH') AS 对账
FROM t_user u
LEFT JOIN t_wallet_log w ON w.user_id = u.id
GROUP BY u.id, u.username, u.balance
ORDER BY u.id;
