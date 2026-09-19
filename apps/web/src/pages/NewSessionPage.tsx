import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { effortLevels, type ProviderId } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import styles from './NewSessionPage.module.css'

export function NewSessionPage() {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const [cwd, setCwd] = useState('')
  const [provider, setProvider] = useState<ProviderId>('claude')
  // 模型 / 思考等级默认跟设置走；这里改只影响本次创建
  const [override, setOverride] = useState<Partial<Record<ProviderId, { model?: string; effort?: string }>>>({})
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: api.createSession,
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate(`/s/${session.id}`)
    },
  })
  const selected = cwd || workspaces.data?.[0]?.path || ''
  const defaults = settings.data?.[provider]
  const model = override[provider]?.model ?? defaults?.model ?? ''
  const effort = override[provider]?.effort ?? defaults?.effort ?? ''
  const patch = (field: 'model' | 'effort', value: string) => setOverride((o) => ({ ...o, [provider]: { ...o[provider], [field]: value } }))

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.brand}>AgentDeck</h1>
        <label className={styles.field}>
          <span className={styles.labelRow}>
            工作区
            <button type="button" className={styles.link} onClick={() => navigate('/workspaces')}>
              管理项目
            </button>
          </span>
          <select className={styles.select} value={selected} onChange={(e) => setCwd(e.target.value)} disabled={!workspaces.data}>
            {workspaces.data?.map((w) => (
              <option key={w.id} value={w.path} title={w.path}>
                {w.alias}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Agent</span>
          <select className={styles.select} value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {(Object.keys(providerName) as ProviderId[]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.pair}>
          <label className={styles.field}>
            <span>模型</span>
            <input className={styles.select} value={model} placeholder="默认" onChange={(e) => patch('model', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>思考等级</span>
            <select className={styles.select} value={effort} onChange={(e) => patch('effort', e.target.value)}>
              <option value="">默认</option>
              {effortLevels[provider].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="button" className={styles.primary} disabled={!selected || create.isPending} onClick={() => create.mutate({ provider, cwd: selected, model, effort })}>
          新建 {providerName[provider]} 会话
        </button>
        {workspaces.data?.length === 0 && <div className={styles.error}>还没有项目，先去「管理项目」添加一个</div>}
        {(create.error ?? workspaces.error) && <div className={styles.error}>{(create.error ?? workspaces.error)!.message}</div>}
      </div>
    </div>
  )
}
