import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, LoaderCircle, X } from 'lucide-react'
import { summarizeToolInput } from '../format'
import styles from './ToolCard.module.css'

type Props = { name: string; input: unknown; output: string | null; isError: boolean }

/** 连续的工具卡并成一组：共用一个边框，行距压紧，避免 Read / Bash 一多就刷屏 */
export function ToolGroup({ children }: { children: ReactNode }) {
  return <div className={styles.group}>{children}</div>
}

export function ToolCard({ name, input, output, isError }: Props) {
  const [open, setOpen] = useState(false)
  const state = output === null ? 'running' : isError ? 'failed' : 'collapsed'
  const Icon = state === 'running' ? LoaderCircle : state === 'failed' ? X : Check
  return (
    <div className={styles.card} data-state={state}>
      <button type="button" className={styles.head} onClick={() => setOpen((v) => !v)} disabled={state === 'running'} aria-expanded={open}>
        <Icon size={14} className={styles.icon} />
        <span className={styles.name}>{name}</span>
        <code className={styles.summary}>{summarizeToolInput(input)}</code>
        {state !== 'running' && <ChevronRight size={14} className={styles.chevron} data-open={open} />}
      </button>
      {open && output !== null && <pre className={styles.output}>{output}</pre>}
    </div>
  )
}
