import { ChevronRight } from 'lucide-react'
import type { Session, SessionStatus } from '@agentdeck/shared'
import { formatTime } from '../format'
import styles from './SessionList.module.css'

const statusText: Record<SessionStatus, string> = { running: '运行中', waiting_user: '等待你', idle: '空闲', error: '出错' }

type Props = { sessions: Session[]; activeId?: string; onSelect: (id: string) => void }

// 按工作区分组的会话列表，桌面侧栏与移动端列表页共用（UI 规范 §4）
export function SessionList({ sessions, activeId, onSelect }: Props) {
  const groups = new Map<string, Session[]>()
  for (const s of sessions) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])

  if (sessions.length === 0) return <div className={styles.empty}>还没有会话</div>
  return (
    <div className={styles.list}>
      {[...groups].map(([cwd, items]) => (
        <section key={cwd} className={styles.group}>
          <header className={styles.groupHead}>
            <span className={styles.groupName} title={cwd}>{cwd.split('/').pop()}</span>
            <code className={styles.groupCount}>{items.length}</code>
          </header>
          {items.map((s) => (
            <button key={s.id} type="button" className={styles.item} data-active={s.id === activeId || undefined} onClick={() => onSelect(s.id)}>
              <span className={styles.dot} data-status={s.status} />
              <span className={styles.body}>
                <span className={styles.titleRow}>
                  <span className={styles.title}>{s.title ?? '新会话'}</span>
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
