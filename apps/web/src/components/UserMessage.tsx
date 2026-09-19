import { formatTime } from '../format'
import styles from './UserMessage.module.css'

export function UserMessage({ text, at }: { text: string; at: string }) {
  return (
    <div className={styles.row}>
      <div className={styles.meta}>你 · {formatTime(at)}</div>
      <div className={styles.bubble}>{text}</div>
    </div>
  )
}
