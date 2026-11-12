import { useQuery } from '@tanstack/react-query'
import type { ProviderId, UsageInfo } from '@mindeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import styles from './RateMeter.module.css'

// Claude 的窗口只有 rateLimitType 没有时长；Codex 给了 windowDurationMins，按它标注
const fixedLabel: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
function label(u: UsageInfo) {
  if (fixedLabel[u.rateLimitType]) return fixedLabel[u.rateLimitType]
  const m = u.windowMinutes
  if (!m) return u.rateLimitType
  return m === 7 * 1440 ? 'week' : m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`
}

// 账号级额度，按 Provider 分组放侧栏。只取主额度：Claude 订阅的两条（opus/sonnet 细分、overage 不显示），Codex 的 primary / secondary。
// 数据是 Hub 内存缓存（只随 Provider 推送更新），与会话列表同样 5s 轮询
const shownTypes = ['five_hour', 'seven_day', 'primary', 'secondary']

// 周窗口按时间均匀消耗时"此刻应用到"的比例；用量超过它就是在透支后面几天的额度。5h 窗口太短，不标
function weekPace(u: UsageInfo) {
  if (label(u) !== 'week' || !u.resetsAt) return null
  return Math.min(1, Math.max(0, 1 - (u.resetsAt * 1000 - Date.now()) / (7 * 86400_000)))
}
export function RateMeter() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: api.getUsage, refetchInterval: 5000 })
  const groups = (['claude', 'codex'] as ProviderId[]).map((p) => ({ provider: p, items: shownTypes.flatMap((k) => (usage.data?.[k]?.provider === p ? [usage.data[k]] : [])) })).filter((g) => g.items.length > 0)
  if (groups.length === 0) return null
  return (
    <div className={styles.wrap}>
      {groups.map((g) => (
        <div key={g.provider} className={styles.group}>
          <span className={styles.provider}>{providerName[g.provider]}</span>
          {g.items.map((u) => {
            const pct = Math.round(u.utilization * 100)
            const pace = weekPace(u)
            const over = pace !== null && u.utilization > pace
            return (
              <div key={u.rateLimitType} className={styles.meter} title={`${label(u)} usage ${pct}%${u.resetsAt ? `, resets in ${formatUntil(u.resetsAt)}` : ''}`}>
                <span className={styles.label}>{label(u)}</span>
                <div className={styles.bar}>
                  <div className={`${styles.fill} ${over ? styles.over : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                  {pace !== null && <div className={styles.pace} style={{ left: `${pace * 100}%` }} />}
                </div>
                <code className={`${styles.value} ${over ? styles.over : ''}`}>{pct}%</code>
                {u.resetsAt && <code className={styles.reset}>{formatUntil(u.resetsAt)}</code>}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function formatUntil(unixSeconds: number) {
  const mins = Math.max(0, Math.round((unixSeconds * 1000 - Date.now()) / 60000))
  if (mins >= 24 * 60) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
}
