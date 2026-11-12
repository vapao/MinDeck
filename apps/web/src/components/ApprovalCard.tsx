import { ShieldAlert } from 'lucide-react'
import type { ApprovalDecision, PendingRequest } from '@mindeck/shared'
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

const decisionLabel: Record<ApprovalDecision, string> = { allow_once: 'Allowed', allow_session: 'Allowed (this session)', deny: 'Denied' }

export function ApprovalCard({ request, cwd, state, decision, resolvedAt, busy, error, onResolve }: Props) {
  const elapsed = useElapsed(request.createdAt, state === 'pending')
  const input = request.input as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : null
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const headline = state === 'pending' ? 'Approval needed' : state === 'expired' ? 'Approval expired' : `Approval · ${decisionLabel[decision!]}`

  return (
    <div className={styles.card} data-state={state}>
      <div className={styles.head}>
        <ShieldAlert size={16} className={styles.headIcon} />
        {headline}
        <span className={styles.chip}>{request.toolName}</span>
        <span className={styles.headMeta}>{state === 'pending' ? `Waiting ${formatElapsed(elapsed)}` : resolvedAt ? formatTime(resolvedAt) : ''}</span>
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
              <span className={styles.label}>Directory</span>
              <span className={styles.mono}>{cwd}</span>
            </div>
            {(request.description || request.decisionReason) && (
              <div className={styles.field}>
                <span className={styles.label}>Reason</span>
                <span className={styles.text}>{request.description ?? request.decisionReason}</span>
              </div>
            )}
          </>
        )}
      </div>
      {state === 'pending' && (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => onResolve('allow_once')}>
            Allow once
          </button>
          {request.sessionAllowPatterns.length > 0 && (
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => onResolve('allow_session')}>
              Allow for this session: {request.sessionAllowPatterns.join(', ')}
            </button>
          )}
          <button type="button" className={styles.ghost} disabled={busy} onClick={() => onResolve('deny')}>
            Deny
          </button>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
    </div>
  )
}
