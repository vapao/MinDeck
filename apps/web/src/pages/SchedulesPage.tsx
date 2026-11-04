import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Play, Plus, Power, Trash2, X } from 'lucide-react'
import { getEffortOptions, modelOptions, permissionModeOptions, type PermissionMode, type ProviderId, type Schedule, type ScheduleConfig, type ScheduleKind } from '@agentdeck/shared'
import { api } from '../api'
import { formatModel, providerName } from '../format'
import { navigate } from '../router'
import { dialog } from '../components/Dialog'
import { TabBar } from '../components/TabBar'
import { useMediaQuery } from '../session/useMediaQuery'
import { useSessions } from '../session/useSessions'
import { useInbox } from '../session/useInbox'
import { Select } from '../components/Select'
import modal from '../components/Dialog.module.css'
import form from '../components/NewSessionDialog.module.css'
import styles from './Manage.module.css'
import own from './SchedulesPage.module.css'

const kindOptions: { value: ScheduleKind; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
]

const formatDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
const describe = (s: Schedule) => s.kind === 'once' ? `Once · ${s.time.replace('T', ' ')}` : `${s.kind === 'daily' ? 'Every day' : 'Weekdays'} · ${s.time}`

// Automations：定时任务（到点在指定项目新建会话并发出 prompt；错过 1 小时内的执行会在 Hub 启动后补跑一次，更早的只记错过）、各任务最近的运行记录、Agent 预约的唤醒
export function SchedulesPage() {
  const queryClient = useQueryClient()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: api.listSchedules, refetchInterval: 30_000 })
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['schedules'] })
  const remove = useMutation({ mutationFn: api.deleteSchedule, onSuccess: invalidate })
  const toggle = useMutation({ mutationFn: (s: Schedule) => api.updateSchedule(s.id, { ...config(s), enabled: !s.enabled }), onSuccess: invalidate })
  const run = useMutation({
    mutationFn: api.runSchedule,
    onSuccess: ({ sessionId }) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate(`/s/${sessionId}`)
    },
  })
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const sessions = useSessions()
  const inbox = useInbox()
  const wakeups = useQuery({ queryKey: ['wakeups'], queryFn: api.listWakeups, refetchInterval: 30_000 })
  const cancelWakeup = useMutation({ mutationFn: api.cancelWakeup, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wakeups'] }) })
  const alias = (id: string) => workspaces.data?.find((w) => w.id === id)?.alias ?? 'Removed project'
  const openItems = (sessionId: string) => [...(inbox.data?.requests ?? []), ...(inbox.data?.reports ?? [])].filter((item) => item.sessionId === sessionId).length
  // sessions 按 updatedAt 倒序，运行记录要按执行先后
  const runsOf = (id: string) => (sessions.data ?? []).filter((x) => x.scheduleId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6)

  const onRemove = async (s: Schedule) => {
    if (await dialog.confirm({ title: `Delete "${s.name}"?`, message: 'Sessions it already created are not affected.', ok: 'Delete', danger: true })) remove.mutate(s.id)
  }
  const error = schedules.error ?? remove.error ?? toggle.error ?? run.error ?? cancelWakeup.error

  return (
    <div className={own.page}>
      <header className={own.top}>
        <h1 className={own.title}>Automations</h1>
        <button type="button" className={own.newTask} onClick={() => setEditing('new')}>
          <Plus size={14} />
          New task
        </button>
      </header>
      <div className={own.scroll}>
        <div className={own.column}>
          {error && <div className={styles.error}>{error.message}</div>}
          <div className={own.sectionHead}>
            <h2>Scheduled tasks</h2>
            <span>Each run starts a new session; runs stay out of the sidebar unless they need you.</span>
          </div>
          {schedules.data?.length === 0 && <div className={own.none}>No scheduled tasks yet</div>}
          {schedules.data?.map((s) => {
            const runs = runsOf(s.id)
            return (
              <div key={s.id} className={own.task} data-disabled={s.enabled ? undefined : ''}>
                <div className={own.taskHead}>
                  <span className={own.name} title={s.name}>{s.name}</span>
                  <span className={own.pill} data-on={s.enabled || undefined}>{s.enabled ? 'On' : 'Off'}</span>
                  <span className={own.taskActions}>
                    <button type="button" className={styles.rowButton} onClick={() => run.mutate(s.id)} disabled={run.isPending} aria-label="Run now" title="Run now (does not change the next run)">
                      <Play size={14} />
                    </button>
                    <button type="button" className={`${styles.rowButton} ${own.power}`} data-active={s.enabled ? '' : undefined} onClick={() => toggle.mutate(s)} disabled={toggle.isPending} aria-label={s.enabled ? 'Turn off' : 'Turn on'} title={s.enabled ? 'Turn off' : 'Turn on'}>
                      <Power size={14} />
                    </button>
                    <button type="button" className={styles.rowButton} onClick={() => setEditing(s)} aria-label="Edit" title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button type="button" className={styles.rowButton} data-danger onClick={() => onRemove(s)} disabled={remove.isPending} aria-label="Delete" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
                <div className={own.meta}>
                  <span>{alias(s.workspaceId)}</span>
                  <code>{s.provider}{s.model ? ` · ${formatModel(s.provider, s.model)}` : ''}</code>
                  <span>{describe(s)}</span>
                  <span>{s.permissionMode}</span>
                </div>
                <div className={own.meta}>
                  <code>{s.enabled && s.nextRunAt ? `Next ${formatDateTime(s.nextRunAt)}` : 'Off'}</code>
                  {s.lastRunAt && <code>Last {formatDateTime(s.lastRunAt)}</code>}
                </div>
                {s.lastError && <div className={styles.error}>{s.lastError}</div>}
                <div className={own.runs}>
                  <span className={own.runsLabel}>Recent runs</span>
                  {runs.length === 0 && <span className={own.runsNone}>None yet</span>}
                  {runs.map((x) => {
                    const items = openItems(x.id)
                    const state = x.status === 'running' ? 'running' : x.status === 'error' ? 'error' : x.status === 'waiting_user' || items ? 'waiting' : 'ok'
                    return (
                      <button key={x.id} type="button" className={own.run} data-state={state} onClick={() => navigate(`/s/${x.id}`)} title={x.title ?? undefined}>
                        <i />
                        {new Date(x.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })}
                        {items > 0 && ` · ${items} item${items > 1 ? 's' : ''}`}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div className={own.sectionHead}>
            <h2>Upcoming wake-ups</h2>
            <span>Set by agents with wake_later; the same session resumes with the note.</span>
          </div>
          {wakeups.data?.length === 0 && <div className={own.none}>No pending wake-ups</div>}
          {wakeups.data?.map((w) => {
            const session = sessions.data?.find((x) => x.id === w.sessionId)
            return (
              <div key={w.id} className={own.wakeup}>
                <code className={own.when}>{formatDateTime(w.at)}</code>
                <span className={own.note}>{w.note}</span>
                <button type="button" className={own.wakeSession} onClick={() => navigate(`/s/${w.sessionId}`)}>{session?.title ?? 'Session'}</button>
                <button type="button" className={styles.rowButton} onClick={() => cancelWakeup.mutate(w.id)} disabled={cancelWakeup.isPending} aria-label="Cancel wake-up" title="Cancel">
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {editing && <ScheduleDialog schedule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {!desktop && <TabBar />}
    </div>
  )
}

const config = ({ name, provider, workspaceId, model, effort, permissionMode, prompt, kind, time, enabled }: ScheduleConfig): ScheduleConfig =>
  ({ name, provider, workspaceId, model, effort, permissionMode, prompt, kind, time, enabled })

// 一次性默认明天 9 点，周期默认 09:00
const tomorrowNine = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:00`
}

function ScheduleDialog({ schedule, onClose }: { schedule?: Schedule; onClose: () => void }) {
  const el = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!el.current!.open) el.current!.showModal()
  }, [])
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const [draft, setDraft] = useState<Omit<ScheduleConfig, 'model' | 'effort'> & { model?: string; effort?: string }>(() => schedule ? config(schedule) : {
    name: '', provider: 'claude', workspaceId: '', permissionMode: 'approval', prompt: '', kind: 'weekdays', time: '09:00', enabled: true,
  })
  // 新建时模型 / 思考等级跟设置走，和新建会话一样；保存的是具体值
  const defaults = settings.data?.[draft.provider]
  const model = draft.model ?? defaults?.model ?? ''
  const effort = draft.effort ?? defaults?.effort ?? ''
  const workspaceId = (workspaces.data?.some((w) => w.id === draft.workspaceId) ? draft.workspaceId : workspaces.data?.[0]?.id) ?? ''
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (body: ScheduleConfig) => (schedule ? api.updateSchedule(schedule.id, body) : api.createSchedule(body)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
      el.current!.close()
    },
  })
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }))

  return (
    <dialog ref={el} className={modal.dialog} style={{ overflow: 'visible', width: 'min(calc(100vw - 32px), 520px)' }} onClose={onClose} onClick={(e) => e.target === el.current && el.current.close()}>
      <div className={modal.box}>
        <div className={modal.head}>
          <div className={modal.title}>{schedule ? 'Edit scheduled task' : 'New scheduled task'}</div>
          <button type="button" className={modal.close} onClick={() => el.current!.close()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className={form.body}>
          <label className={form.field}>
            <span>Name</span>
            <input className={styles.input} value={draft.name} placeholder="Daily report" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <div className={form.pair}>
            <div className={form.field}>
              <span>Repeat</span>
              <Select ariaLabel="Repeat" value={draft.kind} options={kindOptions} onChange={(v) => set({ kind: v as ScheduleKind, time: v === 'once' ? tomorrowNine() : draft.kind === 'once' ? '09:00' : draft.time })} />
            </div>
            <label className={form.field}>
              <span>{draft.kind === 'once' ? 'Date and time' : 'Time'}</span>
              <input className={styles.input} type={draft.kind === 'once' ? 'datetime-local' : 'time'} value={draft.time} onChange={(e) => set({ time: e.target.value })} />
            </label>
          </div>
          <div className={form.field}>
            <span>Project</span>
            <Select ariaLabel="Project" searchable value={workspaceId} onChange={(v) => set({ workspaceId: v })} disabled={!workspaces.data} placeholder="No projects yet" options={(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.alias, hint: w.path }))} />
          </div>
          <div className={form.field}>
            <span>Agent</span>
            <Select ariaLabel="Agent" value={draft.provider} onChange={(v) => set({ provider: v as ProviderId, model: undefined, effort: undefined })} options={(Object.keys(providerName) as ProviderId[]).map((p) => ({ value: p, label: providerName[p] }))} />
          </div>
          <div className={form.pair}>
            <div className={form.field}>
              <span>Model</span>
              <Select ariaLabel="Model" value={model} onChange={(v) => set({ model: v, ...(!getEffortOptions(draft.provider, v).some((o) => o.value === effort) ? { effort: '' } : {}) })} options={[{ value: '', label: 'Default' }, ...modelOptions[draft.provider]]} />
            </div>
            {draft.provider !== 'deepseek' && <div className={form.field}>
              <span>Effort</span>
              <Select ariaLabel="Effort" value={effort} onChange={(v) => set({ effort: v })} options={[{ value: '', label: 'Default' }, ...getEffortOptions(draft.provider, model)]} />
            </div>}
          </div>
          <div className={form.field}>
            <span>Permission mode</span>
            <Select ariaLabel="Permission mode" value={draft.permissionMode} onChange={(v) => set({ permissionMode: v as PermissionMode })} options={[...permissionModeOptions]} />
            {draft.permissionMode === 'approval' && <div className={own.hint}>Runs unattended: it waits for you at the first approval.</div>}
            {draft.permissionMode === 'bypass' && <div className={form.error}>Runs any command without approval, with nobody watching. Use at your own risk.</div>}
          </div>
          <label className={form.field}>
            <span>Prompt</span>
            <textarea className={`${styles.input} ${own.prompt}`} value={draft.prompt} rows={5} onChange={(e) => set({ prompt: e.target.value })} />
          </label>
          {save.error && <div className={form.error}>{save.error.message}</div>}
        </div>
        <div className={modal.actions}>
          <button type="button" className={modal.secondary} onClick={() => el.current!.close()}>
            Cancel
          </button>
          <button
            type="button"
            className={modal.primary}
            disabled={!workspaceId || !draft.name.trim() || !draft.prompt.trim() || !draft.time || save.isPending}
            onClick={async () => {
              if (
                draft.permissionMode === 'bypass' && schedule?.permissionMode !== 'bypass' &&
                !(await dialog.confirm({
                  title: 'Schedule a task that bypasses approval?',
                  message: 'Every run will skip approval entirely and run any command without confirmation, while nobody is watching. Use at your own risk.',
                  ok: 'Save anyway',
                  danger: true,
                }))
              )
                return
              save.mutate({ ...draft, workspaceId, model, effort, name: draft.name.trim() })
            }}
          >
            {schedule ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
