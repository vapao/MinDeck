import { useSyncExternalStore } from 'react'

// 几个页面不值得引路由库：/ 列表，/s/:id 会话页，/workspaces 项目管理，/schedules 定时任务，/settings 设置
const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb)
  return () => window.removeEventListener('popstate', cb)
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => location.pathname)
}

// replace：当前页已失效（会话被删 / 被归档离开）时替换掉这条历史，否则返回键会回到死页面再被弹走
export function navigate(path: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}
