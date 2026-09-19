import type { ProviderId, UsageInfo } from '@agentdeck/shared'
import styles from './RateMeter.module.css'

// Claude 的窗口只有 rateLimitType 没有时长；Codex 给了 windowDurationMins，按它标注。顶栏空间有限，标签压成 5h / week 这种缩写
const fixedLabel: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
function label(u: UsageInfo) {
  if (fixedLabel[u.rateLimitType]) return fixedLabel[u.rateLimitType]
  const m = u.windowMinutes
  if (!m) return u.rateLimitType
  return m === 7 * 1440 ? 'week' : m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`
}

// 只展示当前会话 Provider 的主额度：Claude 取订阅的两条（opus/sonnet 细分、overage 不显示），Codex 取 primary / secondary
export function RateMeter({ provider, usage }: { provider: ProviderId; usage: Record<string, UsageInfo> }) {
  const shown = ['five_hour', 'seven_day', 'primary', 'secondary'].flatMap((k) => (usage[k]?.provider === provider ? [usage[k]] : []))
  if (shown.length === 0) return null
  return (
    <div className={styles.wrap}>
      {shown.map((u) => {
        const pct = Math.round(u.utilization * 100)
        return (
          <div key={u.rateLimitType} className={styles.meter} title={`${label(u)} 额度已用 ${pct}%${u.resetsAt ? `，${formatUntil(u.resetsAt)} 后重置` : ''}`}>
            <span className={styles.label}>{label(u)}</span>
            <div className={styles.bar}>
              <div className={styles.fill} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <code className={styles.value}>{pct}%</code>
            {u.resetsAt && <code className={styles.reset}>{formatUntil(u.resetsAt)}</code>}
          </div>
        )
      })}
    </div>
  )
}

function formatUntil(unixSeconds: number) {
  const mins = Math.max(0, Math.round((unixSeconds * 1000 - Date.now()) / 60000))
  if (mins >= 24 * 60) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
}
