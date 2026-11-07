import { useEffect, type RefObject } from 'react'

export function useAutoHideScrollbar(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    // Inbox 手机详情页不渲染列表，直接以详情挂载时（从会话页后退）ref 为空
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout>
    el.setAttribute('data-auto-hide-scrollbar', '')
    const show = () => {
      el.setAttribute('data-scrolling', '')
      clearTimeout(timer)
      timer = setTimeout(() => el.removeAttribute('data-scrolling'), 800)
    }
    el.addEventListener('scroll', show, { passive: true })
    return () => {
      clearTimeout(timer)
      el.removeEventListener('scroll', show)
      el.removeAttribute('data-auto-hide-scrollbar')
      el.removeAttribute('data-scrolling')
    }
  }, [ref])
}
