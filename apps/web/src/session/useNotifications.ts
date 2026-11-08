import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, SessionStatus } from '@agentdeck/shared'
import { api } from '../api'
import { navigate } from '../router'

// 会话列表本来就在 5s 轮询，比对前后状态后按窗口焦点选择站内提醒或系统通知。
// 用浏览器 Notification API：页面开着（含"添加到程序坞"的 PWA 窗口）就能收到，关掉浏览器收不到——PC 主控端够用。
// 不支持 Notification API 时仍提供站内提醒。

export const notificationsSupported = 'Notification' in window

const outcomes: Partial<Record<SessionStatus, string>> = { waiting_user: 'Waiting for you', idle: 'Finished', error: 'Failed' }

export type SessionNotice = { id: string; title: string; text: string; project: string | undefined }

const isForeground = () => document.visibilityState === 'visible' && document.hasFocus()

export function useNotifications(sessions: Session[] | undefined, activeId: string | undefined) {
  const prev = useRef<Map<string, SessionStatus> | null>(null)
  const [notices, setNotices] = useState<SessionNotice[]>([])
  const dismiss = useCallback((id: string) => setNotices((items) => items.filter((item) => item.id !== id)), [])

  useEffect(() => {
    const dismissActive = () => {
      if (activeId && isForeground()) dismiss(activeId)
    }
    dismissActive()
    window.addEventListener('focus', dismissActive)
    document.addEventListener('visibilitychange', dismissActive)
    return () => {
      window.removeEventListener('focus', dismissActive)
      document.removeEventListener('visibilitychange', dismissActive)
    }
  }, [activeId, dismiss])

  useEffect(() => {
    if (!sessions) return
    const before = prev.current
    prev.current = new Map(sessions.map((s) => [s.id, s.status]))
    // 首次拿到列表只记录基线
    if (!before) return
    for (const s of sessions) {
      const was = before.get(s.id)
      // 只通知一轮"在跑"之后的落点（等待审批 / 完成 / 出错）；idle → running 不值得打扰
      if (was !== 'running' && was !== 'waiting_user') continue
      const text = outcomes[s.status]
      if (!text || s.status === was) continue
      // 正盯着这个会话且窗口在前台时不弹
      if (isForeground()) {
        if (s.id !== activeId) {
          const notice = { id: s.id, title: s.title ?? 'New session', text, project: s.cwd.split('/').pop() }
          // eslint-disable-next-line react/set-state-in-effect -- 将轮询得到的外部状态变化追加到临时通知列表。
          setNotices((items) => [...items.filter((item) => item.id !== s.id), notice])
        }
        continue
      }
      if (!notificationsSupported || Notification.permission !== 'granted') continue
      const n = new Notification(`${s.title ?? 'New session'} · ${text}`, { body: s.cwd.split('/').pop(), tag: s.id })
      n.onclick = () => {
        window.focus()
        navigate(`/s/${s.id}`)
        n.close()
      }
    }
  }, [sessions, activeId])

  return { notices, dismiss }
}

/** 通知权限；requestPermission 必须由用户手势触发，所以由按钮调用 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission>(() => (notificationsSupported ? Notification.permission : 'denied'))
  const request = () => Notification.requestPermission().then(setPermission)
  return { permission, request }
}

const clientId = crypto.randomUUID()

/** 在前台时每 10 秒告诉 Hub 一次，离开前台立刻告诉它：有设备在前台，Hub 就不推送到手机 */
export function usePresence() {
  useEffect(() => {
    let visible: boolean | null = null
    const report = () => {
      const now = isForeground()
      // 前台时重复上报续期；不在前台只报一次
      if (!now && visible === false) return
      visible = now
      void api.presence({ clientId, visible: now }).catch(() => {})
    }
    report()
    const timer = setInterval(report, 10_000)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    document.addEventListener('visibilitychange', report)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      document.removeEventListener('visibilitychange', report)
    }
  }, [])
}
