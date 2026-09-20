import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
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
  const [draft, setDraft] = useState<Settings | null>(null)
  useEffect(() => {
    if (saved.data && !draft) setDraft(saved.data)
  }, [saved.data, draft])
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (s) => {
      queryClient.setQueryData(['settings'], s)
      setDraft(s)
    },
  })
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved.data)
  const patch = (p: ProviderId, field: 'model' | 'effort' | 'permissionMode', value: string) => setDraft((d) => d && { ...d, [p]: { ...d[p], [field]: value } })
  // 只在从非 bypass 切到 bypass 时打断确认；已经是 bypass 时改别的字段不用每次都问
  const onSave = async () => {
    if (!draft) return
    for (const p of ['claude', 'codex'] as const) {
      if (draft[p].permissionMode !== 'bypass' || saved.data?.[p].permissionMode === 'bypass') continue
      const ok = await dialog.confirm({
        title: `Set the default permission mode for ${providerName[p]} to bypass approval?`,
        message: 'New sessions will run any command without approval, and any device that can reach this Hub can trigger it. Use at your own risk.',
        ok: 'Bypass approval',
        danger: true,
      })
      if (!ok) return
    }
    save.mutate(draft)
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
          (['claude', 'codex'] as const).map((p) => (
            <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className={styles.section}>{providerName[p]} defaults</div>
              <label className={styles.field}>
                <span>Model (leave empty for {providerName[p]}'s own default)</span>
                <Select value={draft[p].model} onChange={(v) => patch(p, 'model', v)} options={[{ value: '', label: 'Default' }, ...modelOptions[p]]} />
              </label>
              <label className={styles.field}>
                <span>Effort</span>
                <Select value={draft[p].effort} onChange={(v) => patch(p, 'effort', v)} options={[{ value: '', label: 'Default' }, ...effortOptions[p]]} />
              </label>
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
        {save.error ? <div className={styles.error}>{save.error.message}</div> : save.isSuccess && !dirty ? <div className={styles.ok}>Saved. Applies to sessions created from now on.</div> : null}
        {saved.error && <div className={styles.error}>{saved.error.message}</div>}
      </div>
    </div>
  )
}
