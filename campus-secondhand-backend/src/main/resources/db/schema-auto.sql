-- ====================================================================
-- 校园二手集市 - 自动建表脚本（非破坏性）
-- ====================================================================
-- ★ 这个文件由 .workbuddy/gen-schema-auto.mjs 从 schema.sql 生成，请勿手改 ★
--   改了会在 --check 时被判为漂移；要改表结构请改 schema.sql，再重新生成：
--       node .workbuddy/gen-schema-auto.mjs
--
-- 与 schema.sql 的分工：
--   schema.sql       重建型（DROP + CREATE），用于「干净重装一个库」，手工执行
--   schema-auto.sql  追加型（CREATE TABLE IF NOT EXISTS，零 DROP），
--                    由 application.yml 的 spring.sql.init 在**每次启动**执行
--
-- 为什么可以每次启动都跑：全部语句都是 IF NOT EXISTS，已有库上每条都是 no-op，
--   不删表、不动数据、不改已有列。空库上则等价于一次性建好 17 张表。
--
-- 为什么不在这里放种子数据：种子的幂等需要「表空才灌」的判断，见 db/seed-base.sql
--   （由 spring.sql.init.data-locations 在结构之后执行）。
--
-- 源文件指纹（schema.sql md5 = 1cca55752f3e62b23704c5a443734080）
-- ====================================================================

-- ===== BEGIN GENERATED DDL（由 gen-schema-auto.mjs 从 schema.sql 生成，勿手改）=====
-- ====================================================================
-- 校园二手集市 - 数据库初始化脚本
-- 数据库：campus_market
-- 字符集：utf8mb4
-- ====================================================================


