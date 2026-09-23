-- ====================================================================
-- 演示数据（可选执行）
-- ====================================================================
-- 用途：`schema.sql` 只播种了用户 / 分类 / 公告 / 系统设置，**没有商品**。
--       结果就是前端切到真实后端后，首页、分类页、搜索全是空白 ——
--       Mock 模式下反而"有数据"，真实模式更空，很容易被误判成接口坏了。
--       本脚本补 16 件贴近校园场景的商品，覆盖 8 个分类与 4 种状态。
--
-- 前置：已执行 `schema.sql`（表结构与用户数据）
-- 用法：
--   mysql -uroot -p123456 campus_market < demo-data.sql
-- 清除：
--   mysql -uroot -p123456 campus_market < demo-data-clean.sql
--
-- 幂等：会先清空 t_goods 与 t_category 再重建，可重复执行。
-- ====================================================================

-- ★★ 这里**绝不能**写 `USE campus_market;` ★★
--   本脚本有两种执行方式，目标库都由**调用方**决定：
--     ① 人工：mysql -uroot -p123456 campus_market < demo-data.sql   ← 库名在命令行给过了
--     ② 自动：application-demo.yml 的 spring.sql.init 在启动时执行 ← 库由 spring.datasource.url 决定
--   一旦硬编码 USE，走 ② 时连接会被**切回 campus_market**：数据灌进了另一个库，
--   目标库依旧空空如也，而且**一句错都不报**。脚本只该操作「调用方选定的那个库」。

-- ---------- ① 分类对齐前端口径 ----------
-- 前端 public/goods/ 下的实拍图按 cat{1..8}-{1..3}.jpg 组织，
-- 封面色板与运营看板饼图也按这 8 个分类设计，故 id 语义必须与前端一致。
-- 商品上冗余存了 category_name，所以先清商品再重建分类，避免残留旧名。
DELETE FROM t_goods;
DELETE FROM t_category;
ALTER TABLE t_category AUTO_INCREMENT = 1;
-- ★ 收藏行与商品同生共死：重灌商品前先清收藏 ★
--   无外键，旧收藏行不会报错、只会变成指向已重建 goods_id 的孤儿，
--   悄悄污染「favorite_count ≡ COUNT(*)」这条不变量。
DELETE FROM t_favorite;
ALTER TABLE t_favorite AUTO_INCREMENT = 1;

-- ---------- ①.5 支付单（必须与订单一起重置）----------
-- ★ 为什么支付单要在这里整体清空 ★
--
-- t_payment 通过 order_id 指向 t_order。演示库是**重置型**：
-- 本脚本清商品、demo-data-orders.sql 清它自己播的订单，于是上一轮演示里
-- 产生的支付单会变成**指向不存在订单的孤儿**。
-- 孤儿支付单的危害不是占空间，而是**让对账口径失去意义**：
-- 「已收款总额」「退款总额」这类统计一旦把孤儿算进去，就再也对不上订单表，
-- 而排查的人会以为是支付接口算错了。
--
-- ★ 这是演示库的取舍，不是生产口径 ★
-- 生产环境永远不跑本脚本（application-prod.yml 把 spring.sql.init 关成 never，
-- 且 DeploymentGuard 在带 demo profile 时要求显式确认）。真要紧的是别在演示库上
-- 做真实交易 —— 那部分记录会在下一次演示重置时被一起清掉。
DELETE FROM t_payment;

INSERT INTO t_category (id, name, icon) VALUES
(1, '教材', '📚'),
(2, '数码', '🎮'),
(3, '代步', '🚲'),
(4, '服饰', '👕'),
(5, '生活', '🪑'),
(6, '运动', '🏀'),
(7, '家电', '🍳'),
(8, '艺术', '🎨'),
(9, '其他', '📦');

-- ---------- ② 演示商品 ----------
-- 卖家取自 schema.sql 的演示用户：4 zhangsan / 5 lisi / 6 wangwu
-- 图片走前端 public/goods/ 的本地实拍图（零外链、离线可用）
-- 状态分布：on_sale 13 件（列表页够铺满）、off_shelf 1、sold 1、pending 1（可在审核台看到待审）
INSERT INTO t_goods
(id, title, price, cover, images, description, status, stock, delivery_method,
 category_id, category_name, seller_id, seller_name, seller_avatar, location,
 view_count, favorite_count, create_time, update_time)
