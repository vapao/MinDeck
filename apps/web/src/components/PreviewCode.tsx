import { useQuery } from '@tanstack/react-query'
import styles from './FilePreview.module.css'

const extensions: Record<string, string> = {
  py: 'python', pyw: 'python', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', json: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', md: 'markdown', markdown: 'markdown',
}

export function PreviewCode({ text, path, language, numbered = false, line }: { text: string; path?: string; language?: string; numbered?: boolean; line?: number }) {
  const lang = language?.toLowerCase() ?? extensions[path?.split('.').pop()?.toLowerCase() ?? '']
  const highlighted = useQuery({
    queryKey: ['previewHighlight', lang, text],
    queryFn: async () => (await import('./code-highlight')).highlightLines(text, lang!),
    enabled: !!lang && new TextEncoder().encode(text).byteLength <= 100 * 1024,
    staleTime: Infinity,
    retry: false,
  })
  if (highlighted.error) throw highlighted.error
  const lines = highlighted.data ?? text.split('\n').map((text) => [{ text, className: '' }])
  return <code className={styles.syntax}>{lines.map((tokens, i) => <span className={styles.codeLine} key={i} data-line={numbered ? i + 1 : undefined} data-selected={numbered && line === i + 1 || undefined}>
    {numbered && <span className={styles.lineNumber}>{i + 1}</span>}
    {tokens.map((token, j) => <span key={j} className={token.className || undefined}>{token.text}</span>)}
  </span>)}</code>
}
