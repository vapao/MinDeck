import { Check, GitBranch, Square } from 'lucide-react'
import type { TurnEndReason } from '@mindeck/shared'
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

/** 一轮结束的落款；Hub 重启补记的中断没有用时（durationMs = 0）。reply 是这轮最后一段回复，右侧给复制；onFork 从这轮之后分叉 */
export function TurnRow({ reason, durationMs, at, reply, onFork }: { reason: TurnEndReason; durationMs: number; at: string; reply?: string; onFork?: () => void }) {
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
      {onFork && (
        <button type="button" className={styles.copy} onClick={onFork} title="Continue from here in a new session; this one stays as it is">
          <GitBranch size={12} /> Fork
        </button>
      )}
    </div>
  )
}

/** 分叉点上的分支链接：源会话里列出从这里分出去的会话，分叉会话里指回来源 */
export function ForkLinks({ label, sessions, onOpen }: { label: string; sessions: { id: string; title: string | null }[]; onOpen: (id: string) => void }) {
  return (
    <div className={`${styles.row} ${styles.wrap}`}>
      <GitBranch size={12} />
      <span>{label}</span>
      {sessions.map((s) => (
        <button key={s.id} type="button" className={styles.link} onClick={() => onOpen(s.id)}>
          {s.title ?? 'New session'}
        </button>
      ))}
    </div>
  )
}
