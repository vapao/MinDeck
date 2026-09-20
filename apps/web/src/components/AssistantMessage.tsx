import type { ComponentProps } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './AssistantMessage.module.css'

const plugins = [remarkGfm]
// 链接一律开新标签，不把会话页跳走；react-markdown 会附带 hast node，不能透传到 DOM
const components = {
  a({ node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
    void node
    return <a {...props} target="_blank" rel="noreferrer" />
  },
}

type Props = { text: string; streaming: boolean }

// 不带发送者 / 时间头部：一轮的落款（TurnRow）已经记了时间，回复段落直接接在用户消息后
export function AssistantMessage({ text, streaming }: Props) {
  return (
    <div className={styles.row}>
      <div className={styles.body} data-streaming={streaming || undefined}>
        <Markdown remarkPlugins={plugins} components={components}>{text}</Markdown>
      </div>
    </div>
  )
}
