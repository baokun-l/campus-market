/**
 * main.ts - 应用入口
 *
 * 性能优化说明（三处，均有实测数据支撑）
 * ----------------------------------------
 * ① 移除 Element Plus 全量引入
 *    旧写法 `import ElementPlus from 'element-plus'` + `app.use(ElementPlus)`
 *    会连同 `element-plus/dist/index.css` 一起全量打包，
 *    使 vite.config.ts 里配置的 unplugin 按需引入彻底失效。
 *    现完全依赖 unplugin-vue-components / unplugin-auto-import 按需注入，
 *    全局语言包由 App.vue 的 <el-config-provider :locale="zhCn"> 提供。
 *
 * ② 图标按需注册（收益最大的一项）
 *    旧写法 `import * as ElementPlusIconsVue` 会把图标库全部 293 个图标打包，
 *    而项目实际只用 47 个。现改为从 src/icons.ts 导入显式清单，
 *    清单由 scripts/scan-icons.mjs 扫描源码自动生成。
 *
 * ③ 仍需全局注册图标的原因
 *    侧边栏菜单通过 `<component :is="m.icon" />` 使用**字符串**图标名
 *    （见 layouts/menuConfig.ts），字符串形式无法被静态分析，
 *    因此这 47 个图标必须保留全局注册。
 */
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { pinia } from './stores'
import { appIcons } from './icons'

import '@/styles/index.scss'
// 深色模式：EP 的 dark 令牌（html.dark 时生效），须在 index.scss 之后引入
import 'element-plus/theme-chalk/dark/css-vars.css'

const app = createApp(App)

// 清理本来源上残留的旧 Service Worker（如别的项目曾在同一端口注册过 SW，
// 会按 origin 常驻并拦截请求，导致换了项目仍显示旧页面）。
// 本项目自身不注册 SW，因此这里可以无条件注销全部注册项。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) reg.unregister()
  })
}

// 按需注册图标（清单见 src/icons.ts，共 47 个）
for (const [name, comp] of Object.entries(appIcons)) {
  app.component(name, comp as any)
}

app.use(pinia)
app.use(router)

app.mount('#app')