-- ==================== 用户表 ====================
CREATE TABLE IF NOT EXISTS t_user (
    id            BIGINT       AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID',
    username      VARCHAR(50)  NOT NULL UNIQUE COMMENT '用户名',
    password      VARCHAR(100) NOT NULL COMMENT '密码',
    nickname      VARCHAR(50)  NOT NULL COMMENT '昵称',
    avatar        VARCHAR(255) COMMENT '头像URL',
    phone         VARCHAR(20)  COMMENT '手机号',
    -- ★ 平台钱包余额（校园币）★
    -- 「钱」这件事在库里必须只有**一个**权威数字，所以余额落在 t_user 上、
    -- 由「条件 UPDATE」原子增减（见 WalletPayChannel），而不是在应用内存里算。
    -- 每一次增减都配一条 t_wallet_log 流水 —— 余额是现状，流水是过程：
    -- 只有现状、没有过程，出了纠纷永远说不清钱是怎么来的。
    -- ★ 这一列对外只读 ★：实体上是 READ_ONLY，任何请求体都改不动它，
    -- 只能由充值 / 支付 / 退款三条受控路径变更。
    balance       DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '钱包余额（平台虚拟币，单位：元）',
    credit_score  INT          DEFAULT 100 COMMENT '信用分(0-100)',
    status        VARCHAR(20)  DEFAULT 'active' COMMENT '状态: active/banned/pending',
    role          VARCHAR(20)  DEFAULT 'user' COMMENT '角色: user/admin/merchant/goods_admin/report_admin',
    -- ★ token_version：让「改密码」能立刻踢掉旧的 JWT ★
    -- JWT 是无状态的，签出去 24 小时内服务端改不动它。改密码后旧令牌若仍可用，
    -- 「怀疑账号被盗 → 改密码」这个最常用的自救动作就完全无效。
    -- 登录时把本值写进 token 的 ver 声明，AuthInterceptor 每请求与库里的值比对；
    -- 改密码 / 被管理员重置时 +1，所有已签发的旧令牌当次请求即失效。
    token_version INT          NOT NULL DEFAULT 0 COMMENT 'JWT 版本号：改密后 +1，使旧令牌立即失效',
    -- ★ 在线状态：由「客户端心跳 + 服务端时间窗」共同决定，不存 online 布尔值 ★
    -- 存 last_active_at（最后活跃时刻）而不是 online 标志位，是因为标志位有两个死穴：
    --   ① 用户直接关页面/断网，没人来把它改回 0 → 会「永久在线」，越用越假；
    --   ② 需要额外的定时清理任务去扫「僵尸在线」。
    -- 改成记时间戳后，「在线」是每次查询现场算出来的：last_active_at 落在
    -- 最近 ONLINE_WINDOW_SECONDS 内才算在线。客户端掉线不用通知服务端，
    -- 时间窗一过自然变离线，服务端零维护成本。
    last_active_at DATETIME    NULL COMMENT '最后活跃时间（客户端心跳刷新，在线判定基准）',
    -- ★ 隐私开关：关掉后**服务端**就不再把此人算作在线 ★
    -- 注意这一列是「本人对自己在线可见性的意愿」，必须落库而不是留在浏览器：
    -- 留前端的写法是「谁看谁本地过滤」，等于只遮住了自己的眼睛 ——
    -- 关掉开关后别人照样能在在线名单里看到你，这个开关就是假的。
    show_online   TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否对外展示在线状态：0 隐私 1 展示',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间',
    update_time   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    -- ★ 在线名单查询是「按时间范围筛人」，这里给它一个可用的索引 ★
    -- 判定条件是 last_active_at > 常量时刻，属于范围扫描，能走索引；
    -- 用户表是全站最大的表之一，而这个查询在每次打开消息页/商品详情页都会发一次，
    -- 没有索引就是每次全表扫一遍。
    KEY idx_user_last_active (last_active_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- ==================== 商品分类表 ====================
CREATE TABLE IF NOT EXISTS t_category (
    id          BIGINT      AUTO_INCREMENT PRIMARY KEY COMMENT '分类ID',
    name        VARCHAR(50) NOT NULL COMMENT '分类名称',
    icon        VARCHAR(20) DEFAULT '📦' COMMENT '分类图标',
    parent_id   BIGINT      COMMENT '父分类ID',
    create_time DATETIME    DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    -- ★ 唯一索引才是「分类不能重名」的真正防线 ★
    -- GoodsService.createCategory 里「先 count 再 insert」属于 check-then-act：
    -- 两个请求同时通过 count 检查就会插出两条同名分类（前端按分类 id 取图池与配色，
    -- 重名会让两个分类在界面上糊在一起）。count 预检只负责给出友好提示，
    -- 唯一的约束必须落在数据库上，并发正确性不能靠「先查一下应该没问题」。
    UNIQUE KEY uk_category_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品分类表';

-- ==================== 商品表 ====================
CREATE TABLE IF NOT EXISTS t_goods (
    id              BIGINT        AUTO_INCREMENT PRIMARY KEY COMMENT '商品ID',
    title           VARCHAR(200)  NOT NULL COMMENT '标题',
    price           DECIMAL(10,2) NOT NULL COMMENT '挂牌价',
    promo_price     DECIMAL(10,2) COMMENT '活动让利价',
    activity_id     VARCHAR(50)   COMMENT '参与的活动ID',
    cover           VARCHAR(255)  COMMENT '封面图URL',
    images          TEXT          COMMENT '图片集(JSON数组)',
    description     TEXT          COMMENT '商品描述',
    status          VARCHAR(20)   DEFAULT 'pending' COMMENT '状态: on_sale/off_shelf/sold/pending',
    stock           INT           DEFAULT 1 COMMENT '可售数量',
    delivery_method VARCHAR(10)   DEFAULT 'face' COMMENT '交易方式: face/express/self',
    category_id     BIGINT        COMMENT '分类ID',
    category_name   VARCHAR(50)   COMMENT '分类名称(冗余)',
    seller_id       BIGINT        NOT NULL COMMENT '卖家ID',
    seller_name     VARCHAR(50)   COMMENT '卖家昵称',
    seller_avatar   VARCHAR(255)  COMMENT '卖家头像',
    location        VARCHAR(200)  COMMENT '交易地点',
    view_count      INT           DEFAULT 0 COMMENT '浏览量',
    favorite_count  INT           DEFAULT 0 COMMENT '收藏量',
    create_time     DATETIME      DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
    update_time     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    -- 索引按**真实查询**建（逐条对应 GoodsMapper.xml / CategoryMapper.xml），
    -- 不为「以后可能用得上」加索引 —— 多余的索引会让写入变慢且没人敢删：
    --   买家广场/后台列表：WHERE status [IN ...] [AND category_id=?] ORDER BY create_time DESC
    --   卖家「我的商品」  ：WHERE seller_id=? [AND status=?]
    --   分类下商品计数    ：WHERE category_id=?
    KEY idx_goods_status   (status, create_time),
    KEY idx_goods_category (category_id, status),
    KEY idx_goods_seller   (seller_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品表';

-- ==================== 订单表 ====================
CREATE TABLE IF NOT EXISTS t_order (
    id                  VARCHAR(30)   PRIMARY KEY COMMENT '订单号',
    status              VARCHAR(20)   NOT NULL COMMENT '状态: pending_payment/pending_ship/shipped/received/completed/refunding/cancelled',
    goods_id            BIGINT        NOT NULL COMMENT '商品ID',
    goods_title         VARCHAR(200)  COMMENT '商品标题(快照)',
    goods_cover         VARCHAR(255)  COMMENT '商品封面(快照)',
    goods_price         DECIMAL(10,2) COMMENT '挂牌价(快照)',
    goods_promo_price   DECIMAL(10,2) COMMENT '让利价(快照)',
    buyer_id            BIGINT        NOT NULL COMMENT '买家ID',
    buyer_name          VARCHAR(50)   COMMENT '买家昵称',
    seller_id           BIGINT        NOT NULL COMMENT '卖家ID',
    seller_name         VARCHAR(50)   COMMENT '卖家昵称',
    amount              DECIMAL(10,2) NOT NULL COMMENT '买家实付金额',
    list_price           DECIMAL(10,2) COMMENT '挂牌价快照',
    seller_cut          DECIMAL(10,2) DEFAULT 0 COMMENT '卖方让利金额',
    platform_subsidy    DECIMAL(10,2) DEFAULT 0 COMMENT '平台补贴金额',
    seller_income       DECIMAL(10,2) COMMENT '卖方应收',
    fund_source         VARCHAR(10)   DEFAULT 'seller' COMMENT '让利承担方: seller/platform',
    activity_id         VARCHAR(50)   COMMENT '参与的活动ID',
    quantity            INT           DEFAULT 1 COMMENT '购买数量',
    remark              VARCHAR(500)  COMMENT '买家备注',
    address             VARCHAR(500)  COMMENT '收货地址',
    tracking_no         VARCHAR(50)   COMMENT '运单号',
    logistics_company   VARCHAR(50)   COMMENT '承运公司',
    traces              TEXT          COMMENT '物流轨迹(JSON)',
    admin_note          VARCHAR(500)  COMMENT '后台内部备注',
    refund_amount       DECIMAL(10,2) COMMENT '退款金额',
    refund_reason       VARCHAR(200)  COMMENT '退款原因',
    refund_by           VARCHAR(10)   COMMENT '退款发起方: buyer/admin',
    refund_remark       VARCHAR(500)  COMMENT '退款备注',
    refund_time         DATETIME      COMMENT '退款完成时间',
    cancel_reason_text  VARCHAR(200)  COMMENT '取消原因',
    cancel_reason_time  DATETIME      COMMENT '取消时间',
    create_time         DATETIME      DEFAULT CURRENT_TIMESTAMP COMMENT '下单时间',
    pay_time            DATETIME      COMMENT '付款时间',
    -- ★ 支付方式 ★：订单上只留「最终用的是哪条渠道」这一个展示用的事实。
    -- 第三方流水号 / 回调原文 / 金额核对都归 t_payment，**不在订单上再存一份** ——
    -- 同一件事有两个存放点时，两边迟早不一致，而对账时无法判断以哪个为准。
    -- 取值：wallet 钱包 / demo 演示渠道 / alipay_sandbox 支付宝沙箱 / offline 管理员线下代收
    pay_channel         VARCHAR(20)   COMMENT '支付方式: wallet/demo/alipay_sandbox/offline',
    -- ★ 支付截止时间 ★
    -- 下单时按 t_settings 的支付时限算出并落库，超时自动关单任务按本列扫描。
    -- 为什么不直接拿 create_time 加偏移现场算：那样「改配置」会把**已经存在的**
    -- 订单的截止时间一起改掉，判定口径随配置漂移。落库 = 下单那一刻的约定被固定下来。
    pay_expire_at       DATETIME      COMMENT '支付截止时间（超时未付自动关单）',
    ship_time           DATETIME      COMMENT '发货时间',
    receive_time        DATETIME      COMMENT '收货时间',
    complete_time       DATETIME      COMMENT '完成时间',
    -- 与 OrderMapper.xml 的三类列表查询一一对应（每条都是「等值列 + create_time 倒序」）：
    --   买家订单 / 卖家订单 / 后台订单工作台
    KEY idx_order_buyer  (buyer_id, create_time),
    KEY idx_order_seller (seller_id, create_time),
    KEY idx_order_status (status, create_time),
    -- 超时关单任务的扫描条件：status = 'pending_payment' AND pay_expire_at < NOW()
    -- 「等值列 + 时间列范围」正好走这条索引；没有它，每 5 分钟就是一次全表扫描
    KEY idx_order_pay_expire (status, pay_expire_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

-- ==================== 订单操作日志表 ====================
CREATE TABLE IF NOT EXISTS t_order_log (
    id            BIGINT       AUTO_INCREMENT PRIMARY KEY,
    order_id      VARCHAR(30)  NOT NULL COMMENT '订单号',
    time          DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
    action        VARCHAR(20)  NOT NULL COMMENT '动作: create/pay/ship/receive/complete/cancel/refund/note/adjust',
    action_label  VARCHAR(50)  COMMENT '展示用中文',
    from_status   VARCHAR(20)  COMMENT '流转前状态',
    to_status     VARCHAR(20)  COMMENT '流转后状态',
    operator      VARCHAR(50)  COMMENT '操作人昵称',
    operator_role VARCHAR(10)  COMMENT '操作人身份: buyer/seller/admin/system',
    note          VARCHAR(500) COMMENT '补充说明',
    -- 取某单的全部日志：WHERE order_id=? ORDER BY id
    -- （订单详情回填日志、以及 rejectRefund 反查「进入 refunding 之前是什么状态」都走这条）
    KEY idx_order_log_order (order_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单操作日志表';

-- ==================== 支付单表 ====================
-- ★ 为什么订单表旁边必须再有一张支付单表 ★
--
-- 改造前「付款」这件事全靠 t_order.pay_time 一列承载：前端点一下「确定」，
-- 后端直接把订单从 pending_payment 改成 pending_ship。这在真实支付里是不成立的 ——
--   · 没有任何**支付凭证**：谁付的、付了多少、走的哪条通道、通道那边的流水号是什么，
--     一个字都没有。出了纠纷无法向第三方举证，也无法与渠道对账；
--   · 一次支付尝试与一笔订单被混为一谈：用户先试余额（失败）再试支付宝（成功），
--     这两次尝试在库里没有任何痕迹，而它们恰恰是排查支付问题最需要的东西；
--   · 状态不可回溯：支付可能「已提交、结果未知」（网络断了、回调丢了），
--     而 t_order.status 只有「待付款 / 待发货」，表达不了中间态。
--
-- 所以支付单独建模：
--   一笔订单 →（0..N）张支付单，**至多一张 success**；翻订单状态只由「支付成功」驱动。
-- 渠道流水号与原始回调报文存在这里，是**对账与举证**的唯一依据。
--
-- 状态机：created → paying → success / failed / closed → refunded
--   created  刚建，尚未把用户送去收银台
--   paying   已把用户送去收银台（跳转 / 出二维码），结果未知
--   success  渠道确认收款（终态之一）
--   failed   渠道明确拒绝（余额不足、用户取消），可另建一张重试
--   closed   超时未付 / 被新支付单取代 / 订单已取消（终态）
--   refunded 已原路退回（只能从 success 进入）
CREATE TABLE IF NOT EXISTS t_payment (
    id              VARCHAR(30)   PRIMARY KEY COMMENT '支付单号(pay_+20位发号)',
    order_id        VARCHAR(30)   NOT NULL COMMENT '订单号',
    buyer_id        BIGINT        NOT NULL COMMENT '付款人ID',
    channel         VARCHAR(20)   NOT NULL COMMENT '渠道: wallet/demo/alipay_sandbox',
    amount          DECIMAL(10,2) NOT NULL COMMENT '应付金额（下单时快照，回调金额必须与它相等）',
    status          VARCHAR(20)   NOT NULL COMMENT '状态: created/paying/success/failed/closed/refunded',
    -- ★ 商户订单号：提交给渠道的那个号 ★
    -- 本项目直接复用支付单号，但**单独存一列**而不是每次现取 id：
    -- 将来要换成独立编号（渠道对字符集/长度有额外要求时）只需改这一列的值，
    -- 而不用把「支付单号」这个对外标识一起改掉（改了就是历史数据断链）。
    out_trade_no    VARCHAR(40)   NOT NULL COMMENT '商户订单号（提交给渠道的唯一号）',
    trade_no        VARCHAR(64)   COMMENT '渠道流水号（回调时回填，对账依据）',
    -- ★ 回调原文必须原样存下来 ★
    -- 验签只证明「这报文是渠道发的」，证明不了「我们当时是怎么解读的」。
    -- 事后对账时，唯一能复现判断过程的就是这段原文。**只增不改**。
    notify_payload  TEXT          COMMENT '渠道回调原始报文（存证，只增不改）',
    refund_amount   DECIMAL(10,2) COMMENT '已退金额（原路退回成功后写入）',
    refund_time     DATETIME      COMMENT '退回完成时间',
    fail_reason     VARCHAR(200)  COMMENT '失败/关闭原因',
    expire_at       DATETIME      COMMENT '支付单过期时间',
    paid_at         DATETIME      COMMENT '渠道确认收款时刻',
    create_time     DATETIME      DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    -- ★ 唯一索引是「同一张支付单不会被渠道当成两笔」的最后防线 ★
    -- 回调靠它定位支付单；重复创建同一个 out_trade_no 会被数据库直接拒掉，
    -- 而不是靠「Service 里记得先查一下」这种检查后再插入。
    UNIQUE KEY uk_payment_out_trade_no (out_trade_no),
    -- 取某单的全部支付尝试：WHERE order_id=? ORDER BY id（支付记录时间线）
    KEY idx_payment_order (order_id, id),
    -- 超时关支付单：status IN ('created','paying') AND expire_at < NOW()
    KEY idx_payment_status_expire (status, expire_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付单表';

-- ==================== 钱包流水表 ====================
-- ★ 余额是现状，流水是过程，两者必须都有 ★
--
-- 只有 t_user.balance 时，「余额为什么是 37.5」这个问题无法回答；
-- 只有流水时，每次查余额都要把所有流水求和（且一旦有漏记就永久错账）。
-- 所以：余额由**条件 UPDATE 原子维护**（并发安全、可判超扣），
-- 流水由**同事务插入**保证「改了余额必有对应的账」。
--
-- balance_after 是刻意冗余的一列：它让「余额对不对」变成一次逐行比对 ——
-- 每条流水的 balance_after 应当等于上一条的 balance_after 加本条 amount。
-- 只存 amount 的话，对账得自己从头累加，且一旦中间有一条被误删就永远检查不出来。
CREATE TABLE IF NOT EXISTS t_wallet_log (
    id            BIGINT        AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT        NOT NULL COMMENT '用户ID',
    amount        DECIMAL(10,2) NOT NULL COMMENT '变动金额（正=入账 负=出账）',
    balance_after DECIMAL(10,2) NOT NULL COMMENT '变动后余额（对账用）',
    type          VARCHAR(20)   NOT NULL COMMENT '类型: recharge/pay/refund',
    biz_id        VARCHAR(40)   COMMENT '关联业务号（支付单号或订单号）',
    remark        VARCHAR(200)  COMMENT '说明',
    create_time   DATETIME      DEFAULT CURRENT_TIMESTAMP COMMENT '发生时间',
    -- 取某人流水：WHERE user_id=? ORDER BY id DESC
    KEY idx_wallet_log_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='钱包流水表';

-- ==================== 私信消息表 ====================
CREATE TABLE IF NOT EXISTS t_message (
    id           BIGINT       AUTO_INCREMENT PRIMARY KEY,
    session_id   VARCHAR(60)  NOT NULL COMMENT '会话ID(s_goodsId_minId_maxId)',
    from_user_id BIGINT       NOT NULL COMMENT '发送者ID',
    to_user_id   BIGINT       NOT NULL COMMENT '接收者ID',
    content      TEXT         NOT NULL COMMENT '消息内容',
    is_read      TINYINT(1)   DEFAULT 0 COMMENT '是否已读',
    create_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
    INDEX idx_session (session_id),
    INDEX idx_to_user (to_user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='私信消息表';

-- ==================== 公告表 ====================
CREATE TABLE IF NOT EXISTS t_notice (
    id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
    title       VARCHAR(200) NOT NULL COMMENT '标题',
    content     TEXT         NOT NULL COMMENT '内容',
    pinned      TINYINT(1)   DEFAULT 0 COMMENT '是否置顶',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台公告表';

-- ==================== 举报表 ====================
CREATE TABLE IF NOT EXISTS t_report (
    id           BIGINT       AUTO_INCREMENT PRIMARY KEY,
    type         VARCHAR(10)  NOT NULL COMMENT '举报类型: goods/user/order',
    target_id    BIGINT       NOT NULL COMMENT '被举报对象ID',
    reporter_id  BIGINT       NOT NULL COMMENT '举报人ID',
    reason       VARCHAR(200) COMMENT '举报理由',
    description  TEXT         COMMENT '详细描述',
    status       VARCHAR(20)  DEFAULT 'pending' COMMENT '状态: pending/handled/rejected',
    measure      VARCHAR(20)  COMMENT '处理措施: none/warn/off_shelf/remove/ban',
    remark       VARCHAR(500) COMMENT '处理备注',
    outcome      VARCHAR(500) COMMENT '处置说明',
    handle_time  DATETIME     COMMENT '处理时间',
    handled_by   VARCHAR(50)  COMMENT '处理人',
    create_time  DATETIME     DEFAULT CURRENT_TIMESTAMP,
    -- 举报台：WHERE status=? [AND type=?] ORDER BY create_time DESC
    -- 另按被举报对象查历史：WHERE type=? AND target_id=?
    KEY idx_report_status      (status, create_time),
    KEY idx_report_type_target (type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='举报表';

-- ==================== 评价表 ====================
CREATE TABLE IF NOT EXISTS t_review (
    id            BIGINT       AUTO_INCREMENT PRIMARY KEY,
    order_id      VARCHAR(30)  NOT NULL COMMENT '订单号',
    goods_id      BIGINT       NOT NULL COMMENT '商品ID',
    from_user_id  BIGINT       NOT NULL COMMENT '评价人ID(买家)',
    from_user_name VARCHAR(50) COMMENT '评价人昵称',
    from_user_avatar VARCHAR(255) COMMENT '评价人头像',
    to_user_id    BIGINT       NOT NULL COMMENT '被评价人ID(卖家)',
    rating        INT          NOT NULL COMMENT '星级1-5',
    content       TEXT         COMMENT '评价内容',
    append_content TEXT        COMMENT '追评内容',
    append_time   DATETIME     COMMENT '追评时间',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP,
    -- ReviewMapper.xml 的三条真实查询各配一条：按商品 / 按被评价人 / 按订单（一单一评，LIMIT 1）
    KEY idx_review_goods   (goods_id, create_time),
    KEY idx_review_to_user (to_user_id, create_time),
    KEY idx_review_order   (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='评价表';

-- ==================== 商品留言表 ====================
CREATE TABLE IF NOT EXISTS t_comment (
    id            BIGINT       AUTO_INCREMENT PRIMARY KEY,
    goods_id      BIGINT       NOT NULL COMMENT '商品ID',
    user_id       BIGINT       NOT NULL COMMENT '留言人ID',
    user_name     VARCHAR(50)  COMMENT '留言人昵称',
    user_avatar   VARCHAR(255) COMMENT '留言人头像',
    content       TEXT         NOT NULL COMMENT '留言内容',
    parent_id     BIGINT       COMMENT '父留言ID(回复)',
    reply_to_name VARCHAR(50)  COMMENT '被回复人昵称',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP,
    -- 留言列表按商品取（CommentMapper）：WHERE goods_id=? ORDER BY create_time；
    -- 删除父留言时要级联删子留言：WHERE parent_id=?
    KEY idx_comment_goods  (goods_id, create_time),
    KEY idx_comment_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品留言表';

-- ==================== 收货地址表 ====================
CREATE TABLE IF NOT EXISTS t_address (
    id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT       NOT NULL COMMENT '用户ID',
    receiver   VARCHAR(50)  NOT NULL COMMENT '收货人',
    phone      VARCHAR(20)  NOT NULL COMMENT '电话',
    region     VARCHAR(200) COMMENT '地区',
    detail     VARCHAR(500) COMMENT '详细地址',
    is_default TINYINT(1)   DEFAULT 0 COMMENT '是否默认',
    tag        VARCHAR(20)  COMMENT '标签',
    create_time DATETIME    DEFAULT CURRENT_TIMESTAMP,
    -- 地址簿永远只按 user_id 取
    KEY idx_address_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='收货地址表';

-- ==================== 收藏表 ====================
CREATE TABLE IF NOT EXISTS t_favorite (
    id          BIGINT   AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT   NOT NULL COMMENT '用户ID',
    goods_id    BIGINT   NOT NULL COMMENT '商品ID',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_goods (user_id, goods_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='收藏表';

-- ==================== 浏览历史表 ====================
CREATE TABLE IF NOT EXISTS t_history (
    id        BIGINT   AUTO_INCREMENT PRIMARY KEY,
    user_id   BIGINT   NOT NULL COMMENT '用户ID',
    goods_id  BIGINT   NOT NULL COMMENT '商品ID',
    view_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '浏览时间',
    INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='浏览历史表';

-- ==================== 商品审核记录表 ====================
CREATE TABLE IF NOT EXISTS t_goods_audit_record (
    id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
    goods_id    BIGINT       NOT NULL COMMENT '商品ID',
    goods_title VARCHAR(200) COMMENT '商品标题(快照)',
    action      VARCHAR(10)  NOT NULL COMMENT '审核动作: approve/reject',
    reason      VARCHAR(500) COMMENT '驳回理由',
    operator    VARCHAR(50)  COMMENT '审核人',
    time        DATETIME     DEFAULT CURRENT_TIMESTAMP,
    -- 审核记录按商品查历史：WHERE goods_id=? ORDER BY time DESC
    KEY idx_audit_record_goods (goods_id, time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品审核记录表';

-- ==================== 系统操作日志表 ====================
CREATE TABLE IF NOT EXISTS t_audit_log (
    id           BIGINT       AUTO_INCREMENT PRIMARY KEY,
    action       VARCHAR(50)  NOT NULL COMMENT '动作类型',
    action_label VARCHAR(50)  COMMENT '展示用中文',
    target       VARCHAR(200) COMMENT '操作对象',
    detail       TEXT         COMMENT '操作详情',
    operator     VARCHAR(50)  COMMENT '操作人',
    create_time  DATETIME     DEFAULT CURRENT_TIMESTAMP,
    -- 审计流水只按时间倒序取最近 N 条、以及按时间清理，没有其它过滤维度
    KEY idx_audit_log_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统操作日志表';

-- ==================== 系统设置表 ====================
CREATE TABLE IF NOT EXISTS t_settings (
    id                  BIGINT       AUTO_INCREMENT PRIMARY KEY,
    site_name           VARCHAR(100) DEFAULT '校园二手集市' COMMENT '站点名称',
    service_phone       VARCHAR(30)  DEFAULT '400-000-0000' COMMENT '客服电话',
    announce_text       VARCHAR(500) COMMENT '顶部公告文案',
    goods_audit_required TINYINT(1)  DEFAULT 1 COMMENT '发布需审核',
    max_publish_per_day INT          DEFAULT 10 COMMENT '每日发布上限',
    auto_offline_days   INT          DEFAULT 30 COMMENT '自动下架天数',
    report_auto_hide    TINYINT(1)   DEFAULT 0 COMMENT '举报自动隐藏',
    commission_rate     DECIMAL(5,4) DEFAULT 0.0000 COMMENT '服务费率'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统设置表';

-- ==================== 限时活动表 ====================
-- 说明：id 为「业务主键」（字符串，如 back-to-school-2026-fall），非自增；
--       活动是否处于 active 由服务端时钟根据 start_at + duration_days 计算，客户端不可篡改；
--       highlights / claims 为 JSON 列，MyBatis-Plus 侧用 JacksonTypeHandler 映射为 List。
--       t_activity 为空时 ActivityService.seedIfEmpty() 会按内置模板惰性补种。
CREATE TABLE IF NOT EXISTS t_activity (
    id            VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '活动业务主键',
    title         VARCHAR(100) NOT NULL COMMENT '活动标题',
    subtitle      VARCHAR(200) COMMENT '副标题',
    cta_text      VARCHAR(50)  COMMENT '按钮文案',
    cta_link      VARCHAR(200) COMMENT '按钮跳转链接',
    icon          VARCHAR(50)  COMMENT '图标标识',
    theme         VARCHAR(30)  COMMENT '主题色标识',
    highlights    TEXT         COMMENT '活动亮点 JSON 数组',
    claims        TEXT         COMMENT '让利声明 JSON 数组 [{categoryId, rate}]',
    fund_source   VARCHAR(50)  COMMENT '让利资金来源',
    duration_days INT          DEFAULT 7 COMMENT '活动持续天数',
    priority      INT          DEFAULT 0 COMMENT '展示优先级，越大越靠前',
    enabled       TINYINT(1)   DEFAULT 1 COMMENT '是否启用',
    note          VARCHAR(500) COMMENT '备注',
    start_at      BIGINT       COMMENT '开始时间（毫秒时间戳，服务端时钟）',
    cancelled_at  BIGINT       COMMENT '取消时间（毫秒时间戳）',
    cancelled_by  VARCHAR(50)  COMMENT '取消操作人',
    create_time   BIGINT       COMMENT '创建时间（毫秒时间戳）',
    update_time   BIGINT       COMMENT '更新时间（毫秒时间戳）'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='限时活动表';
-- ===== END GENERATED DDL =====
