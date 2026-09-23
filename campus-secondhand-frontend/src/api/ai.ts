/**
 * Spring AI 智能助手 API
 *
 * 后端由 Spring AI（OpenAiChatModel）实现，提供两个能力：
 *  - POST /ai/generate-description  商品描述自动生成（发布商品页）
 *  - POST /ai/chat                  智能客服（站点右下角悬浮入口）
 *
 * 这两个接口此前在后端已经完整实现，但前端**零引用** ——
 * 用户点不到、也没页面调用它，等于功能不可达。此文件是它的接入层。
 *
 * 两个接口都需要登录（不在后端的公开路由白名单里）。
 */
import { request } from './request'
import { mockHelpers } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/**
 * Mock 模式下没有真实模型可调，用「标题 + 关键词」拼出一段
 * 结构合理的描述，保证界面流程（按钮 → loading → 回填）能完整走通。
 */
function mockDescription(title: string, keywords?: string): string {
  const t = title.trim() || '这件商品'
  const kws = (keywords || '')
    .split(/[,，、\s]+/)
    .map((k) => k.trim())
    .filter(Boolean)
  const feature = kws.length ? kws.join('、') : '成色良好、功能正常'
  return (
    `${t}，${feature}。` +
    '个人闲置转让，平时使用很爱惜，外观与功能都没有问题，' +
    '介意二手的同学请谨慎下单。价格已经是很实在的校园价了，不接受大刀。' +
    '校内可当面交易，当面验货更放心；也可以走平台下单，当天就能安排发出。' +
    '有想看细节的地方欢迎留言或私信，我看到就会回复。'
  )
}

/**
 * 商品描述自动生成
 *
 * @param payload title 商品标题（必填）；keywords 关键词，逗号分隔
 * @returns 生成的描述正文（失败时抛错，由调用方决定是否降级）
 */
export async function generateGoodsDescription(payload: {
  title: string
  keywords?: string
}): Promise<string> {
  if (USE_MOCK) {
    await mockHelpers.delay(700)
    return mockDescription(payload.title, payload.keywords)
  }
  const res = await request<{ description: string }>({
    url: '/ai/generate-description',
    method: 'POST',
    data: payload,
    showLoading: false
  })
  return res?.description ?? ''
}

/** 智能客服：一次一问一答 */
export async function aiChat(message: string): Promise<string> {
  if (USE_MOCK) {
    await mockHelpers.delay(600)
    return mockReply(message)
  }
  const res = await request<{ reply: string }>({
    url: '/ai/chat',
    method: 'POST',
    data: { message },
    showLoading: false
  })
  return res?.reply ?? ''
}

/** Mock 客服：命中常见问题给固定话术，其余给兜底话术 */
function mockReply(message: string): string {
  const q = message.trim()
  const hit = (keys: string[]) => keys.some((k) => q.includes(k))
  if (hit(['退款', '退货'])) {
    return '退款流程：买家在「我的订单」里对已付款订单发起退款申请，卖家同意后款项原路退回。卖家 48 小时未处理的，系统会自动介入。'
  }
  if (hit(['审核', '通过', '下架'])) {
    return '新发布的商品会先进入待审核状态，商品审核员通过后自动上架。如果被驳回，会在审核记录里给出具体理由，修改后可以重新提交。'
  }
  if (hit(['举报', '违规'])) {
    return '在商品详情页或用户主页点「举报」，填写理由与描述后提交。举报审核员会核实被举报对象的现状再处置，处理结论可在举报记录里查看。'
  }
  if (hit(['发货', '物流', '快递'])) {
    return '卖家在订单详情里填写运单号与承运公司即视为已发货，买家可以在订单详情页查看物流轨迹。选择「校园面交」的订单不需要物流。'
  }
  if (hit(['信用分', '信用'])) {
    return '信用分初始为 100 分。被核实存在违规（如虚假描述、拒不履约）会扣减信用分，低信用分账号会在商品列表中被降权展示。'
  }
  if (hit(['怎么卖', '发布', '上架商品'])) {
    return '登录后进入「发布商品」，填写标题、价格、数量、分类、交易地点与描述，上传图片后提交即可。新发布的商品需经商品审核员通过后才会展示。'
  }
  return '我是「校园二手集市」的智能客服。关于交易流程、支付发货、退款、商品审核、举报处理的问题都可以问我；如果超出我的范围，建议联系人工客服。'
}
