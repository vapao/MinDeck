import { ChevronRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Session, SessionStatus } from '@agentdeck/shared'
import { api } from '../api'
import { formatTime } from '../format'
import styles from './SessionList.module.css'

const statusText: Record<SessionStatus, string> = { running: 'Running', waiting_user: 'Waiting for you', idle: 'Idle', error: 'Error' }

type Props = { sessions: Session[]; activeId?: string; onSelect: (id: string) => void }

// 按工作区分组的会话列表，桌面侧栏与移动端列表页共用（UI 规范 §4）
export function SessionList({ sessions, activeId, onSelect }: Props) {
  const groups = new Map<string, Session[]>()
  for (const s of sessions) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
  // 分组名优先用项目别名；已移除的工作区退回目录名
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const aliasOf = (cwd: string) => workspaces.data?.find((w) => w.path === cwd)?.alias ?? cwd.split('/').pop()

  if (sessions.length === 0) return <div className={styles.empty}>No sessions yet</div>
  return (
    <div className={styles.list}>
      {[...groups].map(([cwd, items]) => (
        <section key={cwd} className={styles.group}>
          <header className={styles.groupHead}>
            <span className={styles.groupName} title={cwd}>{aliasOf(cwd)}</span>
            <code className={styles.groupCount}>{items.length}</code>
          </header>
          {items.map((s) => (
            <button key={s.id} type="button" className={styles.item} data-active={s.id === activeId || undefined} onClick={() => onSelect(s.id)}>
              <span className={styles.dot} data-status={s.status} />
              <span className={styles.body}>
                <span className={styles.titleRow}>
                  <span className={styles.title}>{s.title ?? 'New session'}</span>
                  <span className={styles.time}>{formatTime(s.updatedAt)}</span>
                </span>
                <span className={styles.metaRow}>
                  <code className={styles.chip}>{s.provider}</code>
                  <span className={styles.status} data-status={s.status}>{statusText[s.status]}</span>
                </span>
              </span>
              <ChevronRight size={16} className={styles.chevron} />
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}
