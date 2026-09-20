import { useState } from 'react'
import { ChevronRight, LoaderCircle, Wrench, X } from 'lucide-react'
import type { ToolItem } from '../session/layout'
import styles from './ToolCard.module.css'

/**
 * 连续的工具调用折成一张卡（对齐 Turnwork 的命令组）：头部一行"跑了几个工具 · 最新一个的工具名 + 摘要"，点开才看逐条。
 * 运行中也折叠，摘要实时换成最新那条，流式过程里页面不会被工具卡刷屏。
 */
export function ToolGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const running = items.some((it) => !it.done)
  const failed = items.some((it) => it.isError)
  const last = items[items.length - 1]
  const state = running ? 'running' : failed ? 'failed' : 'done'
  return (
    <div className={styles.group} data-state={state}>
      <button type="button" className={styles.head} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <strong className={styles.title}>
          {running ? 'Running' : 'Ran'} {items.length} {items.length === 1 ? 'tool' : 'tools'}
        </strong>
        <code className={styles.summary}>
          {last.name} {last.summary}
        </code>
        <ChevronRight size={14} className={styles.chevron} data-open={open} />
      </button>
      {open && (
        <div className={styles.items}>
          {items.map((it) => (
            <ToolCard key={it.key} item={it} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 组内一行：状态图标 + 工具名 + 摘要；服务端不保存输出，没有可展开的东西 */
function ToolCard({ item }: { item: ToolItem }) {
  const state = !item.done ? 'running' : item.isError ? 'failed' : 'done'
  const Icon = state === 'running' ? LoaderCircle : state === 'failed' ? X : Wrench
  return (
    <div className={styles.card} data-state={state}>
      <Icon size={13} className={styles.icon} />
      <span className={styles.name}>{item.name}</span>
      <code className={styles.summary}>{item.summary}</code>
    </div>
  )
}
