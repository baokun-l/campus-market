/**
 * 购物车（临时收藏，未登录自动用匿名 ID）
 *
 * 价格语义：条目同时记「挂牌价」与「让利价」，
 *   - `price`     加入购物车时的**实付单价**（= promoPrice ?? listPrice），下单金额以它为准；
 *   - `listPrice` 卖家挂牌价，用于展示划线价与「已省」金额。
 *
 * 之所以要把两个价格都存下来：让利价是活动期价格，卖家随时可以改；
 * 购物车里必须保留加入时的快照，否则总价会莫名其妙地跳变。
 */
import { defineStore } from 'pinia'
import { resolveStock, MAX_ORDER_QUANTITY } from '@/utils/goods'

interface CartItem {
  goodsId: number
  title: string
  /** 卖家挂牌价 */
  listPrice: number
  /** 卖家让利后的活动价；未参与活动时为 undefined */
  promoPrice?: number
  /** 实付单价（加入时的让利价，无让利则为挂牌价） */
  price: number
  /**
   * 可售数量快照（加入购物车那一刻商品的可售数量）。
   * 数量选择器必须以它为上限 —— 不记它就会出现「加购 3 件、卖家只有 1 件」的订单。
   */
  stock: number
  cover: string
  quantity: number
  addedAt: number
}

interface State {
  items: CartItem[]
}

/** 把数量夹到 [1, min(库存, 单笔上限)] 区间 */
function clampQty(qty: number, stock: number): number {
  const max = Math.max(1, Math.min(resolveStock({ stock }), MAX_ORDER_QUANTITY))
  return Math.min(Math.max(1, Math.floor(qty || 1)), max)
}

export const useCartStore = defineStore('cart', {
  state: (): State => ({ items: [] }),
  getters: {
    totalCount: (s) => s.items.reduce((acc, i) => acc + i.quantity, 0),
    /** 实付合计 */
    totalPrice: (s) => s.items.reduce((acc, i) => acc + i.quantity * i.price, 0),
    /** 挂牌价合计 */
    listTotal: (s) => s.items.reduce((acc, i) => acc + i.quantity * i.listPrice, 0),
    /** 因活动让利省下的金额 */
    savedTotal: (s): number =>
      s.items.reduce((acc, i) => acc + i.quantity * Math.max(0, i.listPrice - i.price), 0),
    /** 是否含让利商品 */
    hasPromo: (s): boolean => s.items.some((i) => i.price < i.listPrice)
  },
  actions: {
    /** 某条目最多能买几件（供模板给输入框设 max） */
    maxQtyOf(goodsId: number): number {
      const it = this.items.find((x) => x.goodsId === goodsId)
      return it ? clampQty(Number.MAX_SAFE_INTEGER, it.stock) : 1
    },
    add(item: CartItem) {
      const stock = resolveStock(item)
      const exist = this.items.find((x) => x.goodsId === item.goodsId)
      if (exist) {
        // 已在车里：累加但不得突破可售数量（否则会结算出买不到的数量）
        exist.stock = stock
        exist.quantity = clampQty(exist.quantity + item.quantity, stock)
      } else {
        this.items.unshift({ ...item, stock, quantity: clampQty(item.quantity, stock) })
      }
    },
    remove(goodsId: number) {
      this.items = this.items.filter((x) => x.goodsId !== goodsId)
    },
    clear() { this.items = [] },
    /** 直接设定数量（el-input-number 的 v-model 走这里，保证夹取逻辑统一） */
    setQty(goodsId: number, quantity: number) {
      const it = this.items.find((x) => x.goodsId === goodsId)
      if (!it) return
      it.quantity = clampQty(quantity, it.stock)
    },
    changeQty(goodsId: number, delta: number) {
      const it = this.items.find((x) => x.goodsId === goodsId)
      if (!it) return
      it.quantity = clampQty(it.quantity + delta, it.stock)
    }
  },
  // v3：条目新增 stock（数量上限），旧存档没有该字段会让上限退化为 1，直接换 key 重建
  persist: { key: 'c2c-cart-v3', storage: localStorage }
})
