/**
 * 全局 UI 状态：侧边栏折叠、主题、设备类型、个人偏好（字号 / 主题色 / 深色 / 隐私开关等）
 */
import { defineStore } from 'pinia'

export type FontSize = 'standard' | 'large' | 'xlarge'
export type Accent = 'blue' | 'orange' | 'purple' | 'green'
export type Device = 'desktop' | 'tablet' | 'mobile'

/** 主题色表：value 入库，label 展示。切换时直接改写 CSS 变量（含 Element Plus 主色族） */
export const ACCENTS: Record<Accent, { label: string; primary: string; hover: string }> = {
  blue: { label: '商务蓝', primary: '#2563eb', hover: '#1d4ed8' },
  orange: { label: '活力橙', primary: '#f97316', hover: '#ea580c' },
  purple: { label: '典雅紫', primary: '#7c3aed', hover: '#6d28d9' },
  green: { label: '清新绿', primary: '#10b981', hover: '#059669' }
}

interface Settings {
  /** 字号偏好（standard=14px / large=16px / xlarge=18px） */
  fontSize: FontSize
  /** 深色模式 */
  dark: boolean
  /** 界面主题色 */
  accent: Accent
  /** 隐私：允许通过用户名/手机号找到我 */
  allowSearch: boolean
  /*
   * ★ 这里**没有**「显示在线状态」★
   * 在线可见性是**账号级**设置（t_user.show_online，由 PATCH /user/privacy 落库、
   * 随 GET /user/profile 回来），而本 store 的 settings 是**设备级**偏好
   * （persist 到 localStorage 的 c2c-app）。
   * 曾经把它放在这里，有两个后果：
   *   ① 换台电脑/换个浏览器登录，隐私开关就悄悄恢复默认；
   *   ② 前端还拿它去 gate「别人在线标识」的渲染 —— 语义彻底错位
   *      （那等于「我关掉自己的可见性，连别人在不在线都看不见了」）。
   */
  /** 隐私：个性化推荐 */
  personalizedAds: boolean
  /** 通知：交易消息 */
  notifyTrade: boolean
  /** 通知：系统公告 */
  notifySystem: boolean
  /** 通知：营销推送 */
  notifyMarketing: boolean
}

const DEFAULT_SETTINGS: Settings = {
  fontSize: 'standard',
  dark: false,
  accent: 'blue',
  allowSearch: true,
  personalizedAds: true,
  notifyTrade: true,
  notifySystem: true,
  // 营销推送默认开启：它同时控制首页活动 Banner 的展示，默认关闭会让新用户
 // 看不到首页最重要的活动入口；隐私敏感用户可自行关闭
  notifyMarketing: true
}

/** 深色模式下的界面色（覆盖 variables.scss 里的同名 CSS 变量） */
const DARK_TOKENS: Record<string, string> = {
  '--bg-page': '#101214',
  '--bg-card': '#1a1d22',
  '--bg-soft': '#22262c',
  '--bg-hover': '#272c33',
  '--border-color': '#2b3138',
  '--border-color-strong': '#3a424b',
  '--color-text-primary': '#e8eaed',
  '--color-text-secondary': '#a8afb9',
  '--color-text-mute': '#7d8590',
  '--color-text-disabled': '#59616c'
}

interface State {
  sidebarCollapsed: boolean
  device: Device
  theme: 'light' | 'dark'
  breadcrumb: Array<{ title: string; path?: string }>
  settings: Settings
  /** 估算的缓存体积（KB），仅 mock */
  cacheSize: number
}

