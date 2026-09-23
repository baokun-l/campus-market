/**
 * Vitest 全局测试初始化
 * - 补全 happy-dom 缺失的浏览器 API（ResizeObserver / matchMedia）
 * - 每个用例前重置 localStorage，避免测试间互相污染
 */
import { beforeEach, vi } from 'vitest'

// happy-dom 未实现 ResizeObserver，Element Plus 的 el-table / ECharts 会用到
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub

// happy-dom 未实现 matchMedia
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

// ECharts 在 happy-dom 下没有真实 canvas，测试中直接跳过渲染
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any

beforeEach(() => {
  localStorage.clear()
})
