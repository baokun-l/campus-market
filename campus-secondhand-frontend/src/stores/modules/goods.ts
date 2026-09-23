/**
 * 商品业务状态：列表筛选条件
 */
import { defineStore } from 'pinia'

interface State {
  filter: {
    keyword: string
    categoryId: number | null
    sort: 'new' | 'price_asc' | 'price_desc' | 'hot'
  }
}

export const useGoodsStore = defineStore('goods', {
  state: (): State => ({
    filter: { keyword: '', categoryId: null, sort: 'new' }
  }),
  actions: {
    setFilter(patch: Partial<State['filter']>) {
      this.filter = { ...this.filter, ...patch }
    },
    reset() { this.filter = { keyword: '', categoryId: null, sort: 'new' } }
  },
  persist: { key: 'c2c-goods-filter', storage: sessionStorage }
})
