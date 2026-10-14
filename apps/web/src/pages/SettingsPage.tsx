import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Eye, EyeOff } from 'lucide-react'
import { getEffortOptions, modelOptions, permissionModeOptions, type ProviderId, type Settings } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { readLocalSettings, saveLocalSettings } from '../components/FilePreview'
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
  const [localSettings, setLocalSettings] = useState(readLocalSettings)
  const [savedLocalSettings, setSavedLocalSettings] = useState(localSettings)
  const [localError, setLocalError] = useState('')
  const [didSave, setDidSave] = useState(false)
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
  const serverDirty = !!draft && (apiKey !== undefined || JSON.stringify(draft) !== JSON.stringify(saved.data))
  const localDirty = JSON.stringify(localSettings) !== JSON.stringify(savedLocalSettings)
  const dirty = serverDirty || localDirty
  const patch = (p: ProviderId, field: 'model' | 'effort' | 'permissionMode', value: string) => setDraft((d) => d && {
    ...d,
    [p]: {
      ...d[p], [field]: value,
      ...(field === 'model' && !getEffortOptions(p, value).some((option) => option.value === d[p].effort) ? { effort: '' } : {}),
    },
  })
  // 只在从非 bypass 切到 bypass 时打断确认；已经是 bypass 时改别的字段不用每次都问
  const onSave = async () => {
    if (!dirty) return
    const nextLocal = { remote: localSettings.remote.trim(), local: localSettings.local.trim(), sshHost: localSettings.sshHost.trim() }
    if (localDirty) {
      if (!nextLocal.remote.startsWith('/') || (nextLocal.local && !nextLocal.local.startsWith('/'))) {
        setLocalError('Use absolute paths starting with / for the Finder mapping.')
        return
      }
      if (nextLocal.sshHost && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(nextLocal.sshHost)) {
        setLocalError('Enter an SSH host alias or user@hostname, without spaces or command options.')
        return
      }
    }
    setLocalError('')
    if (serverDirty) {
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
      try {
        await save.mutateAsync({ ...draft, deepseek: { ...draft.deepseek, apiKey } })
      } catch {
        return
      }
    }
    if (localDirty) {
      if (!serverDirty) save.reset()
      try {
        saveLocalSettings(nextLocal)
      } catch {
        setLocalError('Could not save settings in this browser. Check browser storage permissions.')
        return
      }
      setLocalSettings(nextLocal)
      setSavedLocalSettings(nextLocal)
    }
    setDidSave(true)
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
        <div className={`${styles.scroll} ${layout.body}`}>
          {draft &&
            (['claude', 'codex', 'deepseek'] as const).map((p) => (
              <section key={p} className={layout.section} aria-labelledby={`${p}-heading`}>
                <div className={layout.sectionHead}>
                  <h2 id={`${p}-heading`}>{providerName[p]}</h2>
                  {p === 'deepseek' && !serverDirty && draft.deepseek.apiKeyConfigured && <button type="button" className={styles.secondary} disabled={save.isPending || testConnection.isPending} onClick={() => testConnection.mutate()}>
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
                <div className={`${styles.field} ${layout.field}`}>
                  <span>Model</span>
                  <Select ariaLabel={`${providerName[p]} model`} value={draft[p].model} onChange={(v) => patch(p, 'model', v)} options={p === 'deepseek' ? [...modelOptions[p]] : [{ value: '', label: 'Default' }, ...modelOptions[p]]} />
                </div>
                {p !== 'deepseek' && <div className={`${styles.field} ${layout.field}`}>
                  <span>Reasoning effort</span>
                  <Select ariaLabel={`${providerName[p]} reasoning effort`} value={draft[p].effort} onChange={(v) => patch(p, 'effort', v)} options={[{ value: '', label: 'Default' }, ...getEffortOptions(p, draft[p].model)]} />
                </div>}
                <div className={`${styles.field} ${layout.field}`}>
                  <span>Permissions</span>
                  <Select ariaLabel={`${providerName[p]} permissions`} value={draft[p].permissionMode} onChange={(v) => patch(p, 'permissionMode', v)} options={[...permissionModeOptions]} />
                  {draft[p].permissionMode === 'bypass' && <div className={styles.error}>Runs any command without approval; any device that can reach this Hub can trigger it. Use at your own risk.</div>}
                </div>
                {p === 'deepseek' && (testConnection.error || (testConnection.data && !serverDirty)) && <div className={layout.connectionInfo}>
                  {testConnection.error && <div className={styles.error}>{testConnection.error.message}</div>}
                  {testConnection.data && !serverDirty && <div className={styles.ok}>Connected: {testConnection.data.baseUrl} · {testConnection.data.model}</div>}
                </div>}
              </section>
            ))}
          {draft?.titles && <section className={layout.section} aria-labelledby="titles-heading">
            <div className={layout.sectionHead}><h2 id="titles-heading">AI session titles</h2></div>
            <div className={`${styles.field} ${layout.field}`}>
              <span>Automatic titles</span>
              <Select ariaLabel="Automatic titles" value={String(draft.titles.enabled)} options={[{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }]} onChange={(v) => setDraft({ ...draft, titles: { ...draft.titles, enabled: v === 'true' } })} />
            </div>
            <div className={`${styles.field} ${layout.field}`}>
              <span>Provider</span>
              <Select ariaLabel="Title provider" value={draft.titles.provider} options={(['claude', 'codex', 'deepseek'] as const).map((value) => ({ value, label: providerName[value] }))} onChange={(v) => {
                const provider = v as ProviderId
                setDraft({ ...draft, titles: { ...draft.titles, provider, model: modelOptions[provider][0]!.value } })
              }} />
            </div>
            <div className={`${styles.field} ${layout.field}`}>
              <span>Model</span>
              <Select ariaLabel="Title model" value={draft.titles.model} options={[...modelOptions[draft.titles.provider]]} onChange={(model) => setDraft({ ...draft, titles: { ...draft.titles, model } })} />
            </div>
            <p className={layout.connectionInfo}>Generates a title of up to 15 characters once, after the first text message. Sends that text to the selected provider in an extra request using your existing sign-in or API key. Uses additional quota or API credits. Existing conversations are not renamed; failures keep the message preview.</p>
          </section>}
          <section className={layout.section} aria-labelledby="finder-heading">
            <div className={layout.sectionHead}><h2 id="finder-heading">Finder on this Mac</h2></div>
            <label className={`${styles.field} ${layout.field}`}>
              <span>Mac Mini folder</span>
              <input className={styles.input} value={localSettings.remote} onChange={(e) => { setLocalSettings({ ...localSettings, remote: e.target.value }); setLocalError('') }} placeholder="/Users/aka" />
            </label>
            <label className={`${styles.field} ${layout.field}`}>
              <span>Mounted folder on this Mac</span>
              <input className={styles.input} value={localSettings.local} onChange={(e) => { setLocalSettings({ ...localSettings, local: e.target.value }); setLocalError('') }} placeholder="/Volumes/Your share" />
            </label>
            <p className={layout.connectionInfo}>Saved in this browser only. Map a Mac Mini folder to its mounted path; clear the mounted folder to disable. Install AgentDeck Finder on your MacBook with <code>scripts/install-finder-helper.sh</code>.</p>
          </section>
          <section className={layout.section} aria-labelledby="terminal-heading">
            <div className={layout.sectionHead}><h2 id="terminal-heading">iTerm2 on this Mac</h2></div>
            <label className={`${styles.field} ${layout.field}`}>
              <span>SSH host</span>
              <input className={styles.input} value={localSettings.sshHost} placeholder="mac-mini" autoCapitalize="none" spellCheck={false} onChange={(e) => { setLocalSettings({ ...localSettings, sshHost: e.target.value }); setLocalError('') }} />
            </label>
            <p className={layout.connectionInfo}>Use a host alias from ~/.ssh/config or user@hostname. Configure ports and keys in SSH config. Saved in this browser only; Finder mapping is not used.</p>
          </section>
          <div className={layout.footer}>
            <button type="button" className={styles.primary} disabled={!dirty || save.isPending} onClick={onSave}>
              Save changes
            </button>
          </div>
          {localError ? <div className={styles.error}>{localError}</div> : save.error ? <div className={styles.error}>{save.error.message}</div> : didSave && !dirty ? <div className={styles.ok}>Saved.</div> : null}
          {saved.error && <div className={styles.error}>{saved.error.message}</div>}
        </div>
      </div>
    </div>
  )
}
