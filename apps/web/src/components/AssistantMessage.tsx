import type { ComponentProps } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProviderId } from '@agentdeck/shared'
import { formatTime } from '../format'
import styles from './AssistantMessage.module.css'

const plugins = [remarkGfm]
// 链接一律开新标签，不把会话页跳走；react-markdown 会附带 hast node，不能透传到 DOM
const components = {
  a({ node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
    void node
    return <a {...props} target="_blank" rel="noreferrer" />
  },
}

type Props = { provider: ProviderId; text: string; streaming: boolean; at: string; /** 一轮里只有第一段带头部，后面的段落直接接上 */ showMeta: boolean }

export function AssistantMessage({ provider, text, streaming, at, showMeta }: Props) {
  return (
    <div className={styles.row}>
      {showMeta && (
        <div className={styles.meta}>
          <span className={styles.avatar}>{provider === 'codex' ? 'X' : 'C'}</span>
          {provider} · {formatTime(at)}
        </div>
      )}
      <div className={styles.body} data-streaming={streaming || undefined}>
        <Markdown remarkPlugins={plugins} components={components}>{text}</Markdown>
      </div>
    </div>
  )
}
