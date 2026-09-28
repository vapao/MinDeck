import { useQuery } from '@tanstack/react-query'
import type { Session } from '@agentdeck/shared'
import { api } from '../api'
import { navigate } from '../router'

// 会话列表没有走 WS：单用户场景下 5s 轮询足够，也避免为侧栏再开一路订阅
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, refetchInterval: 5000 })

// 正在看的会话被删除 / 归档后的落点：像编辑器关 tab 一样跳到邻居——同项目最近活跃的 Active 会话优先，
// 其次任意 Active 会话；列表里没别的了才回首页。sessions 已按 updatedAt 倒序
export function leaveSession(sessions: Session[] | undefined, id: string) {
  const cwd = sessions?.find((s) => s.id === id)?.cwd
  const rest = (sessions ?? []).filter((s) => s.id !== id && !s.archivedAt)
  const next = rest.find((s) => s.cwd === cwd) ?? rest[0]
  navigate(next ? `/s/${next.id}` : '/', { replace: true })
}
