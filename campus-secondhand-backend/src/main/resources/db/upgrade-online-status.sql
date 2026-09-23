-- ====================================================================
-- 增量升级脚本：t_user 增加「在线状态」两列
-- ====================================================================
-- 适用对象：**已经建过库**的旧环境（schema.sql 只对新库有效，老库不会自动补列）。
-- 幂等：重复执行不会报错、不会覆盖已有数据 —— 用 information_schema 先探列是否已存在。
-- 执行方式（在库外，非 mysql 客户端内的 SOURCE）：
--   mysql -uroot -p123456 campus_market < upgrade-online-status.sql
-- ====================================================================

USE campus_market;

-- ---- ① last_active_at：最后活跃时间（在线判定的唯一依据） ----
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_user' AND COLUMN_NAME = 'last_active_at'
);
SET @ddl := IF(@has_col = 0,
    'ALTER TABLE t_user ADD COLUMN last_active_at DATETIME NULL COMMENT ''最后活跃时间（客户端心跳刷新，在线判定基准）'' AFTER token_version',
    'SELECT ''[skip] t_user.last_active_at 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- ② show_online：是否对外展示在线状态（隐私开关，默认展示） ----
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_user' AND COLUMN_NAME = 'show_online'
);
SET @ddl := IF(@has_col = 0,
    'ALTER TABLE t_user ADD COLUMN show_online TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''是否对外展示在线状态：0 隐私 1 展示'' AFTER last_active_at',
    'SELECT ''[skip] t_user.show_online 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- ③ 在线名单查询用的索引 ----
-- 判定条件是「last_active_at > 某个常量时刻」，属于范围扫描，能吃到索引。
-- 该查询在每次打开消息页/商品详情页都会发一次，没有索引就是每次全表扫用户表。
-- 同样先探 information_schema.STATISTICS，避免重复执行报 1061 Duplicate key name。
SET @has_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_user' AND INDEX_NAME = 'idx_user_last_active'
);
SET @ddl := IF(@has_idx = 0,
    'ALTER TABLE t_user ADD INDEX idx_user_last_active (last_active_at)',
    'SELECT ''[skip] t_user.idx_user_last_active 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- ④ 给存量用户铺一个初始活跃时间 ----
-- 不铺的话所有人的 last_active_at 都是 NULL → 全站「无人在线」，演示时在线标识一个都不亮。
-- 口径：把管理员与最近的几个用户设成「刚活跃过」（在线），其余设为 3 天前（离线），
-- 这样演示一开始就能同时看到在线与离线两种状态。
-- ⚠️ 只在「该行从没被心跳写过」时初始化，不覆盖真实心跳数据。
UPDATE t_user SET last_active_at = NOW() - INTERVAL 1 MINUTE
WHERE last_active_at IS NULL AND id <= 3;
UPDATE t_user SET last_active_at = NOW() - INTERVAL 3 DAY
WHERE last_active_at IS NULL;

-- ---- ⑤ 复核 ----
SELECT id, username, nickname, role,
       show_online,
       last_active_at,
       CASE WHEN show_online = 1 AND last_active_at > NOW() - INTERVAL 300 SECOND
            THEN '在线' ELSE '离线' END AS online_now
FROM t_user
ORDER BY id;
