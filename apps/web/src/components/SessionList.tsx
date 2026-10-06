import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Trash2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session, SessionStatus } from '@agentdeck/shared'
import { api } from '../api'
import { formatTime } from '../format'
import { navigate } from '../router'
import { dialog } from './Dialog'
import { isUnread, useSeen } from '../session/seen'
import { useDraftSessions } from '../session/drafts'
import { leaveSession } from '../session/useSessions'
import { useMediaQuery } from '../session/useMediaQuery'
import { useServices } from './ServicesPanel'
import styles from './SessionList.module.css'

// idle 不显示：空闲是常态，逐行写 Idle 只是噪音；跑完还没看过的显示 Done
const statusText: Record<Exclude<SessionStatus, 'idle'>, string> = { running: 'Running', waiting_user: 'Waiting for you', error: 'Error' }

// 折叠状态按 cwd 记在 localStorage，桌面侧栏与移动端列表页共享
const collapsedKey = 'agentdeck.collapsed'
const listeners = new Set<() => void>()
let collapsedCache: string = localStorage.getItem(collapsedKey) ?? '[]'
const readCollapsed = () => collapsedCache
const subscribeCollapsed = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function toggleCollapsed(cwd: string) {
  const set = new Set<string>(JSON.parse(collapsedCache))
  if (!set.delete(cwd)) set.add(cwd)
  collapsedCache = JSON.stringify([...set])
  localStorage.setItem(collapsedKey, collapsedCache)
  for (const cb of listeners) cb()
}

type Tab = 'active' | 'inactive'

// 「Active / Inactive」两个页签，同一套分组列表：Active 是日常工作区，行上可归档；Inactive 是归档区，行上可恢复 / 永久删除。
// 桌面侧栏与移动端列表页共用（UI 规范 §4）
export function SessionTabs({ sessions, activeId }: { sessions: Session[]; activeId?: string }) {
  const [tab, setTab] = useState<Tab>('active')
  // 手机端行操作是常显的：Active 行上的「移到 Inactive」只是噪音，手机只做看与回复，收纳在桌面做
  const desktop = useMediaQuery('(min-width: 1024px)')
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sessions'] })
  // 归档失败（如刚跑起来 409）只提示；正在看的会话被归档 / 删除就跳到邻居会话
  const setArchived = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.updateSession(id, { archived }),
    onSuccess: (_, { id, archived }) => {
      invalidate()
      if (archived && id === activeId) leaveSession(sessions, id)
    },
    onError: (err) => dialog.alert({ title: 'Archive failed', message: err.message }),
  })
  const remove = useMutation({
    mutationFn: api.deleteSession,
    onSuccess: (_, id) => {
      invalidate()
      if (id === activeId) leaveSession(sessions, id)
    },
    onError: (err) => dialog.alert({ title: 'Delete failed', message: err.message }),
  })
  const onRemove = async (id: string) => {
    if (await dialog.confirm({ title: 'Delete this session?', message: 'The session and all its history will be deleted permanently.', ok: 'Delete', danger: true })) remove.mutate(id)
  }
  const actions = (s: Session): Action[] =>
    tab === 'active'
      ? desktop && (s.status === 'idle' || s.status === 'error')
        ? [{ icon: <EyeOff size={14} />, label: 'Move to inactive', onClick: () => setArchived.mutate({ id: s.id, archived: true }) }]
        : []
      : [
          { icon: <Eye size={14} />, label: 'Move back to active', onClick: () => setArchived.mutate({ id: s.id, archived: false }) },
          { icon: <Trash2 size={14} />, label: 'Delete permanently', danger: true, onClick: () => onRemove(s.id) },
        ]

  return (
    <>
      <div className={styles.tabs} role="tablist">
        {(['active', 'inactive'] as const).map((t) => (
          <button key={t} type="button" role="tab" className={styles.tab} aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'active' ? 'Active' : 'Inactive'}
          </button>
        ))}
      </div>
      <SessionList sessions={sessions.filter((s) => (tab === 'active') !== Boolean(s.archivedAt))} activeId={activeId} onSelect={(id) => navigate(`/s/${id}`)} actions={actions} empty={tab === 'active' ? 'No active sessions' : 'No inactive sessions'} />
    </>
  )
}

type Action = { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }
type Props = { sessions: Session[]; activeId?: string; onSelect: (id: string) => void; actions: (s: Session) => Action[]; empty: string }

// 按工作区分组：分组按组内最近活动排；折叠后仍露出运行中、等待、未读完成和有草稿的会话
function SessionList({ sessions, activeId, onSelect, actions, empty }: Props) {
  const collapsed = new Set<string>(JSON.parse(useSyncExternalStore(subscribeCollapsed, readCollapsed)))
  const seen = useSeen()
  const drafts = useDraftSessions(sessions)
  const needsAttention = (s: Session) => s.status === 'running' || s.status === 'waiting_user' || !!s.backgroundTasks || isUnread(s, seen) || drafts.has(s.id)
  const groups = new Map<string, Session[]>()
  // sessions 已按 updatedAt 倒序，首次出现的顺序就是分组顺序
  for (const s of sessions) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
  // 分组名优先用项目别名；已移除的工作区退回目录名
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const aliasOf = (cwd: string) => workspaces.data?.find((w) => w.path === cwd)?.alias ?? cwd.split('/').pop()
  const services = useServices()
  const servicesRunning = (cwd: string) => services.data?.some((s) => s.running && s.workspaceId === workspaces.data?.find((w) => w.path === cwd)?.id)

  if (groups.size === 0) return <div className={styles.empty}>{empty}</div>
  return (
    <div className={styles.list}>
      {[...groups].map(([cwd, items]) => {
        const isCollapsed = collapsed.has(cwd)
        const visible = isCollapsed ? items.filter(needsAttention) : items
        return (
          <section key={cwd} className={styles.group}>
            <button type="button" className={styles.groupHead} onClick={() => toggleCollapsed(cwd)} aria-expanded={!isCollapsed}>
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span className={styles.groupName} title={cwd}>{aliasOf(cwd)}</span>
              {servicesRunning(cwd) && <span className={styles.serviceDot} title="Services running" />}
              <code className={styles.groupCount}>{items.length}</code>
            </button>
            {visible.map((s) => (
              <div key={s.id} className={styles.row}>
                <button type="button" className={styles.item} data-active={s.id === activeId || undefined} onClick={() => onSelect(s.id)}>
                  <span className={styles.body}>
                    <span className={styles.titleRow}>
                      <span className={styles.title}>{s.title ?? 'New session'}</span>
                      {drafts.has(s.id) && <span className={styles.draft} title="Unsent draft">Draft</span>}
                      <span className={styles.time}>{formatTime(s.updatedAt)}</span>
                    </span>
                    <span className={styles.metaRow}>
                      <code className={styles.chip}>{s.provider}</code>
                      {s.status === 'idle' && s.backgroundTasks ? (
                        <span className={styles.status} data-status="running">Background</span>
                      ) : s.status === 'idle' ? (
                        isUnread(s, seen) && <span className={styles.status} data-status="done">Done</span>
                      ) : (
                        <span className={styles.status} data-status={s.status}>{statusText[s.status]}</span>
                      )}
                    </span>
                  </span>
                  <ChevronRight size={16} className={styles.chevron} />
                </button>
                <span className={styles.actions}>
                  {actions(s).map((a) => (
                    <button key={a.label} type="button" className={styles.action} data-danger={a.danger || undefined} onClick={a.onClick} aria-label={a.label} title={a.label}>
                      {a.icon}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
