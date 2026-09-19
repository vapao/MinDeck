import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { navigate } from '../router'
import styles from './NewSessionPage.module.css'

export function NewSessionPage() {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const [cwd, setCwd] = useState('')
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: api.createSession,
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate(`/s/${session.id}`)
    },
  })
  const selected = cwd || workspaces.data?.[0]?.cwd || ''

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.brand}>AgentDeck</h1>
        <label className={styles.field}>
          <span>工作区</span>
          <select className={styles.select} value={selected} onChange={(e) => setCwd(e.target.value)} disabled={!workspaces.data}>
            {workspaces.data?.map((w) => (
              <option key={w.cwd} value={w.cwd}>
                {w.cwd}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={styles.primary} disabled={!selected || create.isPending} onClick={() => create.mutate({ provider: 'claude', cwd: selected })}>
          新建 Claude 会话
        </button>
        {(create.error ?? workspaces.error) && <div className={styles.error}>{(create.error ?? workspaces.error)!.message}</div>}
      </div>
    </div>
  )
}