VALUES
(1, '高等数学（同济第七版）上册 九成新', 18.00,
 '/goods/cat1-1.jpg', '["/goods/cat1-1.jpg","/goods/cat1-2.jpg"]',
 '大一上学期用的，只翻过前四章，内页干净无笔记，附赠自己整理的重点公式手抄版。期末靠它考了 92，希望能帮到学弟学妹。',
 'on_sale', 1, 'face', 1, '教材', 4, '计算机小张',
 'https://api.dicebear.com/7.x/initials/svg?seed=zs', '图书馆一楼大厅', 268, 0, NOW() - INTERVAL 6 DAY, NOW() - INTERVAL 6 DAY),

(2, '计算机网络 自顶向下方法 第7版', 32.00,
 '/goods/cat1-2.jpg', '["/goods/cat1-2.jpg","/goods/cat1-3.jpg"]',
 '计网课指定教材，书角有轻微压痕，正文无勾画。配套的习题答案我做了电子版，可以一起发你。',
 'on_sale', 1, 'face', 1, '教材', 5, '图书小李',
 'https://api.dicebear.com/7.x/initials/svg?seed=ls', '计算机学院门口', 154, 0, NOW() - INTERVAL 5 DAY, NOW() - INTERVAL 5 DAY),

(3, '考研英语真题解析（2015-2024）', 45.00,
 '/goods/cat1-3.jpg', '["/goods/cat1-3.jpg","/goods/cat1-1.jpg"]',
 '去年考研用的，已经上岸啦所以出掉。十年真题全，阅读部分我做过一遍（铅笔，已擦干净），作文范文没动过。',
 'on_sale', 1, 'express', 1, '教材', 6, '数码小王',
 'https://api.dicebear.com/7.x/initials/svg?seed=ww', '宿舍区 6 号楼', 392, 0, NOW() - INTERVAL 9 DAY, NOW() - INTERVAL 2 DAY),

(4, '罗技 M330 静音无线鼠标', 45.00,
 '/goods/cat2-1.jpg', '["/goods/cat2-1.jpg","/goods/cat2-2.jpg"]',
 '买来后发现和我的 Mac 不太搭，用了不到十次。静音点击真的不吵室友，图书馆自习神器。含原装接收器和电池。',
 'on_sale', 2, 'face', 2, '数码', 6, '数码小王',
 'https://api.dicebear.com/7.x/initials/svg?seed=ww', '宿舍区 6 号楼', 511, 0, NOW() - INTERVAL 4 DAY, NOW() - INTERVAL 1 DAY),

(5, 'iPad 第9代 64G 深空灰 含保护壳', 1150.00,
 '/goods/cat2-2.jpg', '["/goods/cat2-2.jpg","/goods/cat2-3.jpg"]',
 '考研上岸出闲置。屏幕无划痕（一直贴钢化膜），电池健康度 91%，看网课做笔记完全够用。送笔尖套和保护壳。',
 'on_sale', 1, 'face', 2, '数码', 4, '计算机小张',
 'https://api.dicebear.com/7.x/initials/svg?seed=zs', '图书馆一楼大厅', 1268, 0, NOW() - INTERVAL 3 DAY, NOW() - INTERVAL 1 DAY),

(6, '索尼 WH-1000XM3 头戴降噪耳机', 699.00,
 '/goods/cat2-3.jpg', '["/goods/cat2-3.jpg","/goods/cat2-1.jpg"]',
 '降噪效果依然很能打，图书馆开一档就听不见旁边背书了。耳罩换了新的（原装的也在），已暂时下架，等考完试再出。',
 'off_shelf', 1, 'express', 2, '数码', 5, '图书小李',
 'https://api.dicebear.com/7.x/initials/svg?seed=ls', '电子学院楼下', 733, 0, NOW() - INTERVAL 12 DAY, NOW() - INTERVAL 3 DAY),

(7, '捷安特 ATX660 山地车 27速 可议价', 620.00,
 '/goods/cat3-1.jpg', '["/goods/cat3-1.jpg","/goods/cat3-2.jpg"]',
 '毕业出车。骑了两年，正常使用痕迹，刹车和变速上个月刚在车店调过，链条也换了新的。送车锁和打气筒。',
 'on_sale', 1, 'face', 3, '代步', 5, '图书小李',
 'https://api.dicebear.com/7.x/initials/svg?seed=ls', '东门车棚', 894, 0, NOW() - INTERVAL 8 DAY, NOW() - INTERVAL 4 DAY),

