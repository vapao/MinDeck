import { Plus } from 'lucide-react'
import { navigate, usePathname } from './router'
import { useMediaQuery } from './session/useMediaQuery'
import { useSessions } from './session/useSessions'
import { SessionList } from './components/SessionList'
import { NewSessionPage } from './pages/NewSessionPage'
import { SessionListPage } from './pages/SessionListPage'
import { SessionPage } from './pages/SessionPage'
import styles from './App.module.css'

// 路由：/ 列表（桌面为侧栏 + 新建面板）、/new 新建、/s/:id 会话页
export default function App() {
  const pathname = usePathname()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const sessionId = pathname.match(/^\/s\/([^/]+)$/)?.[1]

  if (!desktop) {
    if (sessionId) return <SessionPage sessionId={sessionId} />
    return pathname === '/new' ? <NewSessionPage /> : <SessionListPage />
  }
  return (
    <div className={styles.shell}>
      <Sidebar activeId={sessionId} />
      <main className={styles.main}>{sessionId ? <SessionPage sessionId={sessionId} /> : <NewSessionPage />}</main>
    </div>
  )
}

function Sidebar({ activeId }: { activeId?: string }) {
  const sessions = useSessions()
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>AgentDeck</div>
      <div className={styles.sidebarList}>
        <SessionList sessions={sessions.data ?? []} activeId={activeId} onSelect={(id) => navigate(`/s/${id}`)} />
      </div>
      <button type="button" className={styles.newButton} onClick={() => navigate('/new')}>
        <Plus size={16} />
        新建会话
      </button>
    </aside>
  )
}
