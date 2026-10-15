import { useQuery } from '@tanstack/react-query'
import styles from './FilePreview.module.css'

// Markdown 渲染视图里的 fenced code；超过 100 KiB 或语言不认识时显示纯文本
export function PreviewCode({ text, language }: { text: string; language: string }) {
  const highlighted = useQuery({
    queryKey: ['previewHighlight', language, text],
    queryFn: async () => (await import('./codemirror')).highlightLines(text, language),
    enabled: new TextEncoder().encode(text).byteLength <= 100 * 1024,
    staleTime: Infinity,
    retry: false,
  })
  if (highlighted.error) throw highlighted.error
  const lines = highlighted.data ?? text.split('\n').map((text) => [{ text, className: '' }])
  return <code className={styles.syntax}>{lines.map((tokens, i) => <span className={styles.codeLine} key={i}>
    {tokens.map((token, j) => <span key={j} className={token.className || undefined}>{token.text}</span>)}
  </span>)}</code>
}
