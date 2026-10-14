import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getEffortOptions, modelOptions, permissionModeOptions, type PermissionMode, type ProviderId } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { Select } from './Select'
import { dialog } from './Dialog'
import modal from './Dialog.module.css'
import styles from './NewSessionDialog.module.css'

// 新建会话是全局弹窗，不占路由：哪里都能打开，关掉就回到原处。<NewSessionHost /> 在根部挂一次
// cwd：从项目页 / 侧栏分组 / 当前会话带过来的项目；不带就用上次新建时选的
let request: { id: number; cwd?: string } | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
export function openNewSession(cwd?: string) {
  request = { id: ++seq, cwd }
  emit()
}
const closeNewSession = () => {
  request = null
  emit()
}

export function NewSessionHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => request,
  )
  return current && <NewSessionDialog key={current.id} initialCwd={current.cwd} />
}

function NewSessionDialog({ initialCwd }: { initialCwd?: string }) {
  const el = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!el.current!.open) el.current!.showModal()
  }, [])
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const [cwd, setCwd] = useState(() => initialCwd ?? localStorage.getItem('newSession:cwd') ?? '')
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
      localStorage.setItem('newSession:cwd', session.cwd)
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      el.current!.close()
      navigate(`/s/${session.id}`)
    },
  })
  // 记下的项目可能已被移除，退回第一个
  const selected = (workspaces.data?.some((w) => w.path === cwd) ? cwd : workspaces.data?.[0]?.path) ?? ''
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
    // 下拉弹层要能伸出弹窗边界，modal <dialog> 默认 overflow: auto 会把它裁掉
    <dialog ref={el} className={modal.dialog} style={{ overflow: 'visible' }} onClose={closeNewSession} onClick={(e) => e.target === el.current && el.current.close()}>
      <div className={modal.box}>
        <div className={modal.head}>
          <div className={modal.title}>New session</div>
          <button type="button" className={modal.close} onClick={() => el.current!.close()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.field}>
            <span className={styles.labelRow}>
              Workspace
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  el.current!.close()
                  navigate('/workspaces')
                }}
              >
                Manage projects
              </button>
            </span>
            <Select ariaLabel="Workspace" searchable value={selected} onChange={setCwd} disabled={!workspaces.data} placeholder="No projects yet" options={(workspaces.data ?? []).map((w) => ({ value: w.path, label: w.alias, hint: w.path }))} />
          </div>
          <div className={styles.field}>
            <span>Agent</span>
            <Select ariaLabel="Agent" value={provider} onChange={(v) => setProvider(v as ProviderId)} options={(Object.keys(providerName) as ProviderId[]).map((p) => ({ value: p, label: providerName[p] }))} />
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span>Model</span>
              <Select ariaLabel="Model" value={model} onChange={(v) => patch('model', v)} options={[{ value: '', label: 'Default' }, ...modelOptions[provider]]} />
            </div>
            {provider !== 'deepseek' && <div className={styles.field}>
              <span>Effort</span>
              <Select ariaLabel="Effort" value={effort} onChange={(v) => patch('effort', v)} options={[{ value: '', label: 'Default' }, ...getEffortOptions(provider, model)]} />
            </div>}
          </div>
          <div className={styles.field}>
            <span>Permission mode</span>
            <Select ariaLabel="Permission mode" value={permissionMode} onChange={(v) => patch('permissionMode', v)} options={[...permissionModeOptions]} />
            {permissionMode === 'bypass' && <div className={styles.error}>Runs any command without approval. Use at your own risk.</div>}
          </div>
          {workspaces.data?.length === 0 && <div className={styles.error}>No projects yet. Add one under "Manage projects" first.</div>}
          {(create.error ?? workspaces.error) && <div className={styles.error}>{(create.error ?? workspaces.error)!.message}</div>}
        </div>
        <div className={modal.actions}>
          <button type="button" className={modal.secondary} onClick={() => el.current!.close()}>
            Cancel
          </button>
          <button
            type="button"
            className={modal.primary}
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
        </div>
      </div>
    </dialog>
  )
}
