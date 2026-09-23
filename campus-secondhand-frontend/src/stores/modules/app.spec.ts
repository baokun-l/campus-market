/**
 * Pinia Store 单元测试 · 全局 UI 状态
 * 验证：侧边栏折叠 / 设备类型 / 主题切换 / 字号偏好 / 偏好项更新 / 缓存清理
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useAppStore } from '@/stores/modules/app'

describe('useAppStore · 全局 UI 状态', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.fontSize = ''
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  /* ---- 侧边栏 ---- */
  it('toggleSidebar() 应在折叠与展开之间翻转', () => {
    const app = useAppStore()
    expect(app.sidebarCollapsed).toBe(false)
    app.toggleSidebar()
    expect(app.sidebarCollapsed).toBe(true)
    app.toggleSidebar()
    expect(app.sidebarCollapsed).toBe(false)
  })

  /* ---- 设备类型 ---- */
  it('setDevice() 应能切换三种设备类型', () => {
    const app = useAppStore()
    expect(app.device).toBe('desktop')
    app.setDevice('tablet')
    expect(app.device).toBe('tablet')
    app.setDevice('mobile')
    expect(app.device).toBe('mobile')
  })

  /* ---- 面包屑 ---- */
  it('setBreadcrumb() 应能写入面包屑数组', () => {
    const app = useAppStore()
    app.setBreadcrumb([{ title: '首页', path: '/home' }, { title: '商品广场' }])
    expect(app.breadcrumb.length).toBe(2)
    expect(app.breadcrumb[0].title).toBe('首页')
  })

  /* ---- 主题 ---- */
  it('setTheme(dark) 应同步 html.dark 类名', () => {
    const app = useAppStore()
    app.setTheme('dark')
    expect(app.theme).toBe('dark')
    expect(app.settings.dark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setTheme(light) 应移除 html.dark 类名', () => {
    const app = useAppStore()
    app.setTheme('dark')
    app.setTheme('light')
    expect(app.theme).toBe('light')
    expect(app.settings.dark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setDark() 应同时更新 settings.dark 与 theme（双向同步）', () => {
    const app = useAppStore()
    app.setDark(true)
    expect(app.settings.dark).toBe(true)
    expect(app.theme).toBe('dark')
    app.setDark(false)
    expect(app.settings.dark).toBe(false)
    expect(app.theme).toBe('light')
  })

  /* ---- 字号 ---- */
  it('fontSizePx 应根据字号偏好返回对应像素值（14 / 16 / 18）', () => {
    const app = useAppStore()
    expect(app.fontSizePx).toBe(14)
    app.setFontSize('large')
    expect(app.fontSizePx).toBe(16)
    app.setFontSize('xlarge')
    expect(app.fontSizePx).toBe(18)
  })

  it('setFontSize() 应写入偏好并正确回落到 standard', () => {
    const app = useAppStore()
    app.setFontSize('xlarge')
    expect(app.settings.fontSize).toBe('xlarge')
    app.setFontSize('standard')
    expect(app.fontSizePx).toBe(14)
  })

  /* ---- 偏好项 ---- */
  it('updateSetting() 应更新任意布尔偏好项', () => {
    const app = useAppStore()
    app.updateSetting('allowSearch', false)
    expect(app.settings.allowSearch).toBe(false)
    app.updateSetting('notifyMarketing', true)
    expect(app.settings.notifyMarketing).toBe(true)
  })

  it('updateSetting("dark") 应级联触发主题切换', () => {
    const app = useAppStore()
    app.updateSetting('dark', true)
    expect(app.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('默认偏好应符合产品设定（全部默认开启；营销推送同时控制首页 Banner）', () => {
    const app = useAppStore()
    expect(app.settings.notifyMarketing).toBe(true)
    expect(app.settings.allowSearch).toBe(true)
    // 注：这里刻意不再断言 showOnline —— 在线可见性已迁到账号级设置
    // （t_user.show_online，随 profile 返回），设备级 settings 里不该再有这个字段
    expect(app.settings.personalizedAds).toBe(true)
    expect(app.settings.notifyTrade).toBe(true)
    expect(app.settings.notifySystem).toBe(true)
  })

  /* ---- 缓存 ---- */
  it('cacheSizeText 应在 <1024KB 时以 KB 展示', () => {
    const app = useAppStore()
    app.cacheSize = 128
    expect(app.cacheSizeText).toBe('128 KB')
  })

  it('cacheSizeText 应在 ≥1024KB 时自动换算为 MB', () => {
    const app = useAppStore()
    app.cacheSize = 2048
    expect(app.cacheSizeText).toBe('2.0 MB')
  })

  it('clearCache() 应清除业务缓存但保留登录态', () => {
    const app = useAppStore()
    localStorage.setItem('c2c-cart', '[]')
    localStorage.setItem('c2c-goods-filter', '{}')
    localStorage.setItem('c2c-user', '{"token":"keep-me"}')

    app.clearCache()

    expect(localStorage.getItem('c2c-cart')).toBeNull()
    expect(localStorage.getItem('c2c-goods-filter')).toBeNull()
    expect(localStorage.getItem('c2c-user')).toBe('{"token":"keep-me"}')
    expect(app.cacheSize).toBe(12)
  })
})
