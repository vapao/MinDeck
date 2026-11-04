import { useSyncExternalStore } from 'react'

// 几个页面不值得引路由库：/ Inbox（/inbox/:kind/:id 选中某项），/sessions 会话列表（手机），/s/:id 会话页，/workspaces 项目管理，/schedules 定时任务，/settings 设置
const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb)
  return () => window.removeEventListener('popstate', cb)
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => location.pathname)
}

// 手机底部 tab 的三个顶层页。会话、项目、设置页的返回键回到最近停留的那个，而不是一律回首页
export const tabPaths = ['/', '/sessions', '/schedules']
let lastTab = tabPaths.includes(location.pathname) ? location.pathname : '/'
addEventListener('popstate', () => {
  if (tabPaths.includes(location.pathname)) lastTab = location.pathname
})
export const backToTab = (options?: { replace?: boolean }) => navigate(lastTab, options)

// replace：当前页已失效（会话被删 / 被归档离开）时替换掉这条历史，否则返回键会回到死页面再被弹走
export function navigate(path: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}
