import type { Attachment } from '@agentdeck/shared'
import { GitBranch } from 'lucide-react'
import { api } from '../api'
import { formatTime } from '../format'
import { splitRefs } from '../refs'
import styles from './UserMessage.module.css'

/** skill：开头 $name 已确认是 skill 时传入，渲染成标签 */
export function UserMessage({ text, attachments, at, skill, onRewind }: { text: string; attachments: Attachment[]; at: string; skill?: string; onRewind?: () => void }) {
  return (
    <div className={styles.row}>
      <div className={styles.meta}>
        {onRewind && (
          <button type="button" className={styles.rewind} onClick={onRewind} title="Fork or rewind to before this message">
            <GitBranch size={12} /> Rewind
          </button>
        )}
        You · {formatTime(at)}
      </div>
      <div className={styles.bubble}>
        {attachments.length > 0 && (
          <div className={styles.images}>
            {attachments.map((a) => (
              <a key={a.id} href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" className={styles.thumb} title={a.name}>
                <img src={api.attachmentUrl(a.id)} alt={a.name} loading="lazy" />
              </a>
            ))}
          </div>
        )}
        {text && (
          <div className={styles.text}>
            {splitRefs(text, skill).map((s, i) => (s.kind === 'text' ? s.text : <span key={i} className={s.kind === 'skill' ? styles.skill : styles.file}>{s.text}</span>))}
          </div>
        )}
      </div>
    </div>
  )
}
