import type { ProviderId, UsageInfo } from '@agentdeck/shared'
import styles from './RateMeter.module.css'

// Claude 的窗口只有 rateLimitType 没有时长；Codex 给了 windowDurationMins，按它标注
const fixedLabel: Record<string, string> = { five_hour: '5 小时额度', seven_day: '7 天额度' }
const label = (u: UsageInfo) => fixedLabel[u.rateLimitType] ?? (u.windowMinutes ? `${u.windowMinutes >= 1440 ? `${Math.round(u.windowMinutes / 1440)} 天` : `${Math.round(u.windowMinutes / 60)} 小时`}额度` : u.rateLimitType)

// 只展示当前会话 Provider 的主额度：Claude 取订阅的两条（opus/sonnet 细分、overage 不显示），Codex 取 primary / secondary
export function RateMeter({ provider, usage }: { provider: ProviderId; usage: Record<string, UsageInfo> }) {
  const shown = ['five_hour', 'seven_day', 'primary', 'secondary'].flatMap((k) => (usage[k]?.provider === provider ? [usage[k]] : []))
  if (shown.length === 0) return null
  return (
    <div className={styles.wrap}>
      {shown.map((u) => (
        <div key={u.rateLimitType} className={styles.meter} title={label(u)}>
          <div className={styles.head}>
            <span className={styles.label}>{label(u)}</span>
            <code className={styles.value}>
              {Math.round(u.utilization * 100)}%{u.resetsAt ? ` · 重置 ${formatUntil(u.resetsAt)}` : ''}
            </code>
          </div>
          <div className={styles.bar}>
            <div className={styles.fill} style={{ width: `${Math.min(100, Math.round(u.utilization * 100))}%` }} />
          </div>
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
