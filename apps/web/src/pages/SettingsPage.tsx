import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { effortLevels, type ProviderId, type Settings } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { Select } from '../components/Select'
import styles from './Manage.module.css'

// 应用级默认值：新建会话时用；已有会话不受影响。模型填别名或完整 id，是否生效看会话头部的模型标签。
// Claude Code 接受 opus / sonnet / haiku 别名；Codex 的模型目录随版本变，不猜，让用户填 config.toml 里那种 id
const modelHints: Record<ProviderId, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: [] }

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
  const patch = (p: ProviderId, field: 'model' | 'effort', value: string) => setDraft((d) => d && { ...d, [p]: { ...d[p], [field]: value } })

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.head}>
          <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="返回">
            <ChevronLeft size={18} />
          </button>
          <h1 className={styles.title}>设置</h1>
        </div>
        {draft &&
          (['claude', 'codex'] as const).map((p) => (
            <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className={styles.section}>{providerName[p]} 默认值</div>
              <label className={styles.field}>
                <span>模型（留空用 {providerName[p]} 自己的默认）</span>
                <input className={styles.input} value={draft[p].model} placeholder={p === 'codex' ? '如 ~/.codex/config.toml 里的 model' : '默认'} onChange={(e) => patch(p, 'model', e.target.value)} />
                <div className={styles.chips}>
                  {modelHints[p].map((m) => (
                    <button key={m} type="button" className={styles.chip} onClick={() => patch(p, 'model', m)}>
                      {m}
                    </button>
                  ))}
                </div>
              </label>
              <label className={styles.field}>
                <span>思考等级</span>
                <Select value={draft[p].effort} onChange={(v) => patch(p, 'effort', v)} options={[{ value: '', label: '默认' }, ...effortLevels[p].map((l) => ({ value: l, label: l }))]} />
              </label>
            </div>
          ))}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={!dirty || save.isPending} onClick={() => draft && save.mutate(draft)}>
            保存
          </button>
        </div>
        {save.error ? <div className={styles.error}>{save.error.message}</div> : save.isSuccess && !dirty ? <div className={styles.ok}>已保存，对之后新建的会话生效</div> : null}
        {saved.error && <div className={styles.error}>{saved.error.message}</div>}
      </div>
    </div>
  )
}
