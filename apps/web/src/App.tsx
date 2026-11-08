import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bell, CalendarClock, ConciergeBell, FolderOpen, Inbox, ListTodo, Plus, Settings } from 'lucide-react'
import { api } from './api'
import { formatTime } from './format'
import { useAutoHideScrollbar } from './session/useAutoHideScrollbar'
import { navigate, usePathname } from './router'
import { useMediaQuery } from './session/useMediaQuery'
import { useSessions } from './session/useSessions'
import { inboxCount, useInbox } from './session/useInbox'
import { notificationsSupported, useNotificationPermission, useNotifications, usePresence } from './session/useNotifications'
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
import { InboxPage } from './pages/InboxPage'
import { hasUnseenBrief, StewardPage, useSteward } from './pages/StewardPage'
import { TodosPage, useTodos } from './pages/TodosPage'
import { TodoHost } from './components/TodoDialog'
import styles from './App.module.css'

// 新建会话是全局弹窗，不占路由。路由：/steward 管家、/ 与 /inbox/:kind/:id Inbox、/sessions 会话列表（手机；桌面在侧栏）、/todos 待办、/s/:id 会话页、/workspaces 项目、/schedules 定时任务、/settings 设置
export default function App() {
  const pathname = usePathname()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const sessionId = pathname.match(/^\/s\/([^/]+)$/)?.[1]
  const sessions = useSessions()
  const notifications = useNotifications(sessions.data, sessionId)
  useMarkSeen(sessions.data, sessionId)
  usePresence()

  const page = sessionId ? <SessionPage sessionId={sessionId} /> : pathname === '/workspaces' ? <WorkspacesPage /> : pathname === '/schedules' ? <SchedulesPage /> : pathname === '/todos' ? <TodosPage /> : pathname === '/settings' ? <SettingsPage /> : pathname === '/steward' ? <StewardPage /> : pathname === '/sessions' && !desktop ? <SessionListPage /> : <InboxPage />

  return (
    <>
      {desktop ? (
        <div className={styles.shell}>
          <Sidebar activeId={sessionId} pathname={pathname} />
          <main className={styles.main} data-session={sessionId ? '' : undefined}>{page}</main>
        </div>
      ) : page}
      <UpdateNotice />
      <NewSessionHost />
      <TodoHost />
      <SessionNotifications {...notifications} />
    </>
  )
}

function Sidebar({ activeId, pathname }: { activeId?: string; pathname: string }) {
  const list = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(list)
  const sessions = useSessions()
  const pending = inboxCount(useInbox().data)
  const unseenBrief = hasUnseenBrief(useSteward().data)
  const todos = useTodos(false).data?.length ?? 0
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: api.listSchedules, refetchInterval: 30_000 })
  const nextRun = schedules.data?.map((s) => (s.enabled ? s.nextRunAt : null)).filter((at): at is string => !!at).sort()[0]
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
      <nav className={styles.primary}>
        <button type="button" className={styles.primaryItem} data-on={pathname === '/steward' || undefined} onClick={() => navigate('/steward')}>
          <ConciergeBell size={14} />
          <span className={styles.primaryLabel}>Steward</span>
          {unseenBrief && pathname !== '/steward' && <span className={styles.dot} title="New brief" />}
        </button>
        <button type="button" className={styles.primaryItem} data-on={pathname === '/' || pathname.startsWith('/inbox/') || undefined} onClick={() => navigate('/')}>
          <Inbox size={14} />
          <span className={styles.primaryLabel}>Inbox</span>
          {pending > 0 && <span className={styles.badge}>{pending}</span>}
        </button>
        <button type="button" className={styles.primaryItem} data-on={pathname === '/todos' || undefined} onClick={() => navigate('/todos')}>
          <ListTodo size={14} />
          <span className={styles.primaryLabel}>Todos</span>
          {todos > 0 && <span className={styles.hint}>{todos} open</span>}
        </button>
        <button type="button" className={styles.primaryItem} data-on={pathname === '/schedules' || undefined} onClick={() => navigate('/schedules')}>
          <CalendarClock size={14} />
          <span className={styles.primaryLabel}>Automations</span>
          {nextRun && <span className={styles.hint} title={new Date(nextRun).toLocaleString('en-GB')}>next {new Date(nextRun).toDateString() === new Date().toDateString() ? formatTime(nextRun) : new Date(nextRun).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })}</span>}
        </button>
      </nav>
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
        <button type="button" className={styles.navButton} onClick={() => navigate('/settings')}>
          <Settings size={14} />
          Settings
        </button>
      </nav>
    </aside>
  )
}
