import { useRef, useState, type ComponentProps } from 'react'
import { Check, Copy } from 'lucide-react'
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
  pre({ node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
    void node
    return <CodeBlock {...props} />
  },
}

/** 代码块右上角挂一个复制按钮；文本直接取渲染后的 textContent，不用再从 AST 里拼 */
function CodeBlock(props: ComponentProps<'pre'>) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(pre.current!.textContent ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className={styles.code}>
      <pre ref={pre} {...props} />
      <button type="button" className={styles.copy} onClick={copy} aria-label="Copy code" title="Copy">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
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
