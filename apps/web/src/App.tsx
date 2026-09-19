import { Bell, FolderOpen, Plus, Settings } from 'lucide-react'
import { navigate, usePathname } from './router'
import { useMediaQuery } from './session/useMediaQuery'
import { useSessions } from './session/useSessions'
import { notificationsSupported, useNotificationPermission, useNotifications } from './session/useNotifications'
import { SessionList } from './components/SessionList'
import { useResizable } from './components/Resizer'
import { NewSessionPage } from './pages/NewSessionPage'
import { SessionListPage } from './pages/SessionListPage'
import { SessionPage } from './pages/SessionPage'
import { WorkspacesPage } from './pages/WorkspacesPage'
import { SettingsPage } from './pages/SettingsPage'
import styles from './App.module.css'

// 路由：/ 列表（桌面为侧栏 + 新建面板）、/new 新建、/s/:id 会话页、/workspaces 项目、/settings 设置
export default function App() {
  const pathname = usePathname()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const sessionId = pathname.match(/^\/s\/([^/]+)$/)?.[1]
  const sessions = useSessions()
  useNotifications(sessions.data, sessionId)

  const page = sessionId ? <SessionPage sessionId={sessionId} /> : pathname === '/workspaces' ? <WorkspacesPage /> : pathname === '/settings' ? <SettingsPage /> : null

  if (!desktop) {
    if (page) return page
    return pathname === '/new' ? <NewSessionPage /> : <SessionListPage />
  }
  return (
    <div className={styles.shell}>
      <Sidebar activeId={sessionId} />
      <main className={styles.main}>{page ?? <NewSessionPage />}</main>
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
        AgentDeck
        {notificationsSupported && notify.permission === 'default' && (
          <button type="button" className={styles.bell} onClick={notify.request} title="会话等待审批或完成时弹系统通知">
            <Bell size={14} />
            开启通知
          </button>
        )}
      </div>
      <div className={styles.sidebarList}>
        <SessionList sessions={sessions.data ?? []} activeId={activeId} onSelect={(id) => navigate(`/s/${id}`)} />
      </div>
      <button type="button" className={styles.newButton} onClick={() => navigate('/new')}>
        <Plus size={16} />
        新建会话
      </button>
      <nav className={styles.nav}>
        <button type="button" className={styles.navButton} onClick={() => navigate('/workspaces')}>
          <FolderOpen size={14} />
          项目
        </button>
        <button type="button" className={styles.navButton} onClick={() => navigate('/settings')}>
          <Settings size={14} />
          设置
        </button>
      </nav>
    </aside>
  )
}
