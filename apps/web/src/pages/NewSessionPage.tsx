import { useState } from 'react'
import { X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getEffortOptions, modelOptions, permissionModeOptions, type PermissionMode, type ProviderId } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { Select } from '../components/Select'
import { dialog } from '../components/Dialog'
import styles from './NewSessionPage.module.css'

export function NewSessionPage() {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const [cwd, setCwd] = useState('')
  // 默认沿用上一次的选择（新建或空会话切换时记下）
  const [provider, setProvider] = useState<ProviderId>(() => {
    const last = localStorage.getItem('newSession:provider')
    return last && last in providerName ? (last as ProviderId) : 'claude'
  })
  // 模型 / 思考等级 / 权限模式默认跟设置走；这里改只影响本次创建
  const [override, setOverride] = useState<Partial<Record<ProviderId, { model?: string; effort?: string; permissionMode?: string }>>>({})
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: api.createSession,
    onSuccess: (session) => {
      localStorage.setItem('newSession:provider', session.provider)
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate(`/s/${session.id}`)
    },
  })
  const selected = cwd || workspaces.data?.[0]?.path || ''
  const defaults = settings.data?.[provider]
  const model = override[provider]?.model ?? defaults?.model ?? ''
  const effort = override[provider]?.effort ?? defaults?.effort ?? ''
  const permissionMode = override[provider]?.permissionMode ?? defaults?.permissionMode ?? 'approval'
  const patch = (field: 'model' | 'effort' | 'permissionMode', value: string) => setOverride((o) => ({
    ...o,
    [provider]: {
      ...o[provider], [field]: value,
      ...(field === 'model' && !getEffortOptions(provider, value).some((option) => option.value === effort) ? { effort: '' } : {}),
    },
  }))

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.head}>
          <h1 className={styles.brand}>New session</h1>
          <button type="button" className={styles.close} onClick={() => (history.length > 1 ? history.back() : navigate('/'))} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <label className={styles.field}>
          <span className={styles.labelRow}>
            Workspace
            <button type="button" className={styles.link} onClick={() => navigate('/workspaces')}>
              Manage projects
            </button>
          </span>
          <Select value={selected} onChange={setCwd} disabled={!workspaces.data} placeholder="No projects yet" options={(workspaces.data ?? []).map((w) => ({ value: w.path, label: w.alias, hint: w.path }))} />
        </label>
        <label className={styles.field}>
          <span>Agent</span>
          <Select value={provider} onChange={(v) => setProvider(v as ProviderId)} options={(Object.keys(providerName) as ProviderId[]).map((p) => ({ value: p, label: providerName[p] }))} />
        </label>
        <div className={styles.pair}>
          <label className={styles.field}>
            <span>Model</span>
            <Select value={model} onChange={(v) => patch('model', v)} options={[{ value: '', label: 'Default' }, ...modelOptions[provider]]} />
          </label>
          {provider !== 'deepseek' && <label className={styles.field}>
            <span>Effort</span>
            <Select value={effort} onChange={(v) => patch('effort', v)} options={[{ value: '', label: 'Default' }, ...getEffortOptions(provider, model)]} />
          </label>}
        </div>
        <label className={styles.field}>
          <span>Permission mode</span>
          <Select value={permissionMode} onChange={(v) => patch('permissionMode', v)} options={[...permissionModeOptions]} />
          {permissionMode === 'bypass' && <div className={styles.error}>Runs any command without approval. Use at your own risk.</div>}
        </label>
        <button
          type="button"
          className={styles.primary}
          disabled={!selected || create.isPending}
          onClick={async () => {
            if (
              permissionMode === 'bypass' &&
              !(await dialog.confirm({
                title: 'Create a session that bypasses approval?',
                message: 'This session will skip approval entirely and run any command without confirmation. Use at your own risk.',
                ok: 'Create anyway',
                danger: true,
              }))
            )
              return
            create.mutate({ provider, cwd: selected, model, effort, permissionMode: permissionMode as PermissionMode })
          }}
        >
          New {providerName[provider]} session
        </button>
        {workspaces.data?.length === 0 && <div className={styles.error}>No projects yet. Add one under "Manage projects" first.</div>}
        {(create.error ?? workspaces.error) && <div className={styles.error}>{(create.error ?? workspaces.error)!.message}</div>}
      </div>
    </div>
  )
}