(8, '优衣库 摇粒绒外套 M码 卡其色', 59.00,
 '/goods/cat4-1.jpg', '["/goods/cat4-1.jpg","/goods/cat4-2.jpg"]',
 '去年冬天买的，穿过三四次，无起球无破损。南方秋天当外套正好，里面套卫衣也不显肿。原价 199。',
 'on_sale', 1, 'face', 4, '服饰', 6, '数码小王',
 'https://api.dicebear.com/7.x/initials/svg?seed=ww', '宿舍区 6 号楼', 203, 0, NOW() - INTERVAL 7 DAY, NOW() - INTERVAL 7 DAY),

(9, '宿舍折叠小书桌 加大款 免安装', 35.00,
 '/goods/cat5-1.jpg', '["/goods/cat5-1.jpg","/goods/cat5-2.jpg"]',
 '床上书桌，桌面加宽到 60cm，放笔记本加一杯水还有富余。用了一学期，桌面无破损，折叠起来塞床底不占地。',
 'on_sale', 3, 'face', 5, '生活', 4, '计算机小张',
 'https://api.dicebear.com/7.x/initials/svg?seed=zs', '宿舍区 3 号楼', 437, 0, NOW() - INTERVAL 10 DAY, NOW() - INTERVAL 5 DAY),

(10, '落地护眼台灯 三档调光 可充电', 42.00,
 '/goods/cat5-3.jpg', '["/goods/cat5-3.jpg","/goods/cat5-1.jpg"]',
 '三档色温可调，看书写字用暖光不刺眼。内置电池，断电也能用三四个小时。搬到新宿舍用不上了所以出。',
 'on_sale', 1, 'face', 5, '生活', 5, '图书小李',
 'https://api.dicebear.com/7.x/initials/svg?seed=ls', '宿舍区 8 号楼', 176, 0, NOW() - INTERVAL 11 DAY, NOW() - INTERVAL 6 DAY),

(11, '李宁羽毛球拍 双拍套装 送球', 88.00,
 '/goods/cat6-1.jpg', '["/goods/cat6-1.jpg","/goods/cat6-2.jpg"]',
 '买了一直没怎么打，拍面无磕碰，手胶是新的。附送 6 个训练球。适合刚入门想约球的朋友。',
 'on_sale', 1, 'face', 6, '运动', 6, '数码小王',
 'https://api.dicebear.com/7.x/initials/svg?seed=ww', '体育馆门口', 321, 0, NOW() - INTERVAL 5 DAY, NOW() - INTERVAL 3 DAY),

(12, '尤尼克斯 羽毛球 12只装 全新未拆', 55.00,
 '/goods/cat6-3.jpg', '["/goods/cat6-3.jpg","/goods/cat6-1.jpg"]',
 '双十一囤多了，原封未拆。AS-05 比赛级，耐打性不错。等待管理员审核后上架。',
 'pending', 5, 'express', 6, '运动', 4, '计算机小张',
 'https://api.dicebear.com/7.x/initials/svg?seed=zs', '体育馆门口', 0, 0, NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY),

(13, '小米电热水壶 1.5L 白色', 39.00,
 '/goods/cat7-1.jpg', '["/goods/cat7-1.jpg","/goods/cat7-2.jpg"]',
 '宿舍烧水用，烧开自动断电，一直没有水垢（我每月都除垢）。已售出，留个记录。',
 'sold', 1, 'face', 7, '家电', 5, '图书小李',
 'https://api.dicebear.com/7.x/initials/svg?seed=ls', '宿舍区 8 号楼', 245, 0, NOW() - INTERVAL 15 DAY, NOW() - INTERVAL 2 DAY),

(14, '小熊 迷你电煮锅 宿舍神器', 65.00,
 '/goods/cat7-2.jpg', '["/goods/cat7-2.jpg","/goods/cat7-3.jpg"]',
 '煮面煮粥煮小火锅都行，功率不大不跳闸（注意宿舍限电规定）。内胆不粘，好清洗。我用它煮了一学期宵夜。',
 'on_sale', 1, 'face', 7, '家电', 6, '数码小王',
 'https://api.dicebear.com/7.x/initials/svg?seed=ww', '宿舍区 6 号楼', 688, 0, NOW() - INTERVAL 6 DAY, NOW() - INTERVAL 2 DAY),

