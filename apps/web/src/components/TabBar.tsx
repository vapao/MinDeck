import { CalendarClock, ConciergeBell, Inbox, ListTodo, MessageSquare } from 'lucide-react'
import { navigate, usePathname } from '../router'
import { inboxCount, useInbox } from '../session/useInbox'
import styles from './TabBar.module.css'

const tabs = [
  { path: '/steward', label: 'Steward', Icon: ConciergeBell },
  { path: '/', label: 'Inbox', Icon: Inbox },
  { path: '/todos', label: 'Todos', Icon: ListTodo },
  { path: '/sessions', label: 'Sessions', Icon: MessageSquare },
  { path: '/schedules', label: 'Automations', Icon: CalendarClock },
]

// 手机五个顶层页底部的 tab；进了会话、详情等下一级页面就不显示
export function TabBar({ className = '' }: { className?: string }) {
  const pathname = usePathname()
  const count = inboxCount(useInbox().data)
  return (
    <nav className={`${styles.bar} ${className}`}>
      {tabs.map(({ path, label, Icon }) => (
        <button key={path} type="button" className={styles.tab} data-on={pathname === path || undefined} onClick={() => navigate(path, { replace: true })}>
          <span className={styles.icon}>
            <Icon size={22} />
            {path === '/' && count > 0 && <span className={styles.badge}>{count}</span>}
          </span>
          {label}
        </button>
      ))}
    </nav>
  )
}
