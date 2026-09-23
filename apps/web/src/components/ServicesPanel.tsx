import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Pencil, Play, Plus, RotateCw, Square, Trash2 } from 'lucide-react'
import type { Service, ServiceConfig } from '@agentdeck/shared'
import { api } from '../api'
import { dialog } from './Dialog'
import panel from './ChangesPanel.module.css'
import styles from './ServicesPanel.module.css'

// 侧栏分组头的运行点也用它，同一个 query 共享轮询
export const useServices = () => useQuery({ queryKey: ['services'], queryFn: api.listServices, refetchInterval: 5000 })

type Props = { cwd: string; active: boolean }

// 项目服务（切片 14）：当前会话所在项目的开发服务，配置、启停与日志都在这里
export function ServicesPanel({ cwd, active }: Props) {
  const queryClient = useQueryClient()
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const services = useServices()
  const workspace = workspaces.data?.find((w) => w.path === cwd)
  const items = services.data?.filter((s) => s.workspaceId === workspace?.id) ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Service | 'new' | null>(null)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['services'] })
  const onError = (err: Error) => dialog.alert({ title: 'Service error', message: err.message })
  const action = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) => api.serviceAction(id, action), onSettled: invalidate, onError })
  const remove = useMutation({ mutationFn: api.deleteService, onSuccess: invalidate, onError })

  const onRemove = async (s: Service) => {
    if (await dialog.confirm({ title: `Delete service "${s.name}"?`, ok: 'Delete', danger: true })) remove.mutate(s.id)
  }
  const busy = (id: string) => action.isPending && action.variables?.id === id

  if (!workspace) return <div className={panel.filesPane} style={{ display: active ? 'flex' : 'none' }}><div className={panel.empty}>{workspaces.data ? 'This directory is not a registered project' : '…'}</div></div>
  const current = items.find((s) => s.id === selected)
  return (
    <div className={panel.filesPane} style={{ display: active ? 'flex' : 'none' }}>
      <div className={styles.list}>
        {items.length === 0 && !editing && <div className={panel.empty}>No services yet</div>}
        {items.map((s) => (
          <div key={s.id} className={styles.row} data-selected={s.id === selected || undefined} onClick={() => setSelected(s.id)}>
            <span className={styles.dot} data-running={s.running || undefined} title={s.running ? 'Running' : 'Stopped'} />
            <span className={styles.rowBody}>
              <span className={styles.name}>{s.name}</span>
              <code className={styles.command} title={s.command}>{s.subdir ? `${s.subdir}$ ` : '$ '}{s.command}</code>
            </span>
            <span className={styles.actions} onClick={(e) => e.stopPropagation()}>
              {s.url && <a className={panel.iconButton} href={s.url} target="_blank" rel="noreferrer" title={s.url}><ExternalLink size={14} /></a>}
              {s.running ? <>
                <button type="button" className={panel.iconButton} disabled={busy(s.id)} onClick={() => { setSelected(s.id); action.mutate({ id: s.id, action: 'restart' }) }} title="Restart"><RotateCw size={14} className={busy(s.id) ? panel.spin : undefined} /></button>
                <button type="button" className={panel.iconButton} disabled={busy(s.id)} onClick={() => action.mutate({ id: s.id, action: 'stop' })} title="Stop"><Square size={13} /></button>
              </> : <>
                <button type="button" className={panel.iconButton} disabled={busy(s.id)} onClick={() => { setSelected(s.id); action.mutate({ id: s.id, action: 'start' }) }} title="Start"><Play size={14} /></button>
                <button type="button" className={panel.iconButton} onClick={() => setEditing(s)} title="Edit"><Pencil size={14} /></button>
                <button type="button" className={panel.iconButton} onClick={() => onRemove(s)} title="Delete"><Trash2 size={14} /></button>
              </>}
            </span>
          </div>
        ))}
        {editing ? (
          <ServiceForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? { name: '', command: '', subdir: '', url: '' } : editing}
            onCancel={() => setEditing(null)}
            onSave={async (config) => {
              if (editing === 'new') setSelected((await api.createService({ ...config, workspaceId: workspace.id })).id)
              else await api.updateService(editing.id, config)
              await invalidate()
              setEditing(null)
            }}
          />
        ) : (
          <button type="button" className={styles.add} onClick={() => setEditing('new')}><Plus size={14} />Add service</button>
        )}
      </div>
      {current && <ServiceLog key={current.id} service={current} active={active} />}
    </div>
  )
}

function ServiceForm({ initial, onCancel, onSave }: { initial: ServiceConfig; onCancel: () => void; onSave: (c: ServiceConfig) => Promise<void> }) {
  const [config, setConfig] = useState(initial)
  const save = useMutation({ mutationFn: onSave })
  const field = (key: keyof ServiceConfig, label: string, placeholder: string) => (
    <label className={styles.field}>
      <span>{label}</span>
      <input value={config[key]} placeholder={placeholder} onChange={(e) => setConfig({ ...config, [key]: e.target.value })} />
    </label>
  )
  return (
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); save.mutate(config) }}>
      {field('name', 'Name', 'web')}
      {field('command', 'Command', 'pnpm dev')}
      {field('subdir', 'Directory (relative to project)', 'apps/web')}
      {field('url', 'Link', 'https://mac-mini.tailnet.ts.net:8451')}
      {save.error && <div className={styles.error}>{save.error.message}</div>}
      <div className={styles.formActions}>
        <button type="button" className={styles.secondary} onClick={onCancel}>Cancel</button>
        <button type="submit" className={styles.primary} disabled={!config.name.trim() || !config.command.trim() || save.isPending}>Save</button>
      </div>
    </form>
  )
}

// 大多数工具在非 TTY 下不输出颜色，个别强制输出的去掉控制序列
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const maxLogChars = 256 * 1024

// 日志增量轮询：cursor 由服务端给，服务重启后 reset 清空重来
function ServiceLog({ service, active }: { service: Service; active: boolean }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cursor = useRef('')
  const el = useRef<HTMLPreElement>(null)
  const follow = useRef(true)

  useEffect(() => {
    if (!active) return
    let stopped = false
    const poll = async () => {
      try {
        const r = await api.serviceLog(service.id, cursor.current)
        if (stopped) return
        cursor.current = r.cursor
        setError(null)
        if (r.reset || r.text) setText((prev) => (r.reset ? '' : prev).concat(stripAnsi(r.text)).slice(-maxLogChars))
      } catch (err) {
        if (!stopped) setError((err as Error).message)
      }
    }
    void poll()
    const t = setInterval(poll, 1500)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [service.id, active])

  useLayoutEffect(() => {
    if (follow.current && el.current) el.current.scrollTop = el.current.scrollHeight
  }, [text])

  return (
    <div className={styles.log}>
      <div className={styles.logHead}>{service.name} · log</div>
      <pre
        ref={el}
        className={styles.logBody}
        onScroll={(e) => {
          const t = e.currentTarget
          follow.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24
        }}
      >
        {text || <span className={styles.logEmpty}>{error ?? 'No output'}</span>}
      </pre>
    </div>
  )
}
