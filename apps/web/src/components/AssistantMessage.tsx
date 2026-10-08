import { useRef, useState, type ComponentProps } from 'react'
import { ArrowRight, Check, Copy } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import { api } from '../api'
import { fileReference, showFile } from './FilePreview'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import { fillComposer } from '../session/drafts'
import styles from './AssistantMessage.module.css'

type MdNode = { type: string; name?: string; value?: string; url?: string; attributes?: Record<string, string | null | undefined> | null; children?: MdNode[]; data?: object; position?: { start: { offset?: number }; end: { offset?: number } } }

/** Codex 回复里的 :codex-file-citation / :codex-followup 指令：引用转成文件链接，后续建议转成按钮；
 * 其它指令（含正文里被误认的 a:b）还原成原文，避免吞字 */
function codexDirectives() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value)
    const walk = (node: MdNode) => {
      node.children = node.children?.map((child): MdNode => {
        if (!child.type.endsWith('Directive')) {
          walk(child)
          return child
        }
        const attrs = child.attributes ?? {}
        if (child.name === 'codex-file-citation' && attrs.path) {
          const place = [attrs.sheet, attrs.range].filter(Boolean).join('!')
          const lines = [attrs.line_range_start, attrs.line_range_end].filter(Boolean).join('-')
          // 行号拼成 path:行 交给 fileReference，预览直接跳到起始行
          const url = attrs.line_range_start ? `${attrs.path}:${attrs.line_range_start}` : attrs.path
          return { type: 'link', url, children: [{ type: 'text', value: `${attrs.path.split('/').pop()}${lines ? `:${lines}` : ''}${place ? ` · ${place}` : ''}` }] }
        }
        if (child.name === 'codex-followup' && attrs.prompt) {
          walk(child)
          return { type: 'followup', children: child.children, data: { hName: 'button', hProperties: { type: 'button', dataFollowup: attrs.prompt } } }
        }
        const raw: MdNode = { type: 'text', value: source.slice(child.position!.start.offset, child.position!.end.offset) }
        return child.type === 'textDirective' ? raw : { type: 'paragraph', children: [raw] }
      })
    }
    walk(tree)
  }
}

const plugins = [remarkGfm, remarkDirective, codexDirectives]
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
          button: ({ node, children, ...props }: ComponentProps<'button'> & { node?: unknown; 'data-followup'?: string }) => {
            void node
            const prompt = props['data-followup']
            if (!prompt) return <button {...props}>{children}</button>
            return <button type="button" className={styles.followup} title={prompt} onClick={() => fillComposer(sessionId, prompt)}>{children}<ArrowRight size={13} /></button>
          },
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
