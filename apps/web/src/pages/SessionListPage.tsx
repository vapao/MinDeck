import { useRef } from 'react'
import { FolderOpen, Plus, Settings } from 'lucide-react'
import { useAutoHideScrollbar } from '../session/useAutoHideScrollbar'
import { navigate } from '../router'
import { useSessions } from '../session/useSessions'
import { SessionTabs } from '../components/SessionList'
import { openNewSession } from '../components/NewSessionDialog'
import { Loading } from '../components/Loading'
import { RateMeter } from '../components/RateMeter'
import { TabBar } from '../components/TabBar'
import styles from './SessionListPage.module.css'

// 移动端会话列表（UI 规范 §4 移动），底部 tab 的 Sessions 页；等你处理的事在 Inbox 页
export function SessionListPage() {
  const list = useRef<HTMLElement>(null)
  useAutoHideScrollbar(list)
  const sessions = useSessions()

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <span className={styles.brandName}>
          <img className={styles.mark} src="/favicon.svg" alt="" />
          AgentDeck
        </span>
        <span className={styles.nav}>
          <button type="button" className={styles.navButton} onClick={() => openNewSession()} aria-label="New session">
            <Plus size={24} />
          </button>
          <button type="button" className={styles.navButton} onClick={() => navigate('/workspaces')} aria-label="Projects">
            <FolderOpen size={24} />
          </button>
          <button type="button" className={styles.navButton} onClick={() => navigate('/settings')} aria-label="Settings">
            <Settings size={24} />
          </button>
        </span>
      </header>
      <main ref={list} className={styles.list}>
        {sessions.isPending ? <Loading label="Loading sessions…" /> : sessions.error ? <div className={styles.error}>{sessions.error.message}</div> : <SessionTabs sessions={sessions.data ?? []} />}
      </main>
      <footer className={styles.usage}>
        <RateMeter />
      </footer>
      <TabBar />
    </div>
  )
}
