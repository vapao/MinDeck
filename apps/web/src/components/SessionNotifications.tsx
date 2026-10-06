import { Bell, X } from 'lucide-react'
import type { SessionNotice } from '../session/useNotifications'
import { navigate } from '../router'
import styles from './SessionNotifications.module.css'

export function SessionNotifications({ notices, dismiss }: { notices: SessionNotice[]; dismiss: (id: string) => void }) {
  return (
    <div className={styles.stack} aria-label="Session notifications" aria-live="polite" aria-relevant="additions text">
      {notices.map((notice) => <Notice key={notice.id} notice={notice} dismiss={dismiss} />)}
    </div>
  )
}

function Notice({ notice, dismiss }: { notice: SessionNotice; dismiss: (id: string) => void }) {
  return (
    <div className={styles.notice}>
      <button type="button" className={styles.open} onClick={() => { dismiss(notice.id); navigate(`/s/${notice.id}`) }}>
        <Bell size={16} />
        <span className={styles.content}>
          <span className={styles.title}>{notice.title}</span>
          <span className={styles.detail}>{notice.text}{notice.project && ` · ${notice.project}`}</span>
        </span>
      </button>
      <button type="button" className={styles.close} aria-label={`Dismiss notification for ${notice.title}`} onClick={() => dismiss(notice.id)}><X size={14} /></button>
    </div>
  )
}
