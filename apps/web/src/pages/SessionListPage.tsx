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
          <button type="button" className={styles.navButton} onClick={() => navigate('/workspaces')} aria-label="Projects">
            <FolderOpen size={18} />
          </button>
          <button type="button" className={styles.navButton} onClick={() => navigate('/settings')} aria-label="Settings">
            <Settings size={18} />
          </button>
        </span>
      </header>
      {waiting.length > 0 && (
        <button type="button" className={styles.banner} onClick={() => navigate(`/s/${waiting[0].id}`)}>
          <AlertTriangle size={16} />
          {waiting.length} {waiting.length === 1 ? 'session needs' : 'sessions need'} your attention
        </button>
      )}
      <main className={styles.list}>
        {sessions.error ? <div className={styles.error}>{sessions.error.message}</div> : <SessionList sessions={sessions.data ?? []} onSelect={(id) => navigate(`/s/${id}`)} />}
      </main>
      <footer className={styles.footer}>
        <button type="button" className={styles.newButton} onClick={() => navigate('/new')}>
          <Plus size={18} />
          New session
        </button>
      </footer>
    </div>
  )
}
