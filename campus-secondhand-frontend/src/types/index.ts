/**
 * 全局核心类型定义
 */

/** 通用分页响应 */
export interface PageResult<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

/** 通用分页请求参数 */
export interface PageQuery {
  page?: number
  pageSize?: number
  keyword?: string
  [key: string]: any
}

/** 后端标准响应 */
export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

/** 业务错误码枚举 */
export enum BusinessCode {
  SUCCESS = 0,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  SERVER_ERROR = 500,
  PARAM_ERROR = 1001,
  DATA_NOT_FOUND = 1002
}

/** 用户 */
export interface User {
  id: number
  username: string
  nickname: string
  avatar: string
  phone?: string
  creditScore: number
  /**
   * 用户只有两态（D11 拆除后，2026-09-23）：
   *  - `active` 注册即正常（不再有注册后待审核流程）
   *  - `banned`  已封禁（登录被闸门挡下）
   * 注意：商品 / 举报的 pending 是另一套状态，与此无关。
   */
  status: 'active' | 'banned'
  /**
   * 角色即权限边界：
   *  - `user`          普通用户
   *  - `admin`         全能管理员（现有后台）
   *  - `merchant`      商家
   *  - `goods_admin`   商品审核员 —— 只能进商品审核后台
   *  - `report_admin`  举报审核员 —— 只能进举报处理后台
   * 两个审核员是**职能独立**的单一职责角色，互相看不到对方的后台。
   */
  role: 'user' | 'admin' | 'merchant' | 'goods_admin' | 'report_admin'
  createTime: string
  /**
   * 是否对外展示自己的在线状态（对应 t_user.show_online，默认 true）。
   * <p>
   * ★ 这是**账号级**设置，不是设备级 ★
   * 由 `PATCH /user/privacy` 落库、随 `GET /user/profile` 回来，
   * 因此换浏览器/换机器登录后开关状态必须一致 —— 不能再存 localStorage。
   * 可选：后端字段非空，但 mock/历史数据可能没有，读的时候按 `!== false` 兜底。
   */
  showOnline?: boolean
}

/**
 * 让利成本的承担方。
 *
 * C2C 平台是居间撮合方，商品定价权在卖家手里，平台不能单方给他人商品改价；
 * 因此「折扣」只能来自两条合法路径，且必须能拆账：
 *   - `seller`   **卖家让利**：卖家自愿降价 → 卖家实收减少
 *   - `platform` **平台补贴**：平台补差价   → 卖家实收不变
 */
export type FundSource = 'seller' | 'platform'

/** 商品 */
export interface Goods {
  id: number
  title: string
  /** 卖家挂牌价（平台记录在案的真实价格，也是划线价的唯一来源） */
  price: number
  /**
   * 卖家让利后的活动价；**未参与活动的商品为 undefined**。
   * 有值时：划线价 = `price`（真实），现价 = `promoPrice`。
   */
  promoPrice?: number
  /**
   * 这件商品报名参加的活动 id；未参与活动为 undefined。
   *
   * 与 `promoPrice` 成对出现：有让利价却没记录是哪个活动，事后无法对账，
   * 也说不清「谁批准它进的活动」。
   */
  activityId?: string
  cover: string
  images: string[]
  description: string
  status: 'on_sale' | 'off_shelf' | 'sold' | 'pending'
  /**
   * 可售数量（库存）。
   *
   * 卖家发布时自己填；**未填写一律视为 1 件**（校园二手多为单件闲置）。
   * 购物车与立即购买的数量上限都取它 —— 不记数量就会出现
   * 「加购 3 件、卖家只有 1 件」这种无法履约的订单。
   */
  stock?: number
  /**
   * 交易方式（**单选**）。
   *
   * 一件商品只可能有一种履约方式：面交、包邮快递、或买家自提。
   * 早期做成多选，卖家把三个都勾上，买家下单时无从判断按哪种履约，
   * 出了纠纷也没有约定可依。未填写视为「校园面交」。
   */
  deliveryMethod?: 'face' | 'express' | 'self'
  categoryId: number
  categoryName: string
  sellerId: number
  sellerName: string
  sellerAvatar: string
  location: string
  viewCount: number
  favoriteCount: number
  createTime: string
}

/**
 * 退款单明细。
 *
 * 为什么不能只记一个 `refundTime`：对账要回答三个问题 ——
 * 退了多少钱（可能部分退）、为什么退、谁批的。
 * 这三个都答不上来，退款就只能靠人工回忆，纠纷时没有任何凭据。
 */
export interface OrderRefund {
  /** 实退金额（可小于订单实付，即部分退款） */
  amount: number
  /** 退款原因（买家申请 / 管理员判定，走统一枚举文案） */
  reason: string
  /** 发起方 */
  by: 'buyer' | 'admin'
  /** 申请时间（不是完成时间；完成时间在 `Order.refundTime`） */
  time: string
  /** 处理备注 */
  remark?: string
}

