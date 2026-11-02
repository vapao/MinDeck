import { useRef } from 'react'
import { Bell, CalendarClock, FolderOpen, MessageSquare, Plus, Settings } from 'lucide-react'
import { useAutoHideScrollbar } from './session/useAutoHideScrollbar'
import { navigate, usePathname } from './router'
import { useMediaQuery } from './session/useMediaQuery'
import { useSessions } from './session/useSessions'
import { notificationsSupported, useNotificationPermission, useNotifications } from './session/useNotifications'
import { SessionTabs } from './components/SessionList'
import { SessionNotifications } from './components/SessionNotifications'
import { UpdateNotice } from './components/UpdateNotice'
import { Loading } from './components/Loading'
import { useMarkSeen } from './session/seen'
import { RateMeter } from './components/RateMeter'
import { useResizable } from './components/Resizer'
import { NewSessionHost, openNewSession } from './components/NewSessionDialog'
import { SessionListPage } from './pages/SessionListPage'
import { SessionPage } from './pages/SessionPage'
import { WorkspacesPage } from './pages/WorkspacesPage'
import { SettingsPage } from './pages/SettingsPage'
import { SchedulesPage } from './pages/SchedulesPage'
import styles from './App.module.css'

// 新建会话是全局弹窗，不占路由。路由：/ 列表（桌面为侧栏 + 空态）、/s/:id 会话页、/workspaces 项目、/schedules 定时任务、/settings 设置
export default function App() {
  const pathname = usePathname()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const sessionId = pathname.match(/^\/s\/([^/]+)$/)?.[1]
  const sessions = useSessions()
  const notifications = useNotifications(sessions.data, sessionId)
  useMarkSeen(sessions.data, sessionId)

  const page = sessionId ? <SessionPage sessionId={sessionId} /> : pathname === '/workspaces' ? <WorkspacesPage /> : pathname === '/schedules' ? <SchedulesPage /> : pathname === '/settings' ? <SettingsPage /> : null

  return (
    <>
      {desktop ? (
        <div className={styles.shell}>
          <Sidebar activeId={sessionId} />
          <main className={styles.main} data-session={sessionId ? '' : undefined}>{page ?? <EmptyState />}</main>
        </div>
      ) : page ?? <SessionListPage />}
      <UpdateNotice />
      <NewSessionHost />
      <SessionNotifications {...notifications} />
    </>
  )
}

// 桌面端没选中会话时的占位：侧栏本身就有 New session，这里不再直接摆新建表单，删完 / 归档完当前会话也不会被动掉进表单
function EmptyState() {
  return (
    <div className={styles.empty}>
      <MessageSquare size={28} strokeWidth={1.5} />
      <p>Select a session, or start a new one.</p>
      <button type="button" className={styles.emptyButton} onClick={() => openNewSession()}>
        <Plus size={14} />
        New session
      </button>
    </div>
  )
}

function Sidebar({ activeId }: { activeId?: string }) {
  const list = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(list)
  const sessions = useSessions()
  const notify = useNotificationPermission()
  const { width, handle } = useResizable('sidebar', 280, 220, 480, 'left')
  return (
    <aside className={styles.sidebar} style={{ width }}>
      <div {...handle} />
      <div className={styles.brand}>
        <span className={styles.brandName}>
          <img className={styles.mark} src="/favicon.svg" alt="" />
          AgentDeck
        </span>
        {notificationsSupported && notify.permission === 'default' && (
          <button type="button" className={styles.bell} onClick={notify.request} aria-label="Enable notifications" title="System notification when a session needs approval or finishes">
            <Bell size={14} />
            <span className={styles.bellLabel}>Enable notifications</span>
          </button>
        )}
      </div>
      <div ref={list} className={styles.sidebarList}>
        {sessions.isPending ? <Loading label="Loading sessions…" /> : <SessionTabs sessions={sessions.data ?? []} activeId={activeId} />}
      </div>
      {/* 正在看某个会话时，新建默认落在同一项目 */}
      <button type="button" className={styles.newButton} onClick={() => openNewSession(sessions.data?.find((s) => s.id === activeId)?.cwd)}>
        <Plus size={16} />
        New session
      </button>
      <RateMeter />
      <nav className={styles.nav}>
        <button type="button" className={styles.navButton} onClick={() => navigate('/workspaces')}>
          <FolderOpen size={14} />
          Projects
        </button>
        <button type="button" className={styles.navButton} onClick={() => navigate('/schedules')}>
          <CalendarClock size={14} />
          Scheduled
        </button>
        <button type="button" className={styles.navButton} onClick={() => navigate('/settings')}>
          <Settings size={14} />
          Settings
        </button>
      </nav>
    </aside>
  )
}
