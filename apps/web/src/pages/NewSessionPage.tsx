import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { effortOptions, modelOptions, permissionModeOptions, type PermissionMode, type ProviderId } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { Select } from '../components/Select'
import styles from './NewSessionPage.module.css'

export function NewSessionPage() {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const [cwd, setCwd] = useState('')
  const [provider, setProvider] = useState<ProviderId>('claude')
  // 模型 / 思考等级 / 权限模式默认跟设置走；这里改只影响本次创建
  const [override, setOverride] = useState<Partial<Record<ProviderId, { model?: string; effort?: string; permissionMode?: string }>>>({})
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
  const permissionMode = override[provider]?.permissionMode ?? defaults?.permissionMode ?? 'approval'
  const patch = (field: 'model' | 'effort' | 'permissionMode', value: string) => setOverride((o) => ({ ...o, [provider]: { ...o[provider], [field]: value } }))

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
          <Select value={selected} onChange={setCwd} disabled={!workspaces.data} placeholder="还没有项目" options={(workspaces.data ?? []).map((w) => ({ value: w.path, label: w.alias, hint: w.path }))} />
        </label>
        <label className={styles.field}>
          <span>Agent</span>
          <Select value={provider} onChange={(v) => setProvider(v as ProviderId)} options={(Object.keys(providerName) as ProviderId[]).map((p) => ({ value: p, label: p }))} />
        </label>
        <div className={styles.pair}>
          <label className={styles.field}>
            <span>模型</span>
            <Select value={model} onChange={(v) => patch('model', v)} options={[{ value: '', label: '默认' }, ...modelOptions[provider]]} />
          </label>
          <label className={styles.field}>
            <span>思考等级</span>
            <Select value={effort} onChange={(v) => patch('effort', v)} options={[{ value: '', label: '默认' }, ...effortOptions[provider]]} />
          </label>
        </div>
        <label className={styles.field}>
          <span>权限模式</span>
          <Select value={permissionMode} onChange={(v) => patch('permissionMode', v)} options={[...permissionModeOptions]} />
          {permissionMode === 'bypass' && <div className={styles.error}>不经审批直接执行任意命令，风险自负</div>}
        </label>
        <button
          type="button"
          className={styles.primary}
          disabled={!selected || create.isPending}
          onClick={() => {
            if (permissionMode === 'bypass' && !confirm('这个会话将完全跳过审批，不经确认直接执行任意命令，风险自负。确定要新建吗？')) return
            create.mutate({ provider, cwd: selected, model, effort, permissionMode: permissionMode as PermissionMode })
          }}
        >
          新建 {providerName[provider]} 会话
        </button>
        {workspaces.data?.length === 0 && <div className={styles.error}>还没有项目，先去「管理项目」添加一个</div>}
        {(create.error ?? workspaces.error) && <div className={styles.error}>{(create.error ?? workspaces.error)!.message}</div>}
      </div>
    </div>
  )
}