/** 订单 */
export interface Order {
  id: string
  status: 'pending_payment' | 'pending_ship' | 'shipped' | 'received' | 'completed' | 'refunding' | 'cancelled'
  goods: Pick<Goods, 'id' | 'title' | 'cover' | 'price' | 'promoPrice'>
  buyerId: number
  /** 买家昵称（列表展示；后端联表字段，可选） */
  buyerName?: string
  sellerId: number
  /** 卖家昵称（列表展示；后端联表字段，可选） */
  sellerName?: string
  /** 买家实付金额（= 快照里的 payAmount） */
  amount: number

  /* ---------- 价格快照：下单时固化，卖家对账与平台结算的唯一依据 ---------- */
  /** 挂牌价 */
  listPrice: number
  /** 卖家让利金额 */
  sellerCut: number
  /** 平台补贴金额 */
  platformSubsidy: number
  /** 卖家应收 = listPrice - sellerCut */
  sellerIncome: number
  /** 让利成本的承担方 */
  fundSource: FundSource
  /** 参与的活动 id（无活动时为空） */
  activityId?: string

  /**
   * 购买数量。
   *
   * 上面四个金额字段都是**这一单的合计**（已乘过数量），所以必须把数量也存下来：
   * 否则后台对账时 ¥199 到底是「1 件 199」还是「2 件 99.5」永远算不清。
   * 未记录视为 1 件（早期订单都是单件成交）。
   */
  quantity?: number

  remark?: string
  address: string
  trackingNo?: string
  createTime: string
  payTime?: string
  shipTime?: string
  receiveTime?: string
  /** 交易完成时间（收货之后自动/手动完成，与收货分开记，日志才看得出先后） */
  completeTime?: string
  /** 退款完成时间（退款单展示用） */
  refundTime?: string

  /* ---------- 售后（退款单）明细 ----------
   * 只留一个 refundTime 是不够的：对账时「退了多少钱、为什么退、谁批的」
   * 一个都答不上来，只能靠人工回忆。主流电商的退款单都带这三项。 */
  refund?: OrderRefund
  /** 取消原因（未付款超时关闭 / 买家主动取消 / 卖家缺货），带关闭时间 */
  cancelReason?: { time: string; text: string }

  /* ---------- 物流 ---------- */
  /** 承运公司（与 trackingNo 配对；后台批量发货时用得到） */
  logisticsCompany?: string
  /** 物流轨迹（最新在前），发货后由承运方回传 */
  traces?: LogisticsTrace[]

  /* ---------- 后台协作 ---------- */
  /**
   * 后台内部备注。**只对管理员可见**，买家与卖家都看不到 ——
   * 所以它不能和买家备注（`remark`）共用字段，否则一句内部判断
   * 「疑似黄牛，注意」会直接出现在买家订单页上。
   */
  adminNote?: string
  /** 操作日志（按时间倒序）：状态流转的「谁、何时、从哪到哪」 */
  logs?: OrderLog[]
}

/** 订单操作日志的一条 */
export interface OrderLog {
  id: number
  time: string
  /** 机器可读的动作名 */
  action: 'create' | 'pay' | 'ship' | 'receive' | 'complete' | 'cancel' | 'refund' | 'note' | 'adjust'
  /** 展示用中文 */
  actionLabel: string
  /** 流转前状态（note 类动作没有） */
  from?: Order['status']
  /** 流转后状态 */
  to?: Order['status']
  /** 操作人昵称 */
  operator: string
  /** 操作人身份 —— 后台看「这单是谁推进的」全靠它 */
  operatorRole: 'buyer' | 'seller' | 'admin' | 'system'
  /** 补充说明（备注原文、退款原因等） */
  note?: string
}

/** 物流轨迹节点 */
export interface LogisticsTrace {
  time: string
  text: string
}

/** 商品分类 */
export interface Category {
  id: number
  name: string
  icon: string
  parentId?: number
  count?: number
}

/** 私信消息 */
export interface Message {
  id: number
  sessionId: string
  fromUserId: number
  toUserId: number
  content: string
  createTime: string
  read: boolean
}

/** 私信会话 */
export interface ChatSession {
  id: string
  /** 对方用户 id */
  peerId: number
  peerName: string
  peerAvatar: string
  /** 关联商品（可选） */
  goodsId?: number
  goodsTitle?: string
  goodsCover?: string
  lastMessage: string
  lastTime: string
  /** 未读条数（仅统计发给我的） */
  unread: number
}

/** 公告 */
export interface Notice {
  id: number
  title: string
  content: string
  pinned: boolean
  createTime: string
}

/** 举报 */
export interface Report {
  id: number
  type: 'goods' | 'user' | 'order'
  targetId: number
  reason: string
  description: string
  status: 'pending' | 'handled' | 'rejected'
  createTime: string

