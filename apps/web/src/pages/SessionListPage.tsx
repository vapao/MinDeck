import { AlertTriangle, FolderOpen, Plus, Settings } from 'lucide-react'
import { navigate } from '../router'
import { useSessions } from '../session/useSessions'
import { SessionList } from '../components/SessionList'
import styles from './SessionListPage.module.css'

// 移动端会话列表（UI 规范 §4 移动）
export function SessionListPage() {
  const sessions = useSessions()
  const waiting = (sessions.data ?? []).filter((s) => s.status === 'waiting_user').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        AgentDeck
        <span className={styles.nav}>
          <button type="button" className={styles.navButton} onClick={() => navigate('/workspaces')} aria-label="项目">
            <FolderOpen size={18} />
          </button>
          <button type="button" className={styles.navButton} onClick={() => navigate('/settings')} aria-label="设置">
            <Settings size={18} />
          </button>
        </span>
      </header>
      {waiting.length > 0 && (
        <button type="button" className={styles.banner} onClick={() => navigate(`/s/${waiting[0].id}`)}>
          <AlertTriangle size={16} />
          {waiting.length} 项等待你处理
        </button>
      )}
      <main className={styles.list}>
        {sessions.error ? <div className={styles.error}>{sessions.error.message}</div> : <SessionList sessions={sessions.data ?? []} onSelect={(id) => navigate(`/s/${id}`)} />}
      </main>
      <footer className={styles.footer}>
        <button type="button" className={styles.newButton} onClick={() => navigate('/new')}>
          <Plus size={18} />
          新建会话
        </button>
      </footer>
    </div>
  )
}
