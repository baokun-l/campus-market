-- ====================================================================
-- 增量升级脚本：支付能力（t_payment / t_wallet_log / t_user.balance / t_order 两列）
-- ====================================================================
-- 适用对象：**已经建过库**的旧环境。
--   schema.sql 只对新库有效；schema-auto.sql 全部是 CREATE TABLE IF NOT EXISTS，
--   对已存在的表整条跳过 ⇒ **它建得出新表，但补不了旧表的列**。
--   所以「老库升级」必须跑本脚本。
--
-- 幂等：重复执行不会报错、不会覆盖已有数据 —— 每一步都先用
--       information_schema 探测对象是否已存在。
--
-- 执行方式（在库外，非 mysql 客户端内的 SOURCE）：
--   mysql -uroot -p123456 campus_market < upgrade-payment.sql
-- ====================================================================

USE campus_market;

-- ====================================================================
-- ① t_user.balance —— 平台钱包余额
-- ====================================================================
-- 默认 0：老库升级后不会有人凭空多出钱。要演示「余额支付」，
-- 升级完再跑一次 db/demo-wallet-seed.sql 把演示账号充到 500。
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_user' AND COLUMN_NAME = 'balance'
);
SET @ddl := IF(@has_col = 0,
    'ALTER TABLE t_user ADD COLUMN balance DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT ''钱包余额（平台虚拟币，单位：元）'' AFTER phone',
    'SELECT ''[skip] t_user.balance 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ====================================================================
-- ② t_order 两列 —— 支付方式 + 支付截止时间
-- ====================================================================
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_order' AND COLUMN_NAME = 'pay_channel'
);
SET @ddl := IF(@has_col = 0,
    'ALTER TABLE t_order ADD COLUMN pay_channel VARCHAR(20) NULL COMMENT ''支付方式: wallet/demo/alipay_sandbox/offline'' AFTER pay_time',
    'SELECT ''[skip] t_order.pay_channel 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_col := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_order' AND COLUMN_NAME = 'pay_expire_at'
);
SET @ddl := IF(@has_col = 0,
    'ALTER TABLE t_order ADD COLUMN pay_expire_at DATETIME NULL COMMENT ''支付截止时间（超时未付自动关单）'' AFTER pay_channel',
    'SELECT ''[skip] t_order.pay_expire_at 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- 超时关单任务的扫描索引 ----
-- 条件：status = 'pending_payment' AND pay_expire_at < NOW()
-- 「等值列 + 时间列范围」正好走这条索引；没有它每 5 分钟就是一次全表扫描。
SET @has_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_order' AND INDEX_NAME = 'idx_order_pay_expire'
);
SET @ddl := IF(@has_idx = 0,
    'ALTER TABLE t_order ADD INDEX idx_order_pay_expire (status, pay_expire_at)',
    'SELECT ''[skip] t_order.idx_order_pay_expire 已存在'' AS notice');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ====================================================================
