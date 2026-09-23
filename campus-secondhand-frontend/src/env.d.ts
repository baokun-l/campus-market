/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * Element Plus 的语言包是 `.mjs` 直出文件，包本身没带类型声明，
 * TS 在 `strict` 下会报 TS7016（「隐式 any」）—— App.vue 引 zh-cn 就卡在这。
 * 官方推荐的用法就是自己补一条声明，这里按实际用到的形状声明成 Language 对象。
 */
declare module 'element-plus/dist/locale/*.mjs' {
  import type { Language } from 'element-plus/es/locale'
  const lang: Language
  export default lang
}

interface ImportMetaEnv {
  /** axios 的 baseURL（相对前缀，如 /api） */
  readonly VITE_API_BASE: string
  /** Vite dev server 代理目标（后端服务的源，如 http://localhost:8080） */
  readonly VITE_API_PROXY?: string
  readonly VITE_USE_MOCK: 'true' | 'false'
  readonly VITE_APP_TITLE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
