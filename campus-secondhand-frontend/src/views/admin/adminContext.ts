/**
 * 管理后台的「跨面板上下文」
 *
 * 为什么用 provide/inject 而不是逐层传 props：
 *   外壳用 <component :is> 动态切换 10 个面板，若把 props 直接写在动态组件上，
 *   没声明该 prop 的面板会把它当成「透传属性」渲染到根 DOM 上（outline 溢出成
 *   莫名的 HTML 属性）。改成注入后，需要的人自己取，不需要的人完全无感。
 *
 * 目前只放「全局共享且频繁变化」的两样东西：看板总览数据、页签跳转能力。
 */
import type { InjectionKey, Ref } from 'vue'
import type { AdminOverview } from '@/api/analytics'

export interface AdminContext {
  /** 看板总览（待办 / GMV / 用户与订单规模），外壳统一拉取 */
  overview: Ref<AdminOverview | null>
  overviewLoading: Ref<boolean>
  /** 主动重拉总览（看板刷新按钮、跨页签操作后同步角标） */
  refreshOverview: () => Promise<void>
  /** 跳到指定页签（看板待办卡点击直达） */
  goTab: (key: string) => void
}

export const ADMIN_CONTEXT: InjectionKey<AdminContext> = Symbol('admin-context')