-- ③ t_payment —— 支付单表
-- ====================================================================
-- 用 CREATE TABLE IF NOT EXISTS（幂等），列定义与 schema.sql 逐字一致。
-- 两份不一致会导致「新库有的列、老库没有」，而报错只会出现在用到那一列的时候。
CREATE TABLE IF NOT EXISTS t_payment (
    id              VARCHAR(30)   PRIMARY KEY COMMENT '支付单号(pay_+20位发号)',
    order_id        VARCHAR(30)   NOT NULL COMMENT '订单号',
    buyer_id        BIGINT        NOT NULL COMMENT '付款人ID',
    channel         VARCHAR(20)   NOT NULL COMMENT '渠道: wallet/demo/alipay_sandbox',
    amount          DECIMAL(10,2) NOT NULL COMMENT '应付金额（下单时快照，回调金额必须与它相等）',
    status          VARCHAR(20)   NOT NULL COMMENT '状态: created/paying/success/failed/closed/refunded',
    out_trade_no    VARCHAR(40)   NOT NULL COMMENT '商户订单号（提交给渠道的唯一号）',
    trade_no        VARCHAR(64)   COMMENT '渠道流水号（回调时回填，对账依据）',
    notify_payload  TEXT          COMMENT '渠道回调原始报文（存证，只增不改）',
    refund_amount   DECIMAL(10,2) COMMENT '已退金额（原路退回成功后写入）',
    refund_time     DATETIME      COMMENT '退回完成时间',
    fail_reason     VARCHAR(200)  COMMENT '失败/关闭原因',
    expire_at       DATETIME      COMMENT '支付单过期时间',
    paid_at         DATETIME      COMMENT '渠道确认收款时刻',
    create_time     DATETIME      DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY uk_payment_out_trade_no (out_trade_no),
    KEY idx_payment_order (order_id, id),
    KEY idx_payment_status_expire (status, expire_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付单表';

-- ====================================================================
-- ④ t_wallet_log —— 钱包流水表
-- ====================================================================
CREATE TABLE IF NOT EXISTS t_wallet_log (
    id            BIGINT        AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT        NOT NULL COMMENT '用户ID',
    amount        DECIMAL(10,2) NOT NULL COMMENT '变动金额（正=入账 负=出账）',
    balance_after DECIMAL(10,2) NOT NULL COMMENT '变动后余额（对账用）',
    type          VARCHAR(20)   NOT NULL COMMENT '类型: recharge/pay/refund',
    biz_id        VARCHAR(40)   COMMENT '关联业务号（支付单号或订单号）',
    remark        VARCHAR(200)  COMMENT '说明',
    create_time   DATETIME      DEFAULT CURRENT_TIMESTAMP COMMENT '发生时间',
    KEY idx_wallet_log_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='钱包流水表';

-- ====================================================================
-- ⑤ 存量数据回填 —— 把「已经付过款的订单」补上支付方式
-- ====================================================================
-- 老库里 pay_time 非空 = 付过款，但 pay_channel 是 NULL。
-- 不补的话订单详情会显示「支付方式：—」，而按渠道统计也会把这些单漏掉。
-- 口径：标成 offline（管理员线下代收）—— 这是**最贴近事实**的默认值。
--   改造前那个「点一下就算付款」的按钮并没有产生过任何真实渠道记录，
--   把它标成 wallet / alipay 等于伪造一条第三方流水，对账时会误导人。
--   offline 明确表达「平台自己记的账、没有第三方凭证」，反而诚实。
-- ⚠️ 只在 pay_channel 为空时回填，不覆盖真实支付写入的值。
UPDATE t_order SET pay_channel = 'offline'
WHERE pay_time IS NOT NULL AND pay_channel IS NULL;

-- ====================================================================
-- ⑤-2 存量待付款订单：补支付截止时间
-- ====================================================================
-- 超时关单任务的判据是 status='pending_payment' AND pay_expire_at IS NOT NULL AND < NOW()，
-- 所以 pay_expire_at 为 NULL 的存量单现在**扫不到**（不会关）。一旦回填，它们就进入扫描范围。
--
-- ★★ 这里刻意用 create_time + 24h，不用 NOW() + 24h ★★
--   这条订单**本来**的截止时间就是下单后 24 小时。给一条 30 天前的死单续 24 小时的命，
--   等于伪造事实 —— 它早就该关了。NOW() 那种写法只适用于「数据本身是种子虚构的」场景
--   （见 demo-data-orders.sql：那单的 create_time 是故意压成几天前来演示标红，
--    但下单时刻其实是灌数据的那一刻，所以才必须用 NOW()）。存量真数据不能这么干。
--
-- ⚠️ 必须提前知道的副作用：
--   回填后，凡是已经超过 24 小时的存量待付款单，
--   **下一次定时任务（默认 5 分钟内）就会被自动关掉**，商品随之重新上架。
--   这是正确的结果（它们本来就早该关了），但「我只是跑了个加列脚本，订单怎么没了」
--   在验收/演示现场会非常难看，而且日志里只有一句正常的任务日志，看不出是谁干的。
--   ⇒ 所以第 ⑥ 段专门把「已过期、下次会被关」的数量打了出来。
--     **先跑一次脚本看这个数字**，确认能接受，再让应用带着定时任务起来。
--
--   如果上线首日确实不想批量关单（想给存量用户一个宽限期），把下面这条 UPDATE
--   换成按 NOW() 回填即可 —— 但请明确这是「宽限」而不是「修正」：
--      UPDATE t_order SET pay_expire_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)
--      WHERE status = 'pending_payment' AND pay_expire_at IS NULL;
UPDATE t_order SET pay_expire_at = DATE_ADD(create_time, INTERVAL 24 HOUR)
WHERE status = 'pending_payment' AND pay_expire_at IS NULL;

-- ====================================================================
-- ⑥ 复核
-- ====================================================================
SELECT 't_payment' AS 表, COUNT(*) AS 行数 FROM t_payment
UNION ALL SELECT 't_wallet_log', COUNT(*) FROM t_wallet_log
UNION ALL SELECT 't_user.balance 合计', IFNULL(SUM(balance), 0) FROM t_user
UNION ALL SELECT 't_order 有付款时间', COUNT(*) FROM t_order WHERE pay_time IS NOT NULL
UNION ALL SELECT 't_order 支付方式已回填', COUNT(*) FROM t_order WHERE pay_channel IS NOT NULL
UNION ALL SELECT 't_order 待付款(有截止时间)', COUNT(*) FROM t_order
    WHERE status = 'pending_payment' AND pay_expire_at IS NOT NULL
-- ★ 这一行是升级前必看的数字：>0 表示下一次定时任务就会把它们关掉。
--   数字出乎意料地大 ⇒ 先别让应用起来，回去查清楚为什么有这么多陈年待付款单。
UNION ALL SELECT '!! 待付款且已过期(下次任务会关)', COUNT(*) FROM t_order
    WHERE status = 'pending_payment' AND pay_expire_at < NOW();

-- 列是否都补上了（应各返回 1 行）
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND ((TABLE_NAME = 't_user' AND COLUMN_NAME = 'balance')
    OR (TABLE_NAME = 't_order' AND COLUMN_NAME IN ('pay_channel', 'pay_expire_at')))
ORDER BY TABLE_NAME, ORDINAL_POSITION;