(15, '民谣吉他 41寸 单板 含琴包', 380.00,
 '/goods/cat8-1.jpg', '["/goods/cat8-1.jpg","/goods/cat8-2.jpg"]',
 '大二社团纳新时买的，陪我练了一年。音准没问题，琴颈没变形。送琴包、变调夹和一包备用弦。',
 'on_sale', 1, 'face', 8, '艺术', 4, '计算机小张',
 'https://api.dicebear.com/7.x/initials/svg?seed=zs', '大学生活动中心', 542, 0, NOW() - INTERVAL 13 DAY, NOW() - INTERVAL 7 DAY),

(16, '桌面文具收纳盒 三件套', 12.00,
 '/goods/cat5-2.jpg', '["/goods/cat5-2.jpg","/goods/cat5-3.jpg"]',
 '搬宿舍整理出来的，一共三件（笔筒＋抽屉盒＋文件架），一起出。塑料材质有点使用痕迹但完全能用。',
 'on_sale', 4, 'face', 9, '其他', 5, '图书小李',
 'https://api.dicebear.com/7.x/initials/svg?seed=ls', '宿舍区 8 号楼', 98, 0, NOW() - INTERVAL 14 DAY, NOW() - INTERVAL 9 DAY);

-- ---------- ②.5 真实收藏行（favorite_count 的数据源）----------
-- ★ §9.4 已决策（2026-09-23）：「装饰大数」改为**真实计数**（保自洽）★
--   此前种子里的 favorite_count（34/203/121…）是无来源的装饰值，而 t_favorite 为空：
--   任何用户收藏/取消一次，refreshFavoriteCount() 重数真实行数并回写，
--   商品卡上的「N 人收藏」会当场塌成 0/1。
--   现在直接灌真实收藏行：卖家不收藏自己的商品；#12 待审核尚无人见过 → 0 条；
--   收藏时间 = (user_id*5 + goods_id*3) MOD 12 + 1 天前（确定性生成，共 52 条）。
INSERT INTO t_favorite (user_id, goods_id, create_time) VALUES
(5, 1, NOW() - INTERVAL 5 DAY),
(6, 1, NOW() - INTERVAL 10 DAY),
(1, 1, NOW() - INTERVAL 9 DAY),
(2, 1, NOW() - INTERVAL 2 DAY),
(3, 1, NOW() - INTERVAL 7 DAY),
(4, 2, NOW() - INTERVAL 3 DAY),
(6, 2, NOW() - INTERVAL 1 DAY),
(1, 2, NOW() - INTERVAL 12 DAY),
(4, 3, NOW() - INTERVAL 6 DAY),
(5, 3, NOW() - INTERVAL 11 DAY),
(1, 3, NOW() - INTERVAL 3 DAY),
(2, 3, NOW() - INTERVAL 8 DAY),
(3, 3, NOW() - INTERVAL 1 DAY),
(4, 4, NOW() - INTERVAL 9 DAY),
(5, 4, NOW() - INTERVAL 2 DAY),
(1, 4, NOW() - INTERVAL 6 DAY),
(2, 4, NOW() - INTERVAL 11 DAY),
(3, 4, NOW() - INTERVAL 4 DAY),
(5, 5, NOW() - INTERVAL 5 DAY),
(6, 5, NOW() - INTERVAL 10 DAY),
(1, 5, NOW() - INTERVAL 9 DAY),
(2, 5, NOW() - INTERVAL 2 DAY),
(3, 5, NOW() - INTERVAL 7 DAY),
(4, 6, NOW() - INTERVAL 3 DAY),
(6, 6, NOW() - INTERVAL 1 DAY),
(2, 6, NOW() - INTERVAL 5 DAY),
(4, 7, NOW() - INTERVAL 6 DAY),
(6, 7, NOW() - INTERVAL 4 DAY),
(1, 7, NOW() - INTERVAL 3 DAY),
(3, 7, NOW() - INTERVAL 1 DAY),
(5, 8, NOW() - INTERVAL 2 DAY),
(1, 8, NOW() - INTERVAL 6 DAY),
(5, 9, NOW() - INTERVAL 5 DAY),
(6, 9, NOW() - INTERVAL 10 DAY),
(3, 9, NOW() - INTERVAL 7 DAY),
(4, 10, NOW() - INTERVAL 3 DAY),
(1, 10, NOW() - INTERVAL 12 DAY),
(4, 11, NOW() - INTERVAL 6 DAY),
(5, 11, NOW() - INTERVAL 11 DAY),
(2, 11, NOW() - INTERVAL 8 DAY),
(4, 13, NOW() - INTERVAL 12 DAY),
(4, 14, NOW() - INTERVAL 3 DAY),
(5, 14, NOW() - INTERVAL 8 DAY),
(1, 14, NOW() - INTERVAL 12 DAY),
(2, 14, NOW() - INTERVAL 5 DAY),
(3, 14, NOW() - INTERVAL 10 DAY),
(5, 15, NOW() - INTERVAL 11 DAY),
(6, 15, NOW() - INTERVAL 4 DAY),
(2, 15, NOW() - INTERVAL 8 DAY),
(3, 15, NOW() - INTERVAL 1 DAY),
(4, 16, NOW() - INTERVAL 9 DAY),
(6, 16, NOW() - INTERVAL 7 DAY);

