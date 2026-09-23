/**
 * 用户级偏好持久化（按账号隔离）
 *
 * ★ 为什么不用 appStore 的 c2c-app ★
 * 那份存储是**设备级**的：换账号登录偏好会串（A 关了勿扰，B 也跟着关）。
 * 通知 / 隐私 / 勿扰这类「账号属性」的偏好按 uid 分键存取；
 * 字号 / 深色 / 主题色这类「设备属性」的偏好仍留在全局。
 */

export interface DndPref {
  /** 是否启用勿扰时段 */
  enabled: boolean
  /** 起始 HH:mm */
  start: string
  /** 结束 HH:mm */
  end: string
}

export const DEFAULT_DND: DndPref = { enabled: false, start: '23:00', end: '07:00' }

const dndKey = (uid: number | string | undefined) => `c2c-dnd-${uid ?? 'guest'}`
const realNameKey = (uid: number | string | undefined) => `c2c-realname-${uid ?? 'guest'}`
const oauthKey = (uid: number | string | undefined) => `c2c-oauth-${uid ?? 'guest'}`

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val))
  } catch { /* 隐私模式下可能禁写，静默降级为会话内生效 */ }
}

export function loadDnd(uid: number | string | undefined): DndPref {
  return { ...DEFAULT_DND, ...readJson<Partial<DndPref>>(dndKey(uid), {}) }
}

export function saveDnd(uid: number | string | undefined, pref: DndPref) {
  writeJson(dndKey(uid), pref)
}

/** 当前时刻是否处于勿扰时段（支持跨零点，如 23:00 - 07:00） */
export function isInDndNow(p: DndPref): boolean {
  if (!p.enabled) return false
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const a = toMin(p.start)
  const b = toMin(p.end)
  if (a === b) return false // 起止相同视为未配置
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

/** 实名认证：只存姓名与身份证后 4 位（演示环境不采集完整证件号） */
export interface RealNamePref {
  name: string
  last4: string
}

export function loadRealName(uid: number | string | undefined): RealNamePref | null {
  return readJson<RealNamePref | null>(realNameKey(uid), null)
}

export function saveRealName(uid: number | string | undefined, pref: RealNamePref) {
  writeJson(realNameKey(uid), pref)
}

/** 第三方账号绑定：绑定哪个平台（演示环境为本地模拟） */
export type OauthProvider = '微信' | 'QQ' | ''

export function loadOauth(uid: number | string | undefined): OauthProvider {
  return readJson<OauthProvider>(oauthKey(uid), '')
}

export function saveOauth(uid: number | string | undefined, provider: OauthProvider) {
  writeJson(oauthKey(uid), provider)
}

/* ---- 绑定手机（★ 原注释「后端 User 无 phone 字段」有误：`t_user.phone` 存在，
 *      实体 `User#phone` 也映射了它；真正缺的是「绑定 / 更换手机号」的端点。
 *      演示环境暂按账号本地留存，接入端点后应改为落库。 ---- */
const phoneKey = (uid: number | string | undefined) => `c2c-phone-${uid ?? 'guest'}`

export function loadPhone(uid: number | string | undefined): string {
  return readJson<string>(phoneKey(uid), '')
}

export function savePhone(uid: number | string | undefined, phone: string) {
  writeJson(phoneKey(uid), phone)
}

/*
 * ★ 这里原来的 `isUserOnline(id)` 已经删除 ★
 *
 * 它用 `((id * 7 + 今天的日期) % 10) < 6` 编出一个「约六成用户在线」的假名单：
 * 同一个用户当天状态固定、隔天可能变，看着挺像真的。但它是**纯装饰**：
 *   - 与「你到底在不在」毫无关系，关机也照样显示在线；
 *   - 关掉隐私开关只影响本机渲染，别人照样看得到你在线；
 *   - 每个渲染点都要自己调一遍，口径随时会漂。
 * 现在改成向服务端要真实在线名单：`stores/modules/online.ts` +
 * `GET /users/online`（判定口径 = show_online = 1 且 5 分钟内有过心跳）。
 */
