import type { ProviderId } from '@agentdeck/shared'
import { formatTime } from '../format'
import styles from './AssistantMessage.module.css'

export function AssistantMessage({ provider, text, streaming, at }: { provider: ProviderId; text: string; streaming: boolean; at: string }) {
  return (
    <div className={styles.row}>
      <div className={styles.meta}>
        <span className={styles.avatar}>{provider === 'codex' ? 'X' : 'C'}</span>
        {provider} · {formatTime(at)}
      </div>
      <div className={styles.body}>
        {text}
        {streaming && <span className={styles.cursor} />}
      </div>
    </div>
  )
}
