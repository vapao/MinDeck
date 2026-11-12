import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react'
import { secretNamePattern, type Secret } from '@mindeck/shared'
import { api } from '../api'
import { dialog } from './Dialog'
import { Select } from './Select'
import modal from './Dialog.module.css'
import form from './NewSessionDialog.module.css'
import manage from '../pages/Manage.module.css'
import settings from '../pages/SettingsPage.module.css'
import rows from '../pages/WorkspacesPage.module.css'

// 设置页的密钥管理。Agent 经 MCP request_secret 存进来的也在这里；值只在点眼睛时单独取，列表不带
export function SecretsSection() {
  const queryClient = useQueryClient()
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: api.listSecrets })
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const [editing, setEditing] = useState<Secret | 'new' | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const reveal = useMutation({ mutationFn: api.getSecretValue, onSuccess: (r, id) => setRevealed((v) => ({ ...v, [id]: r.value })) })
  const remove = useMutation({ mutationFn: api.deleteSecret, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['secrets'] }) })
  const scopeName = (workspaceId: string | null) => workspaceId ? workspaces.data?.find((w) => w.id === workspaceId)?.alias ?? 'Project' : 'Shared'
  const toggle = (id: string) => {
    if (id in revealed) setRevealed(({ [id]: _, ...rest }) => rest)
    else reveal.mutate(id)
  }
  const onRemove = async (s: Secret) => {
    if (await dialog.confirm({ title: `Delete secret ${s.name}?`, message: `Scope: ${scopeName(s.workspaceId)}. Agents that use it will fail until it is saved again.`, ok: 'Delete', danger: true })) remove.mutate(s.id)
  }
  const error = secrets.error ?? reveal.error ?? remove.error

  return (
    <section className={settings.section} aria-labelledby="secrets-heading">
      <div className={settings.sectionHead}>
        <h2 id="secrets-heading">Secrets</h2>
        <button type="button" className={`${manage.secondary} ${rows.add}`} onClick={() => setEditing('new')}>
          <Plus size={14} /> Add secret
        </button>
      </div>
      {secrets.data?.length === 0 && <div className={manage.empty}>No secrets yet</div>}
      {secrets.data?.map((s) => (
        <div key={s.id} className={rows.item}>
          <KeyRound size={16} />
          <div className={rows.main}>
            <code className={rows.name} title={s.name}>{s.name}</code>
            <span className={rows.path} title={s.id in revealed ? undefined : s.description}>
              {s.id in revealed ? <code>{revealed[s.id]}</code> : [scopeName(s.workspaceId), s.username, s.description || 'No description'].filter(Boolean).join(' · ')}
            </span>
          </div>
          <div className={rows.actions}>
            <button type="button" className={manage.rowButton} disabled={reveal.isPending} onClick={() => toggle(s.id)} aria-label={s.id in revealed ? 'Hide value' : 'Show value'} title={s.id in revealed ? 'Hide value' : 'Show value'}>
              {s.id in revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button type="button" className={manage.rowButton} onClick={() => setEditing(s)} aria-label="Edit" title="Edit">
              <Pencil size={14} />
            </button>
            <button type="button" className={manage.rowButton} data-danger disabled={remove.isPending} onClick={() => onRemove(s)} aria-label="Delete" title="Delete">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      {error && <div className={manage.error}>{error.message}</div>}
      <p className={settings.connectionInfo}>Agents ask for secrets with request_secret and read them in shell commands without seeing the value in chat. This is not isolation: any agent on this Hub can read every secret from the database. Secrets are stored in plain text in data/mindeck.db.</p>
      {editing && <SecretDialog secret={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => setRevealed(({ [id]: _, ...rest }) => rest)} />}
    </section>
  )
}

function SecretDialog({ secret, onClose, onSaved }: { secret: Secret | null; onClose: () => void; onSaved: (id: string) => void }) {
  const el = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!el.current!.open) el.current!.showModal()
  }, [])
  const queryClient = useQueryClient()
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const [name, setName] = useState(secret?.name ?? '')
  const [workspaceId, setWorkspaceId] = useState(secret?.workspaceId ?? null)
  const [username, setUsername] = useState(secret?.username ?? '')
  const [description, setDescription] = useState(secret?.description ?? '')
  const [value, setValue] = useState('')
  const save = useMutation({
    mutationFn: () => secret
      ? api.updateSecret(secret.id, { workspaceId, username: username || null, description, ...(value ? { value } : {}) })
      : api.saveSecret({ workspaceId, name, username: username || null, description, value }),
    onSuccess: (s) => {
      queryClient.invalidateQueries({ queryKey: ['secrets'] })
      onSaved(s.id)
      el.current!.close()
    },
  })
  const scopes = [{ value: '', label: 'Shared', hint: 'Every project' }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.alias, hint: w.path }))]
  const valid = secret ? true : new RegExp(secretNamePattern).test(name) && value.length > 0

  return (
    <dialog ref={el} className={modal.dialog} style={{ overflow: 'visible', width: 'min(calc(100vw - 32px), 520px)' }} onClose={onClose} onClick={(e) => e.target === el.current && el.current.close()}>
      <div className={modal.box}>
        <div className={modal.head}>
          <div className={modal.title}>{secret ? `Edit ${secret.name}` : 'Add secret'}</div>
          <button type="button" className={modal.close} onClick={() => el.current!.close()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className={form.body}>
          {!secret && (
            <label className={form.field}>
              <span>Name</span>
              <input className={manage.input} value={name} autoFocus placeholder="GITHUB_TOKEN_MINDECK" autoCapitalize="none" spellCheck={false} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <div className={form.field}>
            <span>Scope</span>
            <Select ariaLabel="Scope" value={workspaceId ?? ''} onChange={(v) => setWorkspaceId(v || null)} options={scopes} />
          </div>
          <label className={form.field}>
            <span>Description</span>
            <input className={manage.input} value={description} placeholder="What it is for; agents choose secrets by this" onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className={form.field}>
            <span>Username</span>
            <input className={manage.input} value={username} placeholder="Optional; set it to store a login, with the password as value" autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className={form.field}>
            <span>{username ? 'Password' : 'Value'}</span>
            <input className={manage.input} type="password" value={value} placeholder={secret ? 'Leave blank to keep' : ''} autoComplete="off" spellCheck={false} onChange={(e) => setValue(e.target.value)} />
          </label>
          {!secret && <div className={settings.keyMeta}>A secret with the same name in the same scope is overwritten.</div>}
          {save.error && <div className={form.error}>{save.error.message}</div>}
        </div>
        <div className={modal.actions}>
          <button type="button" className={modal.secondary} onClick={() => el.current!.close()}>Cancel</button>
          <button type="button" className={modal.primary} disabled={!valid || save.isPending} onClick={() => save.mutate()}>Save</button>
        </div>
      </div>
    </dialog>
  )
}
