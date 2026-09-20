import { useEffect, useRef, useState } from 'react'
import type { Session, SessionStatus } from '@agentdeck/shared'
import { navigate } from '../router'

// 会话状态变化时弹系统通知。会话列表本来就在 5s 轮询，这里比对前后状态即可，不为通知再开一路 WS 订阅。
// 用浏览器 Notification API：页面开着（含"添加到程序坞"的 PWA 窗口）就能收到，关掉浏览器收不到——PC 主控端够用。
// iOS Safari 没有这个 API，supported 为 false 时整个功能不出现。

export const notificationsSupported = 'Notification' in window

const outcomes: Partial<Record<SessionStatus, string>> = { waiting_user: 'Waiting for you', idle: 'Finished', error: 'Failed' }

export function useNotifications(sessions: Session[] | undefined, activeId: string | undefined) {
  const prev = useRef<Map<string, SessionStatus> | null>(null)
  useEffect(() => {
    if (!sessions) return
    const before = prev.current
    prev.current = new Map(sessions.map((s) => [s.id, s.status]))
    // 首次拿到列表只记录基线
    if (!before || !notificationsSupported || Notification.permission !== 'granted') return
    for (const s of sessions) {
      const was = before.get(s.id)
      // 只通知一轮"在跑"之后的落点（等待审批 / 完成 / 出错）；idle → running 不值得打扰
      if (was !== 'running' && was !== 'waiting_user') continue
      const text = outcomes[s.status]
      if (!text || s.status === was) continue
      // 正盯着这个会话且窗口在前台时不弹
      if (s.id === activeId && document.visibilityState === 'visible') continue
      const n = new Notification(`${s.title ?? 'New session'} · ${text}`, { body: s.cwd.split('/').pop(), tag: s.id })
      n.onclick = () => {
        window.focus()
        navigate(`/s/${s.id}`)
        n.close()
      }
    }
  }, [sessions, activeId])
}

/** 通知权限；requestPermission 必须由用户手势触发，所以由按钮调用 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission>(() => (notificationsSupported ? Notification.permission : 'denied'))
  const request = () => Notification.requestPermission().then(setPermission)
  return { permission, request }
}
