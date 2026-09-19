import { ShieldAlert } from 'lucide-react'
import type { ApprovalDecision, PendingRequest } from '@agentdeck/shared'
import { formatTime } from '../format'
import type { PendingState } from '../session/useSessionStream'
import { formatElapsed, useElapsed } from './useElapsed'
import styles from './pendingCard.module.css'

type Props = {
  request: Extract<PendingRequest, { kind: 'approval' }>
  cwd: string
  state: PendingState
  decision: ApprovalDecision | null
  resolvedAt: string | null
  busy: boolean
  error: string | null
  onResolve: (decision: ApprovalDecision) => void
}

const decisionLabel: Record<ApprovalDecision, string> = { allow_once: '已允许', allow_session: '已允许（本会话）', deny: '已拒绝' }

export function ApprovalCard({ request, cwd, state, decision, resolvedAt, busy, error, onResolve }: Props) {
  const elapsed = useElapsed(request.createdAt, state === 'pending')
  const input = request.input as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : null
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const headline = state === 'pending' ? '需要你的批准' : state === 'expired' ? '审批已失效' : `审批 · ${decisionLabel[decision!]}`

  return (
    <div className={styles.card} data-state={state}>
      <div className={styles.head}>
        <ShieldAlert size={16} className={styles.headIcon} />
        {headline}
        <span className={styles.chip}>{request.toolName}</span>
        <span className={styles.headMeta}>{state === 'pending' ? `等待 ${formatElapsed(elapsed)}` : resolvedAt ? formatTime(resolvedAt) : ''}</span>
      </div>
      <div className={styles.body}>
        {request.title && <div className={styles.text}>{request.title}</div>}
        {command !== null ? (
          <pre className={styles.code}>{command}</pre>
        ) : filePath !== null ? (
          <div className={styles.mono}>{filePath}</div>
        ) : (
          <pre className={styles.code}>{JSON.stringify(request.input, null, 2)}</pre>
        )}
        {state === 'pending' && (
          <>
            <div className={styles.field}>
              <span className={styles.label}>目录</span>
              <span className={styles.mono}>{cwd}</span>
            </div>
            {(request.description || request.decisionReason) && (
              <div className={styles.field}>
                <span className={styles.label}>原因</span>
                <span className={styles.text}>{request.description ?? request.decisionReason}</span>
              </div>
            )}
          </>
        )}
      </div>
      {state === 'pending' && (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => onResolve('allow_once')}>
            允许一次
          </button>
          {request.sessionAllowPatterns.length > 0 && (
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => onResolve('allow_session')}>
              本会话允许 {request.sessionAllowPatterns.join(', ')}
            </button>
          )}
          <button type="button" className={styles.ghost} disabled={busy} onClick={() => onResolve('deny')}>
            拒绝
          </button>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
    </div>
  )
}
