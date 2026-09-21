import { useRef, useState, type ComponentProps } from 'react'
import { Check, Copy } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import { api } from '../api'
import { fileReference, showFile } from './FilePreview'
import remarkGfm from 'remark-gfm'
import styles from './AssistantMessage.module.css'

const plugins = [remarkGfm]
const components = {
  pre({ node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
    void node
    return <CodeBlock {...props} />
  },
  // 表格外包一层：圆角 + 外框 + 横向滚动都挂在包裹层上，table 本身只管格子线
  table({ node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
    void node
    return (
      <div className={styles.table}>
        <table {...props} />
      </div>
    )
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

type Props = { text: string; streaming: boolean; sessionId: string }

// 不带发送者 / 时间头部：一轮的落款（TurnRow）已经记了时间，回复段落直接接在用户消息后
export function AssistantMessage({ text, streaming, sessionId }: Props) {
  return (
    <div className={styles.row}>
      <div className={styles.body} data-streaming={streaming || undefined}>
        <Markdown remarkPlugins={plugins} urlTransform={(url) => fileReference(url) ? url : defaultUrlTransform(url)} components={{ ...components,
          a: ({ href, children }) => {
            const file = fileReference(href ?? '')
            if (!file) return <a href={href} target="_blank" rel="noreferrer">{children}</a>
            return <a href={api.outputUrl(sessionId, file.path)} onClick={(e) => { e.preventDefault(); showFile(sessionId, file.path, file.line) }}>{children}{/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.path) && <img src={api.outputUrl(sessionId, file.path)} alt="" loading="lazy" style={{ display: 'block', maxHeight: 240 }} />}</a>
          },
          img: ({ src, alt }) => {
            const file = fileReference(src ?? '')
            if (!file) return <img src={src} alt={alt} loading="lazy" />
            return <a href={api.outputUrl(sessionId, file.path)} onClick={(e) => { e.preventDefault(); showFile(sessionId, file.path) }}><img src={api.outputUrl(sessionId, file.path)} alt={alt} loading="lazy" style={{ maxHeight: 240 }} /></a>
          },
        }}>{text}</Markdown>
      </div>
    </div>
  )
}
