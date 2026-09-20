import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import styles from './ProcessBlock.module.css'

type Props = { summary: string; open: boolean; onToggle: () => void; children: ReactNode }

/** 已结束一轮的中间过程：默认折成一张单行卡片（样式对齐工具组），点开才看工具卡和中间文本 */
export function ProcessBlock({ summary, open, onToggle, children }: Props) {
  return (
    <div className={styles.block}>
      <button type="button" className={styles.toggle} onClick={onToggle} aria-expanded={open}>
        <span className={styles.summary}>{summary}</span>
        <ChevronRight size={14} className={styles.chevron} data-open={open} />
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  )
}
