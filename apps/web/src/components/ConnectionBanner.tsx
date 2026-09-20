import { RefreshCw, WifiOff } from 'lucide-react'
import type { StreamState } from '../session/useSessionStream'
import styles from './ConnectionBanner.module.css'

// UI 规范 §3 ConnectionBanner：重连中 / 已重连并回放 n 条事件；连上且无回放时不渲染
export function ConnectionBanner({ connection, replay }: Pick<StreamState, 'connection' | 'replay'>) {
  if (connection === 'reconnecting') {
    return (
      <div className={styles.banner} data-offline>
        <WifiOff size={14} />
        Connection lost, reconnecting…
      </div>
    )
  }
  if (connection === 'open' && replay) {
    const n = replay.to - replay.from
    return (
      <div className={styles.banner}>
        <RefreshCw size={14} />
        {n === 0 ? 'Reconnected, no events missed' : `Reconnected · replayed ${n} ${n === 1 ? 'event' : 'events'}`}
        {n > 0 && (
          <code className={styles.seq}>
            seq {replay.from} → {replay.to}
          </code>
        )}
      </div>
    )
  }
  return null
}
