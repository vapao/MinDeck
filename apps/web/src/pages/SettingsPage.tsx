import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Eye, EyeOff } from 'lucide-react'
import { effortOptions, modelOptions, permissionModeOptions, type ProviderId, type Settings } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { Select } from '../components/Select'
import { dialog } from '../components/Dialog'
import styles from './Manage.module.css'
import layout from './SettingsPage.module.css'

// 应用级默认值：新建会话时用；已有会话不受影响。是否生效看会话头部的模型标签。

export function SettingsPage() {
  const queryClient = useQueryClient()
  const saved = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const testConnection = useMutation({ mutationFn: api.testDeepseek })
  const [apiKey, setApiKey] = useState<string | undefined>()
  const [revealedKey, setRevealedKey] = useState<string | undefined>()
  const [showKey, setShowKey] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [draft, setDraft] = useState<Settings | null>(null)
  useEffect(() => {
    if (saved.data && !draft) setDraft(saved.data)
  }, [saved.data, draft])
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (s) => {
      queryClient.setQueryData(['settings'], s)
      setDraft(s)
      setApiKey(undefined)
      setRevealedKey(undefined)
      setShowKey(false)
      testConnection.reset()
    },
  })
  const dirty = !!draft && (apiKey !== undefined || JSON.stringify(draft) !== JSON.stringify(saved.data))
  const patch = (p: ProviderId, field: 'model' | 'effort' | 'permissionMode', value: string) => setDraft((d) => d && { ...d, [p]: { ...d[p], [field]: value } })
  // 只在从非 bypass 切到 bypass 时打断确认；已经是 bypass 时改别的字段不用每次都问
  const onSave = async () => {
    if (!draft) return
    for (const p of ['claude', 'codex', 'deepseek'] as const) {
      if (draft[p].permissionMode !== 'bypass' || saved.data?.[p].permissionMode === 'bypass') continue
      const ok = await dialog.confirm({
        title: `Set the default permission mode for ${providerName[p]} to bypass approval?`,
        message: 'New sessions will run any command without approval, and any device that can reach this Hub can trigger it. Use at your own risk.',
        ok: 'Bypass approval',
        danger: true,
      })
      if (!ok) return
    }
    save.mutate({ ...draft, deepseek: { ...draft.deepseek, apiKey } })
  }

  const toggleKey = async () => {
    if (showKey) {
      setShowKey(false)
      setRevealedKey(undefined)
      return
    }
    if (apiKey === undefined && draft?.deepseek.apiKeyConfigured) {
      setRevealing(true)
      setKeyError('')
      try {
        const result = await api.revealDeepseekKey()
        setRevealedKey(result.apiKey)
        setShowKey(true)
      } catch (error) {
        setKeyError((error as Error).message)
      } finally {
        setRevealing(false)
      }
    } else setShowKey(true)
  }

  return (
    <div className={styles.page}>
      <div className={`${styles.card} ${layout.card}`}>
        <div className={styles.head}>
          <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="Back">
            <ChevronLeft size={18} />
          </button>
          <h1 className={styles.title}>Settings</h1>
        </div>
        {draft &&
          (['claude', 'codex', 'deepseek'] as const).map((p) => (
            <section key={p} className={layout.section} aria-labelledby={`${p}-heading`}>
              <div className={layout.sectionHead}>
                <h2 id={`${p}-heading`}>{providerName[p]}</h2>
                {p === 'deepseek' && !dirty && draft.deepseek.apiKeyConfigured && <button type="button" className={styles.secondary} disabled={save.isPending || testConnection.isPending} onClick={() => testConnection.mutate()}>
                  {testConnection.isPending ? 'Testing…' : 'Test connection'}
                </button>}
              </div>
              {p === 'deepseek' && <>
                <label className={`${styles.field} ${layout.field}`}>
                  <span>API endpoint</span>
                  <input className={styles.input} type="url" value={draft.deepseek.baseUrl} onChange={(e) => setDraft({ ...draft, deepseek: { ...draft.deepseek, baseUrl: e.target.value } })} spellCheck={false} />
                </label>
                <div className={`${styles.field} ${layout.field}`}>
                  <label htmlFor="deepseek-api-key">API Key</label>
                  <div className={styles.secret}>
                    <input id="deepseek-api-key" className={styles.input} type={showKey ? 'text' : 'password'}
                      value={apiKey ?? (showKey ? revealedKey ?? '' : '')}
                      placeholder={apiKey === '' ? 'Key will be removed on save' : draft.deepseek.apiKeyConfigured ? '••••••••••••••••' : 'Enter DeepSeek API key'}
                      autoComplete="off" spellCheck={false} disabled={revealing}
                      onChange={(e) => setApiKey(e.target.value || undefined)} />
                    <button type="button" className={styles.rowButton} disabled={revealing} onClick={toggleKey}
                      aria-label={showKey ? 'Hide API key' : 'Show API key'} aria-pressed={showKey} title={showKey ? 'Hide API key' : 'Show API key'}>
                      {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <div className={layout.keyMeta}>
                    <span>{draft.deepseek.apiKeyConfigured ? 'Saved. Leave blank to keep.' : 'Stored on this Hub.'}</span>
                    {draft.deepseek.apiKeyConfigured && <button type="button" className={layout.clearKey} onClick={() => { setApiKey(''); setRevealedKey(undefined); setShowKey(false) }}>Clear on save</button>}
                  </div>
                  {keyError && <div className={styles.error}>{keyError}</div>}
                </div>
              </>}
              <label className={`${styles.field} ${layout.field}`}>
                <span>Model</span>
                <Select value={draft[p].model} onChange={(v) => patch(p, 'model', v)} options={p === 'deepseek' ? [...modelOptions[p]] : [{ value: '', label: 'Default' }, ...modelOptions[p]]} />
              </label>
              {p !== 'deepseek' && <label className={`${styles.field} ${layout.field}`}>
                <span>Reasoning effort</span>
                <Select value={draft[p].effort} onChange={(v) => patch(p, 'effort', v)} options={[{ value: '', label: 'Default' }, ...effortOptions[p]]} />
              </label>}
              <label className={`${styles.field} ${layout.field}`}>
                <span>Permissions</span>
                <Select value={draft[p].permissionMode} onChange={(v) => patch(p, 'permissionMode', v)} options={[...permissionModeOptions]} />
                {draft[p].permissionMode === 'bypass' && <div className={styles.error}>Runs any command without approval; any device that can reach this Hub can trigger it. Use at your own risk.</div>}
              </label>
              {p === 'deepseek' && (testConnection.error || (testConnection.data && !dirty)) && <div className={layout.connectionInfo}>
                {testConnection.error && <div className={styles.error}>{testConnection.error.message}</div>}
                {testConnection.data && !dirty && <div className={styles.ok}>Connected: {testConnection.data.baseUrl} · {testConnection.data.model}</div>}
              </div>}
            </section>
          ))}
        <div className={layout.footer}>
          <button type="button" className={styles.primary} disabled={!dirty || save.isPending} onClick={onSave}>
            Save changes
          </button>
        </div>
        {save.error ? <div className={styles.error}>{save.error.message}</div> : save.isSuccess && !dirty ? <div className={styles.ok}>Saved. Defaults apply to new sessions; API changes apply when DeepSeek next starts.</div> : null}
        {saved.error && <div className={styles.error}>{saved.error.message}</div>}
      </div>
    </div>
  )
}
