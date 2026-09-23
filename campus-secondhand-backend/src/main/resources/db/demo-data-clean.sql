-- ====================================================================
-- 清除演示数据
-- ====================================================================
-- 把 `demo-data.sql` 播种的商品及其连带数据清干净，回到「只有用户 / 分类 /
-- 公告 / 系统设置」的初始状态。
--
-- 用法：mysql -uroot -p123456 campus_market < demo-data-clean.sql
--
-- ★ 刻意**不**还原 t_category ★
--   分类口径已对齐前端（1 教材 / 2 数码 / 3 代步 / 4 服饰 / 5 生活 /
--   6 运动 / 7 家电 / 8 艺术 / 9 其他），schema.sql 里也是这一套。
--   还原成旧口径会让前端「乐器分类显示家电照片」的问题重新出现。
-- ====================================================================

-- ★★ 这里**绝不能**写 `USE campus_market;` ★★
--   同 demo-data.sql：库名应由调用方给定（命令行或 spring.datasource.url），
--   硬编码 USE 会在被自动初始化时把连接切到别的库上。

-- 先清「引用商品 / 引用订单」的从表，再清商品本身，
-- 避免留下 categoryId / goodsId / orderId 悬空的行
-- ★ 支付单必须排在 t_order 之前 ★：t_payment.order_id 指向 t_order，
--   顺序反了就留下孤儿支付单，「已收款总额」这类统计会永远对不上订单表。
DELETE FROM t_payment;
DELETE FROM t_wallet_log;
DELETE FROM t_order_log WHERE order_id IN (SELECT id FROM t_order);
DELETE FROM t_order;
DELETE FROM t_favorite;
DELETE FROM t_history;
DELETE FROM t_message;
DELETE FROM t_review;
DELETE FROM t_comment;
DELETE FROM t_report;
DELETE FROM t_goods_audit_record;
DELETE FROM t_audit_log;

DELETE FROM t_goods;
ALTER TABLE t_goods AUTO_INCREMENT = 1;
ALTER TABLE t_goods_audit_record AUTO_INCREMENT = 1;
ALTER TABLE t_audit_log AUTO_INCREMENT = 1;

-- 顺手清掉演示过程中写进用户表的浏览足迹/收藏计数残留（若有）
UPDATE t_user SET credit_score = 100 WHERE credit_score IS NULL;
-- ★ 钱包余额一并归零 ★
--   流水已经清空，余额若还留着就是「钱在、账没了」—— 正好破坏
--   「余额 = 流水之和」这条不变式，之后再想对账就无从下手。
--   要恢复演示用余额，执行 db/demo-wallet-seed.sql。
UPDATE t_user SET balance = 0;

-- ---------- 校验：应只剩用户 / 分类 / 公告 / 系统设置 ----------
SELECT '用户' AS 项, COUNT(*) AS 数量 FROM t_user
UNION ALL SELECT '分类', COUNT(*) FROM t_category
UNION ALL SELECT '公告', COUNT(*) FROM t_notice
UNION ALL SELECT '系统设置', COUNT(*) FROM t_settings
UNION ALL SELECT '商品', COUNT(*) FROM t_goods
UNION ALL SELECT '订单', COUNT(*) FROM t_order
UNION ALL SELECT '支付单', COUNT(*) FROM t_payment
UNION ALL SELECT '钱包流水', COUNT(*) FROM t_wallet_log
UNION ALL SELECT '审核记录', COUNT(*) FROM t_goods_audit_record
UNION ALL SELECT '操作日志', COUNT(*) FROM t_audit_log
UNION ALL SELECT '钱包余额合计', IFNULL(SUM(balance), 0) FROM t_user;