  /* ---------- 处理留痕：没有这几项，「已处理」只是一个没有内容的结论 ---------- */
  /**
   * 处理措施。仅 `handled` 时有值：
   * 平台对举报的处理必须落到一个**看得见、可复核**的动作上，
   * 只把状态改成「已处理」而没有任何措施，等于什么都没做。
   */
  measure?: ReportMeasure
  /** 处理备注（给后续复核的人看：为什么这么判） */
  remark?: string
  /**
   * 措施实际产生的处置说明（由 `api/report.ts` 的 `applyMeasure()` 回填）。
   * 与 `remark` 的区别：`outcome` 是平台**已经做掉的事**（可核对对象状态变化），
   * `remark` 是管理员的判断依据。两者都为空时说明该记录是历史数据。
   */
  outcome?: string
  /** 处理时间 */
  handleTime?: string
  /** 处理人（演示环境固定为管理员） */
  handledBy?: string
}

/**
 * 举报处理措施。
 *
 * 每一项都必须有**真实副作用**，否则就是给管理员一个无意义的单选框：
 *  - `none`      驳回举报（不做任何处置）
 *  - `warn`      警示 / 通知整改（扣减被举报方信用分）
 *  - `off_shelf` 下架被举报商品
 *  - `remove`    删除被举报商品
 *  - `ban`       封禁被举报用户
 */
export type ReportMeasure = 'none' | 'warn' | 'off_shelf' | 'remove' | 'ban'

/** 商品审核动作：通过上架 / 驳回下架 */
export type GoodsAuditAction = 'approve' | 'reject'

/**
 * 商品审核记录（审核表：审核记录-商品-审核员）。
 *
 * 与举报的 `Report` 处理留痕同一设计思想：没有记录的审核，
 * 「通过/驳回」只是一个改了状态的按钮，出了争议无从复核。
 * 审核记录只增不改，商品可以在被驳回后修改重新提交（再次生成 pending）。
 */
export interface GoodsAuditRecord {
  id: number
  /** 被审核的商品 */
  goodsId: number
  /** 提交时的商品标题（冗余快照：商品改名/删除后记录仍可读） */
  goodsTitle: string
  action: GoodsAuditAction
  /** 驳回理由（action='reject' 时必填且 ≥ 5 字，approve 时无） */
  reason?: string
  /** 审核操作人昵称 */
  operator: string
  /** 审核时间 */
  time: string
}

/** 商品留言（留言表：用户-商品「留言」、留言-留言「评论、回复」） */
export interface GoodsComment {
  id: number
  goodsId: number
  userId: number
  userName: string
  userAvatar: string
  content: string
  /** 回复的父留言 id；顶层留言为 undefined */
  parentId?: number
  /** 被回复人昵称（冗余，展示「回复 @xxx」） */
  replyToName?: string
  createTime: string
}

/** 评价（评价表：订单-评价-用户-被评价人） */
export interface Review {
  id: number
  orderId: string
  goodsId: number
  /** 评价人（买家） */
  fromUserId: number
  fromUserName: string
  fromUserAvatar: string
  /** 被评价人（卖家） */
  toUserId: number
  /** 星级 1-5 */
  rating: number
  content: string
  createTime: string
  /**
   * 追加评价（追评）内容。
   *
   * 首评一经提交就不再可改（改了就是篡改历史评分，对卖家不公平），
   * 但交易体验是延续的 —— 收货用了一阵子才发现的问题也该说得出话。
   * 所以另起一个「追评」字段追加，首评原样保留，两条一起展示。
   */
  appendContent?: string
  /** 追评时间（与首评时间分开，前端展示「追评于 …」） */
  appendTime?: string
}

/** 收货地址 */
export interface Address {
  id: number
  receiver: string
  phone: string
  region: string
  detail: string
  isDefault: boolean
  tag?: string
}

/** 收藏 */
export interface Favorite {
  id: number
  goodsId: number
  goods: Pick<
    Goods,
    'id' | 'title' | 'price' | 'promoPrice' | 'cover' | 'status' | 'location' | 'sellerName' | 'stock'
  >
  createTime: string
}

/** 浏览历史 */
export interface HistoryItem {
  id: number
  goodsId: number
  /**
   * 商品快照。
   *
   * ★ 字段必须与 `Favorite.goods` 对齐 ★ ——两者都由 `mock.ts` 的
   * `pickGoodsBrief()` 统一产出，`status` / `stock` 运行时一直都在。
   * 之前这里漏声明了这两个字段，后果不只是类型报错：
   * 收藏页用 `f.goods.status === 'sold'` 打「已售出」标，而 Profile 页
   * 「从浏览历史加收藏」会原样把这份快照塞进收藏列表 ——
   * 类型上认为没有 status，代码就只能靠猜；实际上有值却读不到，
   * 「已售出」标自然就丢了。
   */
  goods: Pick<
    Goods,
    'id' | 'title' | 'price' | 'promoPrice' | 'cover' | 'status' | 'location' | 'sellerName' | 'stock'
  >
  viewTime: string
}

/** 打招呼（用于从商品详情页发起会话时的默认文案） */
export interface StartChatPayload {
  toUserId: number
  toUserName: string
  toUserAvatar: string
  goodsId?: number
  goodsTitle?: string
  goodsCover?: string
  firstMessage?: string
}
