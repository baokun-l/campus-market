/**
 * Pinia 全局 store 入口
 */
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

export const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

export { useUserStore } from './modules/user'
export { useAppStore } from './modules/app'
export { useGoodsStore } from './modules/goods'
export { useCartStore } from './modules/cart'
export { useMessageStore } from './modules/message'
