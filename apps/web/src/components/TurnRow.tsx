import { Check, Square } from 'lucide-react'
import type { TurnEndReason } from '@agentdeck/shared'
import { formatTime } from '../format'
import { CopyMessage } from './AssistantMessage'
import { formatElapsed, useElapsed } from './useElapsed'
import styles from './TurnRow.module.css'

/** 一轮进行中：贴在消息流底部的扫光计时 */
export function WorkingRow({ since }: { since: string }) {
  const sec = useElapsed(since, true)
  return (
    <div className={styles.row}>
      <span className={styles.shimmer}>Working · {formatElapsed(sec)}</span>
    </div>
  )
}

/** 一轮结束的落款；Hub 重启补记的中断没有用时（durationMs = 0）。reply 是这轮最后一段回复，右侧给复制 */
export function TurnRow({ reason, durationMs, at, reply }: { reason: TurnEndReason; durationMs: number; at: string; reply?: string }) {
  const Icon = reason === 'completed' ? Check : Square
  const elapsed = durationMs > 0 ? ` · ${formatElapsed(Math.round(durationMs / 1000))}` : ''
  return (
    <div className={styles.row} data-reason={reason}>
      <Icon size={12} />
      <span>
        {reason === 'completed' ? 'Completed' : 'Stopped'}
        {elapsed} · {formatTime(at)}
      </span>
      {reply && <CopyMessage text={reply} className={styles.copy} />}
    </div>
  )
}
