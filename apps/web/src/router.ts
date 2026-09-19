import { useSyncExternalStore } from 'react'

// 两个页面不值得引路由库：/ 新建会话，/s/:id 会话页
const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb)
  return () => window.removeEventListener('popstate', cb)
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => location.pathname)
}

export function navigate(path: string) {
  history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}
