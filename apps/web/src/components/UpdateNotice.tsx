import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { api } from '../api'
import styles from './UpdateNotice.module.css'

export function UpdateNotice() {
  const { data } = useQuery({ queryKey: ['update-status'], queryFn: api.updateStatus, refetchInterval: 5000, refetchIntervalInBackground: true, retry: false })
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('agentdeck.dismissedUpdate'))
  const update = data?.update
  if (!update || dismissed === `${update.id}:${update.phase}`) return null
  const title = {
    waiting: 'Update queued · waiting for idle sessions',
    building: 'Building update',
    restarting: 'Restarting AgentDeck',
    completed: 'AgentDeck updated',
    failed: 'AgentDeck update failed',
  }[update.phase]
  const Icon = update.phase === 'completed' ? Check : update.phase === 'failed' ? TriangleAlert : RefreshCw
  return (
    <div className={styles.notice} data-phase={update.phase} role="status" aria-label="Application update">
      <div className={styles.summary}>
        <span className={styles.icon}><Icon size={20} /></span>
        <span className={styles.content}>
          <span className={styles.label}>Application update</span>
          <span className={styles.title} title={title}>{title}</span>
          <span className={styles.detail}>
            {new Date(update.updatedAt).toLocaleString()}
            {update.phase === 'completed' && ' · Hub is ready. Refresh to load the latest interface.'}
            {update.error && ` · ${update.error}`}
          </span>
          {update.phase === 'completed' && <button type="button" className={styles.refresh} onClick={() => location.reload()}>Refresh</button>}
        </span>
      </div>
      <button type="button" className={styles.close} aria-label="Dismiss update notification" onClick={() => {
        const key = `${update.id}:${update.phase}`
        localStorage.setItem('agentdeck.dismissedUpdate', key)
        setDismissed(key)
      }}><X size={14} /></button>
    </div>
  )
}
