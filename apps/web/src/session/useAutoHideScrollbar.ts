import { useEffect, type RefObject } from 'react'

export function useAutoHideScrollbar(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current!
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
