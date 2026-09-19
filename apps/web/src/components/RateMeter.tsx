import type { UsageInfo } from '@agentdeck/shared'
import styles from './RateMeter.module.css'

const label: Record<string, string> = { five_hour: '5 小时额度', seven_day: '7 天额度' }

// 只展示订阅的两条主额度；其余 rateLimitType（opus/sonnet 细分、overage）暂不显示
export function RateMeter({ usage }: { usage: Record<string, UsageInfo> }) {
  const shown = ['five_hour', 'seven_day'].flatMap((k) => (usage[k] ? [usage[k]] : []))
  if (shown.length === 0) return null
  return (
    <div className={styles.wrap}>
      {shown.map((u) => (
        <div key={u.rateLimitType} className={styles.meter} title={label[u.rateLimitType]}>
          <div className={styles.head}>
            <span className={styles.label}>{label[u.rateLimitType]}</span>
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
