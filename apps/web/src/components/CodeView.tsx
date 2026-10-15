import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CodeView as View } from './codemirror'

type Props = { text: string; path: string; editable?: boolean; dirty?: boolean; line?: number; className?: string; onChange?: (text: string) => void; onSave?: () => void }

// CodeMirror 按需加载；只读预览与编辑共用一个实例，切换时保留滚动位置
export function CodeView(props: Props) {
  const box = useRef<HTMLDivElement>(null)
  const code = useRef<View | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props })
  const { text, path, editable = false, dirty = false } = props
  useEffect(() => {
    let disposed = false
    void import('./codemirror').then(async ({ createCodeView }) => {
      const p = latest.current
      const created = await createCodeView(box.current!, {
        text: p.text, path, editable: p.editable ?? false, line: p.line,
        onChange: (value) => latest.current.onChange?.(value), onSave: () => latest.current.onSave?.(),
      })
      if (disposed) created.view.destroy()
      else code.current = created
    })
    return () => { disposed = true; code.current?.view.destroy(); code.current = null }
  }, [path])
  useEffect(() => { code.current?.setEditable(editable) }, [editable])
  // 有未保存改动时不被外部刷新覆盖；没有改动（含取消 / 保存后）时同步磁盘内容
  useEffect(() => { if (!dirty) code.current?.setText(text) }, [text, dirty])
  return <div ref={box} className={props.className} />
}

export function CodeDiff({ original, current, path, className }: { original: string; current: string; path: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let destroy = () => {}
    void import('./codemirror').then(async ({ createDiffView }) => {
      const view = await createDiffView(box.current!, { original, current, path })
      if (disposed) view.destroy()
      else destroy = () => view.destroy()
    })
    return () => { disposed = true; destroy() }
  }, [original, current, path])
  return <div ref={box} className={className} />
}
