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
      <div className={styles.card}>
        <div className={styles.head}>
          <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="Back">
            <ChevronLeft size={18} />
          </button>
          <h1 className={styles.title}>Settings</h1>
        </div>
        {draft &&
          (['claude', 'codex', 'deepseek'] as const).map((p) => (
            <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className={styles.section}>{providerName[p]} defaults</div>
              {p === 'deepseek' && <>
                <label className={styles.field}>
                  <span>API 地址</span>
                  <input className={styles.input} type="url" value={draft.deepseek.baseUrl} onChange={(e) => setDraft({ ...draft, deepseek: { ...draft.deepseek, baseUrl: e.target.value } })} spellCheck={false} />
                </label>
                <div className={styles.field}>
                  <label htmlFor="deepseek-api-key">API Key</label>
                  <div className={styles.secret}>
                    <input id="deepseek-api-key" className={styles.input} type={showKey ? 'text' : 'password'}
                      value={apiKey ?? (showKey ? revealedKey ?? '' : '')}
                      placeholder={apiKey === '' ? '保存后清除密钥' : draft.deepseek.apiKeyConfigured ? '••••••••••••••••' : '输入 DeepSeek API Key'}
                      autoComplete="off" spellCheck={false} disabled={revealing}
                      onChange={(e) => setApiKey(e.target.value || undefined)} />
                    <button type="button" className={styles.rowButton} disabled={revealing} onClick={toggleKey}
                      aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey} title={showKey ? '隐藏 API Key' : '显示 API Key'}>
                      {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <span>{draft.deepseek.apiKeyConfigured ? '已配置；留空不修改，点击眼睛可查看。' : '密钥保存在这台 Hub 上。'}</span>
                  {draft.deepseek.apiKeyConfigured && <button type="button" className={styles.secondary} onClick={() => { setApiKey(''); setRevealedKey(undefined); setShowKey(false) }}>清除密钥（保存后生效）</button>}
                  {keyError && <div className={styles.error}>{keyError}</div>}
                </div>
                <div className={styles.actions}>
                  <button type="button" className={styles.secondary} disabled={dirty || save.isPending || testConnection.isPending || !draft.deepseek.apiKeyConfigured} onClick={() => testConnection.mutate()}>
                    {testConnection.isPending ? '验证中…' : '验证连接'}
                  </button>
                </div>
                <div className={styles.ok}>先保存再验证；会发送一次简短请求，产生少量 API 费用。</div>
                {testConnection.error && <div className={styles.error}>{testConnection.error.message}</div>}
                {testConnection.data && !dirty && <div className={styles.ok}>连接成功：{testConnection.data.baseUrl} · {testConnection.data.model}</div>}
              </>}
              <label className={styles.field}>
                <span>{p === 'deepseek' ? 'Model' : `Model (leave empty for ${providerName[p]}'s own default)`}</span>
                <Select value={draft[p].model} onChange={(v) => patch(p, 'model', v)} options={p === 'deepseek' ? [...modelOptions[p]] : [{ value: '', label: 'Default' }, ...modelOptions[p]]} />
              </label>
              {p !== 'deepseek' && <label className={styles.field}>
                <span>Effort</span>
                <Select value={draft[p].effort} onChange={(v) => patch(p, 'effort', v)} options={[{ value: '', label: 'Default' }, ...effortOptions[p]]} />
              </label>}
              <label className={styles.field}>
                <span>Permission mode</span>
                <Select value={draft[p].permissionMode} onChange={(v) => patch(p, 'permissionMode', v)} options={[...permissionModeOptions]} />
                {draft[p].permissionMode === 'bypass' && <div className={styles.error}>Runs any command without approval; any device that can reach this Hub can trigger it. Use at your own risk.</div>}
              </label>
            </div>
          ))}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={!dirty || save.isPending} onClick={onSave}>
            Save
          </button>
        </div>
        {save.error ? <div className={styles.error}>{save.error.message}</div> : save.isSuccess && !dirty ? <div className={styles.ok}>已保存。模型与权限默认值用于新会话；API 配置在 DeepSeek 会话进程下次启动时生效。</div> : null}
        {saved.error && <div className={styles.error}>{saved.error.message}</div>}
      </div>
    </div>
  )
}