-- 收口不变量：favorite_count ≡ 真实行数（此后谁改了哪一侧，重灌即对齐）
UPDATE t_goods g
SET favorite_count = (SELECT COUNT(*) FROM t_favorite f WHERE f.goods_id = g.id);

-- ---------- ③ 商品审核记录（让后台「审核记录」页有内容） ----------
DELETE FROM t_goods_audit_record;
ALTER TABLE t_goods_audit_record AUTO_INCREMENT = 1;
INSERT INTO t_goods_audit_record (goods_id, goods_title, action, reason, operator, time) VALUES
(13, '小米电热水壶 1.5L 白色', 'approve', NULL, 'goods_admin', NOW() - INTERVAL 15 DAY),
(14, '小熊 迷你电煮锅 宿舍神器', 'approve', NULL, 'goods_admin', NOW() - INTERVAL 6 DAY),
(15, '民谣吉他 41寸 单板 含琴包', 'approve', NULL, 'goods_admin', NOW() - INTERVAL 13 DAY),
(16, '桌面文具收纳盒 三件套', 'approve', NULL, 'goods_admin', NOW() - INTERVAL 14 DAY),
(6,  '索尼 WH-1000XM3 头戴降噪耳机', 'approve', NULL, 'goods_admin', NOW() - INTERVAL 12 DAY);
-- 说明：id 1..5、7..12 的商品在 schema 层直接给了 on_sale/pending 状态，
-- 没有走审核流程，所以这里只为部分商品补审核记录，避免时间线与状态自相矛盾。

-- ---------- ④ 操作日志（让后台「操作日志」页有内容） ----------
DELETE FROM t_audit_log;
ALTER TABLE t_audit_log AUTO_INCREMENT = 1;
INSERT INTO t_audit_log (action, action_label, target, detail, operator, create_time) VALUES
('goods.publish',   '发布商品', '商品 #5',  'iPad 第9代 64G 深空灰 含保护壳', '计算机小张', NOW() - INTERVAL 3 DAY),
('goodsAudit.approve', '商品审核通过', '商品 #5', 'iPad 第9代 64G 深空灰 含保护壳', 'goods_admin', NOW() - INTERVAL 3 DAY),
('goods.publish',   '发布商品', '商品 #14', '小熊 迷你电煮锅 宿舍神器', '数码小王', NOW() - INTERVAL 6 DAY),
('goods.status',    '修改商品状态', '商品 #6', '索尼 WH-1000XM3 头戴降噪耳机 → off_shelf', '图书小李', NOW() - INTERVAL 3 DAY),
('user.approve',    '用户审核通过', '用户 #6', '数码小王（wangwu）待审核 → 正常', '系统管理员', NOW() - INTERVAL 20 DAY),
('category.update', '编辑分类', '分类「生活」', '更新图标', '系统管理员', NOW() - INTERVAL 21 DAY);

-- ---------- ⑤ 校验 ----------
SELECT '分类' AS 项, COUNT(*) AS 数量 FROM t_category
UNION ALL SELECT '商品(全部)', COUNT(*) FROM t_goods
UNION ALL SELECT '商品(在售)', COUNT(*) FROM t_goods WHERE status = 'on_sale'
UNION ALL SELECT '商品(待审核)', COUNT(*) FROM t_goods WHERE status = 'pending'
UNION ALL SELECT '审核记录', COUNT(*) FROM t_goods_audit_record
UNION ALL SELECT '操作日志', COUNT(*) FROM t_audit_log
UNION ALL SELECT '收藏行数', COUNT(*) FROM t_favorite
UNION ALL SELECT '收藏不变量破坏数(应0)', COUNT(*) FROM t_goods g
WHERE g.favorite_count <> (SELECT COUNT(*) FROM t_favorite f WHERE f.goods_id = g.id);
