import { Bell, FolderOpen, MessageSquare, Plus, Settings } from 'lucide-react'
import { navigate, usePathname } from './router'
import { useMediaQuery } from './session/useMediaQuery'
import { useSessions } from './session/useSessions'
import { notificationsSupported, useNotificationPermission, useNotifications } from './session/useNotifications'
import { SessionTabs } from './components/SessionList'
import { useMarkSeen } from './session/seen'
import { RateMeter } from './components/RateMeter'
import { useResizable } from './components/Resizer'
import { NewSessionPage } from './pages/NewSessionPage'
import { SessionListPage } from './pages/SessionListPage'
import { SessionPage } from './pages/SessionPage'
import { WorkspacesPage } from './pages/WorkspacesPage'
import { SettingsPage } from './pages/SettingsPage'
import styles from './App.module.css'

// 路由：/ 列表（桌面为侧栏 + 空态）、/new 新建、/s/:id 会话页、/workspaces 项目、/settings 设置
export default function App() {
  const pathname = usePathname()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const sessionId = pathname.match(/^\/s\/([^/]+)$/)?.[1]
  const sessions = useSessions()
  useNotifications(sessions.data, sessionId)
  useMarkSeen(sessions.data, sessionId)

  const page = sessionId ? <SessionPage sessionId={sessionId} /> : pathname === '/workspaces' ? <WorkspacesPage /> : pathname === '/settings' ? <SettingsPage /> : null

  if (!desktop) {
    if (page) return page
    return pathname === '/new' ? <NewSessionPage /> : <SessionListPage />
  }
  return (
    <div className={styles.shell}>
      <Sidebar activeId={sessionId} />
      <main className={styles.main}>{page ?? (pathname === '/new' ? <NewSessionPage /> : <EmptyState />)}</main>
    </div>
  )
}

// 桌面端没选中会话时的占位：侧栏本身就有 New session，这里不再直接摆新建表单，删完 / 归档完当前会话也不会被动掉进表单
function EmptyState() {
  return (
    <div className={styles.empty}>
      <MessageSquare size={28} strokeWidth={1.5} />
      <p>Select a session, or start a new one.</p>
      <button type="button" className={styles.emptyButton} onClick={() => navigate('/new')}>
        <Plus size={14} />
        New session
      </button>
    </div>
  )
}

function Sidebar({ activeId }: { activeId?: string }) {
  const sessions = useSessions()
  const notify = useNotificationPermission()
  const { width, handle } = useResizable('sidebar', 280, 220, 480, 'left')
  return (
    <aside className={styles.sidebar} style={{ width }}>
      <div {...handle} />
      <div className={styles.brand}>
        <span className={styles.brandName}>
          <span className={styles.mark} />
          AgentDeck
        </span>
        {notificationsSupported && notify.permission === 'default' && (
          <button type="button" className={styles.bell} onClick={notify.request} title="System notification when a session needs approval or finishes">
            <Bell size={14} />
            Enable notifications
          </button>
        )}
      </div>
      <div className={styles.sidebarList}>
        <SessionTabs sessions={sessions.data ?? []} activeId={activeId} />
      </div>
      <button type="button" className={styles.newButton} onClick={() => navigate('/new')}>
        <Plus size={16} />
        New session
      </button>
      <RateMeter />
      <nav className={styles.nav}>
        <button type="button" className={styles.navButton} onClick={() => navigate('/workspaces')}>
          <FolderOpen size={14} />
          Projects
        </button>
        <button type="button" className={styles.navButton} onClick={() => navigate('/settings')}>
          <Settings size={14} />
          Settings
        </button>
      </nav>
    </aside>
  )
}
