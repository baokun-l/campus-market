/**
 * Pinia Store 单元测试 · 购物车
 * 验证：添加 / 去重累加 / 删除 / 数量变更 / 总价计算 / 清空
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useCartStore } from '@/stores/modules/cart'

/**
 * @param price     实付单价
 * @param quantity  数量
 * @param listPrice 挂牌价，默认与实付价相同（即未参与活动）
 * @param stock     可售数量快照，默认 99 —— 数量加减的用例不想被库存上限干扰，
 *                  库存夹取另有专门的用例覆盖
 */
const item = (goodsId: number, price = 100, quantity = 1, listPrice = price, stock = 99) => ({
  goodsId,
  title: `商品${goodsId}`,
  listPrice,
  promoPrice: price < listPrice ? price : undefined,
  price,
  stock,
  cover: '',
  quantity,
  addedAt: Date.now()
})

describe('useCartStore · 购物车状态管理', () => {
  beforeEach(() => {
    localStorage.clear()
    // 注意：Pinia v2 只有在 pinia 被 app.use() 安装后才会真正执行插件，
    // 否则插件会被暂存到 toBeInstalled。这里模拟 main.ts 的注册顺序。
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  it('初始状态应为空购物车', () => {
    const cart = useCartStore()
    expect(cart.items).toEqual([])
    expect(cart.totalCount).toBe(0)
    expect(cart.totalPrice).toBe(0)
  })

  it('add() 应能把新商品加入购物车', () => {
    const cart = useCartStore()
    cart.add(item(1))
    expect(cart.items.length).toBe(1)
    expect(cart.items[0].goodsId).toBe(1)
  })

  it('重复 add() 同一商品应累加数量而非新增一行（去重逻辑）', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 2))
    cart.add(item(1, 100, 3))
    expect(cart.items.length).toBe(1)
    expect(cart.items[0].quantity).toBe(5)
  })

  it('add() 不同商品应各自占一行', () => {
    const cart = useCartStore()
    cart.add(item(1))
    cart.add(item(2))
    expect(cart.items.length).toBe(2)
  })

  it('新加入的商品应排在列表最前（unshift 行为）', () => {
    const cart = useCartStore()
    cart.add(item(1))
    cart.add(item(2))
    expect(cart.items[0].goodsId).toBe(2)
  })

  it('totalCount 应为所有商品数量之和', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 2))
    cart.add(item(2, 50, 3))
    expect(cart.totalCount).toBe(5)
  })

  it('totalPrice 应按「单价 × 数量」累加计算', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 2))
    cart.add(item(2, 50, 3))
    expect(cart.totalPrice).toBe(350)
  })

  it('totalPrice 应正确保留小数（浮点金额场景）', () => {
    const cart = useCartStore()
    cart.add(item(1, 19.9, 3))
    expect(cart.totalPrice).toBeCloseTo(59.7, 5)
  })

  it('remove() 应删除指定商品', () => {
    const cart = useCartStore()
    cart.add(item(1))
    cart.add(item(2))
    cart.remove(1)
    expect(cart.items.length).toBe(1)
    expect(cart.items[0].goodsId).toBe(2)
  })

  it('remove() 不存在的商品不应影响现有数据', () => {
    const cart = useCartStore()
    cart.add(item(1))
    cart.remove(999)
    expect(cart.items.length).toBe(1)
  })

  it('changeQty() 应按 delta 增减数量', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 5))
    cart.changeQty(1, 2)
    expect(cart.items[0].quantity).toBe(7)
    cart.changeQty(1, -3)
    expect(cart.items[0].quantity).toBe(4)
  })

  it('changeQty() 数量不应低于 1（防止出现 0 或负数）', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 1))
    cart.changeQty(1, -99)
    expect(cart.items[0].quantity).toBe(1)
  })

  it('changeQty() 操作不存在的商品应静默返回', () => {
    const cart = useCartStore()
    expect(() => cart.changeQty(999, 1)).not.toThrow()
  })

  it('clear() 应清空全部商品', () => {
    const cart = useCartStore()
    cart.add(item(1))
    cart.add(item(2))
    cart.clear()
    expect(cart.items.length).toBe(0)
    expect(cart.totalCount).toBe(0)
  })

  it('购物车数据应持久化到 localStorage（key = c2c-cart-v3）', async () => {
    const cart = useCartStore()
    cart.add(item(1))
    await new Promise((r) => setTimeout(r, 0))
    const raw = localStorage.getItem('c2c-cart-v3')
    expect(raw).toBeTruthy()
  })

  /* ==================== 可售数量（库存）上限 ====================
   * 需求背景：卖家发布时要填可售数量，购物车数量选择器必须以它为上限，
   * 否则会出现「加购 3 件、卖家只有 1 件」这种无法履约的订单。 */

  it('add() 数量超过库存时应夹到库存值', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 5, 100, 2))
    expect(cart.items[0].quantity).toBe(2)
  })

  it('重复 add() 累加后仍不得超过库存', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 1, 100, 3))
    cart.add(item(1, 100, 5, 100, 3))
    expect(cart.items.length).toBe(1)
    expect(cart.items[0].quantity).toBe(3)
  })

  it('未填库存（旧数据）时上限退化为 1', () => {
    const cart = useCartStore()
    const raw = item(1, 100, 9)
    delete (raw as { stock?: number }).stock
    cart.add(raw)
    expect(cart.items[0].quantity).toBe(1)
  })

  it('maxQtyOf() 应返回该商品的可售数量', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 1, 100, 4))
    expect(cart.maxQtyOf(1)).toBe(4)
    // 不在车里的商品给一个安全默认值，避免输入框拿到 0 / undefined
    expect(cart.maxQtyOf(999)).toBe(1)
  })

  it('setQty() 直接设值同样受库存上限约束', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 1, 100, 3))
    cart.setQty(1, 10)
    expect(cart.items[0].quantity).toBe(3)
    cart.setQty(1, 0)
    expect(cart.items[0].quantity).toBe(1)
    cart.setQty(1, 2)
    expect(cart.items[0].quantity).toBe(2)
  })

  it('setQty() 操作不存在的商品应静默返回', () => {
    const cart = useCartStore()
    expect(() => cart.setQty(999, 2)).not.toThrow()
  })

  /* ==================== 让利价（挂牌价 / 实付价双快照） ==================== */

  it('listTotal 应为「挂牌价 × 数量」之和，与实付合计区分开', () => {
    const cart = useCartStore()
    cart.add(item(1, 80, 2, 100)) // 挂牌 100，让利后 80
    cart.add(item(2, 50, 1))      // 未参与活动
    expect(cart.listTotal).toBe(250)
    expect(cart.totalPrice).toBe(210)
  })

  it('savedTotal 应等于挂牌合计减实付合计', () => {
    const cart = useCartStore()
    cart.add(item(1, 80, 2, 100))
    cart.add(item(2, 50, 1))
    expect(cart.savedTotal).toBeCloseTo(cart.listTotal - cart.totalPrice, 5)
    expect(cart.savedTotal).toBe(40)
  })

  it('未参与活动（无让利）时 savedTotal 应为 0，hasPromo 为 false', () => {
    const cart = useCartStore()
    cart.add(item(1, 100, 2))
    expect(cart.savedTotal).toBe(0)
    expect(cart.hasPromo).toBe(false)
  })

  it('只要有任一条目发生让利，hasPromo 即为 true', () => {
    const cart = useCartStore()
    cart.add(item(1, 100))
    cart.add(item(2, 80, 1, 100))
    expect(cart.hasPromo).toBe(true)
  })

  it('挂牌价低于实付价（脏数据）时 savedTotal 不应为负数', () => {
    const cart = useCartStore()
    cart.add(item(1, 120, 1, 100))
    expect(cart.savedTotal).toBe(0)
  })

  it('让利条目加入同一商品应累加数量而不是覆盖', () => {
    const cart = useCartStore()
    cart.add(item(1, 80, 1, 100))
    cart.add(item(1, 80, 2, 100))
    expect(cart.items.length).toBe(1)
    expect(cart.items[0].quantity).toBe(3)
    expect(cart.savedTotal).toBe(60)
  })
})
