import { formatTime } from '../format'
import styles from './AssistantMessage.module.css'

export function AssistantMessage({ text, streaming, at }: { text: string; streaming: boolean; at: string }) {
  return (
    <div className={styles.row}>
      <div className={styles.meta}>
        <span className={styles.avatar}>C</span>
        claude · {formatTime(at)}
      </div>
      <div className={styles.body}>
        {text}
        {streaming && <span className={styles.cursor} />}
      </div>
    </div>
  )
}
