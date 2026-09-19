import { useRef, useState, type PointerEvent } from 'react'
import styles from './Resizer.module.css'

// 侧栏宽度拖动：把手贴在面板内缘，指针捕获后随手指移动改宽度，松手时记进 localStorage。
// side 是面板在页面的哪一侧：left 的把手在右缘，向右拖变宽；right 反之。

export function useResizable(key: string, fallback: number, min: number, max: number, side: 'left' | 'right') {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(`width:${key}`))
    return saved >= min && saved <= max ? saved : fallback
  })
  const drag = useRef<{ x: number; w: number; next: number } | null>(null)
  const handle = {
    className: styles.handle,
    'data-side': side,
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, w: width, next: width }
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      if (!drag.current) return
      const delta = e.clientX - drag.current.x
      drag.current.next = Math.min(max, Math.max(min, drag.current.w + (side === 'left' ? delta : -delta)))
      setWidth(drag.current.next)
    },
    onPointerUp() {
      if (!drag.current) return
      localStorage.setItem(`width:${key}`, String(drag.current.next))
      drag.current = null
    },
  }
  return { width, handle }
}
