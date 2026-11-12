import { useEffect, useSyncExternalStore } from 'react'
import type { Session } from '@mindeck/shared'

// "跑完了但还没看过"按浏览器记在 localStorage（会话 id → 上次看到时的 updatedAt），不动服务端：
// 桌面浏览器是主控端，跨设备的已读同步不值得加表加接口。判定与 useNotifications 的"正盯着就不弹"同一条规则。

const seenKey = 'mindeck.seen'
const listeners = new Set<() => void>()
let cache: string = localStorage.getItem(seenKey) ?? '{}'
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSeen(): Record<string, string> {
  return JSON.parse(useSyncExternalStore(subscribe, () => cache))
}

/** idle 且状态变更晚于上次看到。从没看过的（别的设备建的）不算未读，否则一打开全是 Done */
export function isUnread(s: Session, seen: Record<string, string>) {
  return s.status === 'idle' && seen[s.id] !== undefined && s.updatedAt > seen[s.id]
}

/** 正在看某个会话且窗口在前台时，跟着列表轮询把它标为已看；顺手清掉已删除会话的记录 */
export function useMarkSeen(sessions: Session[] | undefined, activeId: string | undefined) {
  useEffect(() => {
    if (!sessions || !activeId) return
    const mark = () => {
      const active = sessions.find((s) => s.id === activeId)
      if (!active || document.visibilityState !== 'visible') return
      const seen: Record<string, string> = JSON.parse(cache)
      const next = Object.fromEntries(sessions.filter((s) => s.id in seen).map((s) => [s.id, seen[s.id]]))
      next[active.id] = active.updatedAt
      cache = JSON.stringify(next)
      localStorage.setItem(seenKey, cache)
      for (const cb of listeners) cb()
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [sessions, activeId])
}
