import { useQuery } from '@tanstack/react-query'
import type { Session } from '@mindeck/shared'
import { api } from '../api'
import { backToTab, navigate } from '../router'
import { dialog } from '../components/Dialog'

// 会话列表没有走 WS：单用户场景下 5s 轮询足够，也避免为侧栏再开一路订阅
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, refetchInterval: 5000, refetchIntervalInBackground: true })

// 正在看的会话被删除 / 归档后，手机回列表；桌面像编辑器关 tab 一样跳到邻居：
// 同项目最近活跃的 Active 会话优先，其次任意 Active 会话；没别的才回首页。sessions 已按 updatedAt 倒序
export function leaveSession(sessions: Session[] | undefined, id: string) {
  if (!window.matchMedia('(min-width: 1024px)').matches) {
    backToTab({ replace: true })
    return
  }
  const cwd = sessions?.find((s) => s.id === id)?.cwd
  const rest = (sessions ?? []).filter((s) => s.id !== id && !s.archivedAt)
  const next = rest.find((s) => s.cwd === cwd) ?? rest[0]
  navigate(next ? `/s/${next.id}` : '/', { replace: true })
}

// 删除前确认；有子会话（含孙会话、子会话的分叉）时让用户选只删这个还是整棵子树。null = 取消
export async function confirmDeleteSession(sessions: Session[] | undefined, id: string): Promise<{ descendants: boolean } | null> {
  const tree = [id]
  for (let i = 0; i < tree.length; i++) tree.push(...(sessions ?? []).filter((s) => s.parentId === tree[i]).map((s) => s.id))
  const count = tree.length - 1
  const message = 'The session and all its history will be deleted permanently.'
  if (!count) return (await dialog.confirm({ title: 'Delete this session?', message, ok: 'Delete', danger: true })) ? { descendants: false } : null
  const descendants = await dialog.confirm({
    title: 'Delete this session?',
    message: `${message} It has ${count} sub-session${count > 1 ? 's' : ''} (including inactive ones); if kept, they stay as standalone sessions.`,
    ok: `Delete with ${count} sub-session${count > 1 ? 's' : ''}`,
    cancel: 'Delete this only',
    danger: true,
  })
  return descendants === null ? null : { descendants }
}
