-- ====================================================================
-- 演示辅助脚本：刷新「在线状态」分布（幂等，可反复执行）
-- ====================================================================
-- 为什么需要它：
--   在线判定依赖 last_active_at 这个**绝对时间戳**，而 schema.sql 里写的是
--   「装库那一刻」的 NOW() 相对值。若建库与演示之间隔了几天，所有种子用户的时间戳
--   都会过期 → 全站一片离线，在线标识一个都不亮，看起来像功能坏了。
--   演示前跑一次本脚本，即可把分布重置成「有人在线、有人离线、有人隐藏」的演示态。
--
-- 执行：mysql -uroot -p123456 campus_market < demo-online-seed.sql
-- ====================================================================

-- ★★ 这里**绝不能**写 `USE campus_market;` ★★
--   同 demo-data.sql：人工执行时库名在命令行给过，自动执行时库由 spring.datasource.url 决定。
--   硬编码 USE 会让自动初始化把连接切回 campus_market —— 数据灌错库，且不报错。

-- ① 在线（last_active_at 在 5 分钟窗口内，且 show_online = 1）
--    小张是大部分商品图的挂载卖家，让他保持在线，商品详情页的卖家徽标才亮得起来。
UPDATE t_user SET last_active_at = NOW() - INTERVAL 1 MINUTE, show_online = 1 WHERE username = 'admin';
UPDATE t_user SET last_active_at = NOW() - INTERVAL 2 MINUTE, show_online = 1 WHERE username = 'goods_admin';
UPDATE t_user SET last_active_at = NOW() - INTERVAL 3 MINUTE, show_online = 1 WHERE username = 'zhangsan';

-- ② 活跃但隐藏：这是隐私开关唯一的「肉眼可验证形态」——
--    他的时间戳和在线的人一样新，但因为 show_online = 0，查询语句直接把他排除在名单外。
UPDATE t_user SET last_active_at = NOW() - INTERVAL 4 MINUTE, show_online = 0 WHERE username = 'lisi';

-- ③ 真离线：时间戳远在时间窗之外（与 show_online 无关，单纯是太久没活跃）
UPDATE t_user SET last_active_at = NOW() - INTERVAL 2 DAY, show_online = 1 WHERE username = 'report_admin';
UPDATE t_user SET last_active_at = NOW() - INTERVAL 1 DAY, show_online = 1 WHERE username = 'wangwu';

-- ④ 复核：每行按后端接口的同一口径（show_online = 1 AND 窗口内）现场算一遍
SELECT id,
       username,
       nickname,
       show_online,
       last_active_at,
       TIMESTAMPDIFF(SECOND, last_active_at, NOW()) AS 距今秒数,
       CASE WHEN show_online = 1 AND last_active_at > NOW() - INTERVAL 300 SECOND
            THEN '在线' ELSE '离线' END AS 接口判定
FROM t_user
ORDER BY id;

-- ⑤ 预期：GET /api/users/online?ids=1,2,3,4,5,6 → data: [1,2,4]
--    1=admin 在线、2=goods_admin 在线、3=report_admin 离线、4=zhangsan 在线、
--    5=lisi 活跃但被隐私开关隐藏 → 不在名单里、6=wangwu 离线
SELECT '预期在线名单（GET /users/online?ids=1,2,3,4,5,6）' AS 说明,
       GROUP_CONCAT(id ORDER BY id) AS 预期data
FROM t_user
WHERE show_online = 1 AND last_active_at > NOW() - INTERVAL 300 SECOND;
