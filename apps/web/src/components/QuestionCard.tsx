import { useState } from 'react'
import { CircleHelp, KeyRound } from 'lucide-react'
import type { PendingRequest, ProviderId, QuestionAnswers } from '@agentdeck/shared'
import { formatTime } from '../format'
import type { PendingState } from '../session/useSessionStream'
import styles from './pendingCard.module.css'

type Props = {
  request: Extract<PendingRequest, { kind: 'question' }>
  provider: ProviderId
  state: PendingState
  answers: QuestionAnswers | null
  response: string | null
  resolvedAt: string | null
  busy: boolean
  error: string | null
  onSubmit: (answers: QuestionAnswers, response: string | undefined) => void
  /** Inbox 详情已把问题和说明作为标题与正文展示，卡片里只留选项 */
  bare?: boolean
}

export function QuestionCard({ request, provider, state, answers, response, resolvedAt, busy, error, onSubmit, bare = false }: Props) {
  const [picked, setPicked] = useState<QuestionAnswers>({})
  const [other, setOther] = useState('')
  const [username, setUsername] = useState('')
  const complete = request.questions.every((q) => (picked[q.question]?.length ?? 0) > 0) || other.trim().length > 0

  const toggle = (question: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[question] ?? []
      const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
      return { ...p, [question]: next }
    })

  if (request.secret) {
    const { name, shared, withUsername } = request.secret
    const filled = other.trim() && (!withUsername || username.trim())
    return (
      <div className={styles.card} data-state={state}>
        <div className={styles.head}>
          <KeyRound size={16} className={styles.headIcon} />
          {state === 'pending' ? `${provider} needs a secret · non-blocking` : state === 'expired' ? 'Secret request expired' : 'Secret · saved'}
          <span className={styles.headMeta}>{state === 'pending' ? (shared ? 'Shared' : 'Private to this project') : resolvedAt ? formatTime(resolvedAt) : ''}</span>
        </div>
        <div className={styles.body}>
          {!bare && (
            <div className={styles.field}>
              <span className={styles.label}>Secret</span>
              <code className={styles.text}>{name}</code>
              {request.details && <div className={styles.details}>{request.details}</div>}
            </div>
          )}
          {state === 'pending' && withUsername && (
            <input className={styles.other} value={username} placeholder="Username" autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
          )}
          {state === 'pending' && (
            <input className={styles.other} type="password" value={other} placeholder={withUsername ? 'Password' : `Value of ${name}`} autoComplete="off" spellCheck={false} onChange={(e) => setOther(e.target.value)} />
          )}
        </div>
        {state === 'pending' && (
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={busy || !filled} onClick={() => onSubmit(withUsername ? { username: [username.trim()] } : {}, other.trim())}>
              Save secret
            </button>
            {error && <div className={styles.error}>{error}</div>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.card} data-state={state}>
      <div className={styles.head}>
        <CircleHelp size={16} className={styles.headIcon} />
        {state === 'pending' ? `${provider} is asking${request.delivery === 'async' ? ' · non-blocking' : ''}` : state === 'expired' ? 'Question expired' : 'Question · answered'}
        <span className={styles.headMeta}>{state === 'pending' ? (request.questions.some((q) => q.multiSelect) ? 'Multi-select' : 'Single choice') : resolvedAt ? formatTime(resolvedAt) : ''}</span>
      </div>
      <div className={styles.body}>
        {request.questions.map((q) => (
          <div key={q.question} className={styles.field}>
            {!bare && (
              <>
                <span className={styles.label}>{q.header}</span>
                <div className={styles.text}>{q.question}</div>
                {request.details && <div className={styles.details}>{request.details}</div>}
              </>
            )}
            {state === 'pending' ? (
              q.options.map((o) => (
                <label key={o.label} className={styles.option}>
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={q.question}
                    checked={picked[q.question]?.includes(o.label) ?? false}
                    onClick={() => {
                      if (!q.multiSelect && picked[q.question]?.includes(o.label)) {
                        setPicked((p) => ({ ...p, [q.question]: [] }))
                      }
                    }}
                    onChange={() => toggle(q.question, o.label, q.multiSelect)}
                  />
                  <span className={styles.optionText}>
                    <span>{o.label}</span>
                    <span className={styles.optionDesc}>{o.description}</span>
                  </span>
                </label>
              ))
            ) : (
              <div>{answers?.[q.question]?.join(', ') ?? '—'}</div>
            )}
          </div>
        ))}
        {state === 'pending' ? (
          <input className={styles.other} value={other} placeholder={request.questions.some((q) => q.options.length) ? 'Other (free text)' : 'Your answer'} onChange={(e) => setOther(e.target.value)} />
        ) : (
          response && <div className={styles.text}>Other: {response}</div>
        )}
      </div>
      {state === 'pending' && (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || !complete} onClick={() => onSubmit(picked, other.trim() || undefined)}>
            Submit
          </button>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
    </div>
  )
}