export const useAppStore = defineStore('app', {
  state: (): State => ({
    sidebarCollapsed: false,
    device: 'desktop',
    theme: 'light',
    breadcrumb: [],
    settings: { ...DEFAULT_SETTINGS },
    cacheSize: 128
  }),
  getters: {
    /** 字号对应 CSS 像素值，作用于根字号 */
    fontSizePx: (s) =>
      s.settings.fontSize === 'xlarge' ? 18 : s.settings.fontSize === 'large' ? 16 : 14,
    /** 格式化缓存体积为 "X.X MB" / "X KB" */
    cacheSizeText: (s) => {
      const kb = s.cacheSize
      if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
      return `${kb} KB`
    }
  },
  actions: {
    toggleSidebar() { this.sidebarCollapsed = !this.sidebarCollapsed },
    setDevice(d: Device) { this.device = d },
    setBreadcrumb(arr: State['breadcrumb']) { this.breadcrumb = arr },
    setTheme(t: State['theme']) {
      // 统一走 setDark，保证 EP 浅色阶混色基底随深/浅切换
      this.setDark(t === 'dark')
    },
    /**
     * 设置字号。
     *
     * ⚠️ 只改根字号是不够的：全站文字几乎都是 px 定值，rem 用得极少，
     * 用户切完「大」却看不到任何变化（第十九轮探针实测）。
     * 所以同时给 html 挂 `data-font`，由全局样式按档位做整体缩放，
     * 保证「字号大了」肉眼可见。
     */
    setFontSize(f: FontSize) {
      this.settings.fontSize = f
      if (typeof document === 'undefined') return
      document.documentElement.style.fontSize = this.fontSizePx + 'px'
      document.documentElement.dataset.font = f
    },
    /** 同步 settings.dark → theme（重跑 applyAccent：EP 浅色阶的混色基底随深/浅切换） */
    setDark(d: boolean) {
      this.settings.dark = d
      this.theme = d ? 'dark' : 'light'
      document.documentElement.classList.toggle('dark', d)
      this.applyAccent()
    },
    /** 更新单个偏好项 */
    updateSetting<K extends keyof Settings>(key: K, val: Settings[K]) {
      this.settings[key] = val
      if (key === 'dark') this.setDark(val as boolean)
    },
    /**
     * 把当前主题色写进 CSS 变量。
     *
     * 写两族：应用侧 `--color-primary*`（variables.scss 消费）与
     * Element Plus 的 `--el-color-primary*`（按钮 / 链接 / 选中态消费）。
     * EP 的浅色阶用 color-mix 现场派生，免去为每档主题手调 5 个色值。
     */
    applyAccent() {
      if (typeof document === 'undefined') return
      const c = ACCENTS[this.settings.accent]
      if (!c) return
      const el = document.documentElement
      // 深色下 EP 浅色阶要往暗底混，否则 light-9 等在暗背景上是刺眼的大白块
      const mixBase = el.classList.contains('dark') ? '#1a1d22' : '#fff'
      el.dataset.accent = this.settings.accent
      el.style.setProperty('--color-primary', c.primary)
      el.style.setProperty('--color-primary-hover', c.hover)
      el.style.setProperty('--el-color-primary', c.primary)
      el.style.setProperty('--el-color-primary-dark-2', c.hover)
      const mix = (pct: number) => `color-mix(in srgb, ${c.primary} ${pct}%, ${mixBase})`
      el.style.setProperty('--el-color-primary-light-3', mix(70))
      el.style.setProperty('--el-color-primary-light-5', mix(50))
      el.style.setProperty('--el-color-primary-light-7', mix(30))
      el.style.setProperty('--el-color-primary-light-8', mix(20))
      el.style.setProperty('--el-color-primary-light-9', mix(10))
    },
    /** 切换主题色（持久化在 settings.accent 里，applyPreferences 负责启动恢复） */
    setAccent(a: Accent) {
      this.settings.accent = a
      this.applyAccent()
    },
    /**
     * 应用启动时恢复持久化的偏好（深色 / 主题色 / 字号）。
     * 只在设置页恢复是不够的：用户在首页刷新，偏好也得生效。
     */
    applyPreferences() {
      // 先挂 dark 类再应用主题色：applyAccent 混色基底（暗底/白底）取决于 dark 类
      document.documentElement.classList.toggle('dark', this.settings.dark)
      this.theme = this.settings.dark ? 'dark' : 'light'
      this.applyAccent()
      this.setFontSize(this.settings.fontSize)
    },
    /**
     * 清除本地业务缓存。
     *
     * ☠️ 曾经只删 `c2c-cart`——而购物车真正的持久化键是 `c2c-cart-v3`，
     * 等于「点了清除什么都没删」（探针实测：清完购物车还在）。
     * 现在统一清 `c2c-*` 业务键，只保留登录态（c2c-user）与用户偏好（c2c-app），
     * 与确认弹窗里「不会退出登录」的承诺一致。
     */
    clearCache() {
      try {
        // keep 前缀：登录态、设备级偏好之外，账号级偏好（勿扰/实名/第三方绑定，
        // 键形 c2c-dnd-<uid> / c2c-realname-<uid> / c2c-oauth-<uid>）也不该被清——
        // 它们是账号资产，且弹窗承诺了「不会退出登录」
        const keepExact = new Set(['c2c-user', 'c2c-app'])
        const keepPrefixes = ['c2c-dnd-', 'c2c-realname-', 'c2c-oauth-', 'c2c-phone-']
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k) keys.push(k)
        }
        keys
          .filter((k) => k.startsWith('c2c-') && !keepExact.has(k)
            && !keepPrefixes.some((p) => k.startsWith(p)))
          .forEach((k) => localStorage.removeItem(k))
      } catch { /* ignore */ }
      this.cacheSize = 12 // 清理后保留极小基础缓存
    }
  },
  persist: {
    key: 'c2c-app',
    storage: localStorage,
    paths: ['sidebarCollapsed', 'settings', 'cacheSize']
  }
})
