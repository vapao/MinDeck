import { Check, Square } from 'lucide-react'
import type { TurnEndReason } from '@agentdeck/shared'
import { formatTime } from '../format'
import { formatElapsed, useElapsed } from './useElapsed'
import styles from './TurnRow.module.css'

/** 一轮进行中：贴在消息流底部的扫光计时 */
export function WorkingRow({ since }: { since: string }) {
  const sec = useElapsed(since, true)
  return (
    <div className={styles.row}>
      <span className={styles.shimmer}>处理中 · {formatElapsed(sec)}</span>
    </div>
  )
}

/** 一轮结束的落款；Hub 重启补记的中断没有用时（durationMs = 0） */
export function TurnRow({ reason, durationMs, at }: { reason: TurnEndReason; durationMs: number; at: string }) {
  const Icon = reason === 'completed' ? Check : Square
  const elapsed = durationMs > 0 ? ` · 用时 ${formatElapsed(Math.round(durationMs / 1000))}` : ''
  return (
    <div className={styles.row} data-reason={reason}>
      <Icon size={12} />
      <span>
        {reason === 'completed' ? '已完成' : '已中断'}
        {elapsed} · {formatTime(at)}
      </span>
    </div>
  )
}
