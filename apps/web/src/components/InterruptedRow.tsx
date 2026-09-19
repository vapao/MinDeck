import { Square } from 'lucide-react'
import { formatTime } from '../format'
import styles from './InterruptedRow.module.css'

export function InterruptedRow({ at }: { at: string }) {
  return (
    <div className={styles.row}>
      <Square size={12} />
      <span>已中断 · {formatTime(at)}</span>
    </div>
  )
}
