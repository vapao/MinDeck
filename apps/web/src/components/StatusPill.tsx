import type { SessionStatus } from '@agentdeck/shared'
import styles from './StatusPill.module.css'

const label: Record<SessionStatus, string> = { running: '运行中', waiting_user: '等待你', idle: '空闲', error: '出错' }

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={styles.pill} data-status={status}>
      <span className={styles.dot} />
      {label[status]}
    </span>
  )
}
