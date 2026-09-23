/**
 * 浮层焦点归还的测试。
 *
 * 锁的是一类**很难复现、但真实存在**的交互故障：
 * Element Plus 的浮层关闭后，焦点会留在浮层内部的哨兵元素
 * （`.el-drawer__sr-focus`）上；此后点击页面上任何 `el-select`，
 * 展开动作都会被一次迟到的 blur 立刻撤销 —— 用户看到的就是「点一下没反应」。
 *
 * 现场证据（`scripts/diag-focus.cjs`）：
 *   activeElement = SPAN.el-drawer__sr-focus → 点下拉 open=0
 *   activeElement.blur() → 再点下拉 open=1
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { releaseOverlayFocus } from '@/utils/focus'

/** 造一个能收焦点的元素（tabindex=-1 即可，与 EP 的哨兵一致） */
function focusable(className: string, parent?: HTMLElement): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.tabIndex = -1
  ;(parent ?? document.body).appendChild(el)
  el.focus()
  return el
}

let created: HTMLElement[] = []
beforeEach(() => {
  created = []
})
afterEach(() => {
  created.forEach((el) => el.remove())
  document.body.className = ''
})

function make(className: string, parent?: HTMLElement): HTMLElement {
  const el = focusable(className, parent)
  created.push(el)
  return el
}

describe('releaseOverlayFocus()', () => {
  it('焦点在浮层哨兵（__sr-focus）上时应归还给 body', () => {
    const sentinel = make('el-drawer__sr-focus')
    expect(document.activeElement).toBe(sentinel)
    releaseOverlayFocus()
    expect(document.activeElement).toBe(document.body)
  })

  it('焦点在一个「已不可见的浮层」内时应归还', () => {
    const overlay = document.createElement('div')
    overlay.className = 'el-overlay'
    // happy-dom 下 getBoundingClientRect() 恒为 0，等价于「浮层已隐藏」
    document.body.appendChild(overlay)
    created.push(overlay)
    const inner = make('el-input__inner', overlay)
    expect(document.activeElement).toBe(inner)
    releaseOverlayFocus()
    expect(document.activeElement).toBe(document.body)
  })

  it('焦点在普通输入框上（不在任何浮层内）时不应打断用户输入', () => {
    const input = make('el-input__inner')
    expect(document.activeElement).toBe(input)
    releaseOverlayFocus()
    expect(document.activeElement).toBe(input)
  })

  it('焦点已在 body 上时应是幂等的空操作', () => {
    document.body.focus()
    expect(() => releaseOverlayFocus()).not.toThrow()
    releaseOverlayFocus()
    expect(document.activeElement).toBe(document.body)
  })
})
