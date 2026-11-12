import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerMessage, Session, SessionStatus } from '@mindeck/shared'
import { navigate } from '../router'

// 站内提醒：会话列表本来就在 5s 轮询，比对前后状态，窗口在前台时提醒其他会话。
// 系统通知：Hub 在推送手机的同一时机经在线状态 WS 发 notice（见 usePresence），窗口不在前台时用浏览器 Notification 弹出；
// 页面开着（含"添加到程序坞"的 PWA 窗口）就能收到，关掉浏览器收不到——PC 主控端够用。

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
      // 正盯着这个会话时不提醒；窗口不在前台时交给系统通知
      if (isForeground() && s.id !== activeId) {
        const notice = { id: s.id, title: s.title ?? 'New session', text, project: s.cwd.split('/').pop() }
        // eslint-disable-next-line react/set-state-in-effect -- 将轮询得到的外部状态变化追加到临时通知列表。
        setNotices((items) => [...items.filter((item) => item.id !== s.id), notice])
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

// 页面放在后台时，电脑只要醒着且没锁屏就算人在；锁屏靠 IdleDetector（Chromium 才有，要授权一次），合盖由 Hub 的 WS 心跳发现
const device = window.matchMedia('(pointer: fine)').matches ? 'desktop' : 'mobile'

// IdleDetector 不在 TS 的 DOM 类型里
type IdleDetectorInstance = EventTarget & { screenState: 'locked' | 'unlocked' | null; start(options: { threshold: number; signal: AbortSignal }): Promise<void> }
const IdleDetectorApi = device === 'desktop' ? (window as unknown as { IdleDetector?: { new (): IdleDetectorInstance; requestPermission(): Promise<PermissionState> } }).IdleDetector : undefined

/** 电脑上的锁屏检测；requestPermission 必须由用户手势触发，所以由按钮调用 */
export function useScreenLock() {
  const [permission, setPermission] = useState<PermissionState | 'unsupported'>(IdleDetectorApi ? 'prompt' : 'unsupported')
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    if (!IdleDetectorApi) return
    void navigator.permissions.query({ name: 'idle-detection' as PermissionName }).then((status) => setPermission(status.state))
  }, [])

  useEffect(() => {
    if (!IdleDetectorApi || permission !== 'granted') return
    const controller = new AbortController()
    const detector = new IdleDetectorApi()
    detector.addEventListener('change', () => setLocked(detector.screenState === 'locked'))
    // threshold 是"没操作多久算 idle"，最小 60 秒；这里只用锁屏状态
    void detector.start({ threshold: 60_000, signal: controller.signal })
    return () => controller.abort()
  }, [permission])

  const request = () => IdleDetectorApi?.requestPermission().then(setPermission)
  return { permission, locked, request }
}

/** 单独一条 WS 告诉 Hub 这个页面的在线状态，变了就报；连接断开（含合盖后被 Hub 心跳断开）即算离开，见 push.ts */
export function usePresence(locked: boolean) {
  const lockedRef = useRef(locked)
  const report = useRef(() => {})
  // 回到前台时撤掉已弹出的系统通知：macOS 设为"提醒"样式时会一直停在屏幕上
  const shown = useRef(new Set<Notification>())

  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    report.current = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', device, foreground: isForeground(), locked: lockedRef.current }))
    }
    const connect = () => {
      clearTimeout(retryTimer)
      if (stopped || (ws && ws.readyState <= WebSocket.OPEN)) return
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws = socket
      socket.onopen = () => {
        attempts = 0
        report.current()
      }
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage
        if (msg.type !== 'notice' || isForeground() || !notificationsSupported || Notification.permission !== 'granted') return
        // 同 tag 替换旧通知时默认不再横幅提醒；旧通知还留在通知中心就等于静默，所以要 renotify（TS 的 DOM 类型里没有这个字段）
        const n = new Notification(msg.title, { body: msg.body, tag: msg.sessionId, renotify: true } as NotificationOptions)
        shown.current.add(n)
        n.onclose = () => shown.current.delete(n)
        n.onclick = () => {
          window.focus()
          navigate(`/s/${msg.sessionId}`)
          n.close()
        }
      }
      socket.onclose = () => {
        if (!stopped) retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++))
      }
    }
    const changed = () => {
      connect()
      report.current()
      if (isForeground()) for (const n of shown.current) n.close()
    }
    window.addEventListener('focus', changed)
    window.addEventListener('blur', changed)
    window.addEventListener('online', changed)
    document.addEventListener('visibilitychange', changed)
    connect()
    return () => {
      stopped = true
      window.removeEventListener('focus', changed)
      window.removeEventListener('blur', changed)
      window.removeEventListener('online', changed)
      document.removeEventListener('visibilitychange', changed)
      clearTimeout(retryTimer)
      ws?.close()
    }
  }, [])

  useEffect(() => {
    lockedRef.current = locked
    report.current()
  }, [locked])
}
