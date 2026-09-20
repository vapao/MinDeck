import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, File, Folder, ImagePlus, Square, X } from 'lucide-react'
import type { Attachment, EntriesResponse } from '@agentdeck/shared'
import styles from './Composer.module.css'

type Props = {
  /** 草稿按此 key 存 localStorage，切走再切回来输入内容还在 */
  draftKey: string
  disabled: boolean
  /** 一轮进行中：发送按钮换成中断；Enter 仍可发送，作为追加指令排队 */
  running: boolean
  interrupting: boolean
  onInterrupt: () => void
  /** 状态区左侧的会话信息（模型、思考等级、上下文用量） */
  meta: string
  /** 需要用户注意的状态（排队、等待、报错）；为空时状态区只显示 meta */
  hint: string
  hintError?: boolean
  placeholder: string
  upload: (file: File) => Promise<Attachment>
  /** @ 引用补全：q 是 @ 后面敲的内容 */
  search: (q: string) => Promise<EntriesResponse>
  onSend: (text: string, attachmentIds: string[]) => void
}

// 光标前最近的一个 @（前面是行首或空白、到光标之间没有空白）就是正在敲的引用
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1 || (at > 0 && !/\s/.test(before[at - 1]))) return null
  const query = before.slice(at + 1)
  return /\s/.test(query) ? null : { start: at, query }
}

// 选中即上传，发送时只引用服务端返回的 attachmentId（方案 §9.1）
type Draft = { key: string; file: File; previewUrl: string } & ({ status: 'uploading' } | { status: 'done'; id: string } | { status: 'error'; message: string })

const maxPerMessage = 5

export function Composer({ draftKey, disabled, running, interrupting, onInterrupt, meta, hint, hintError, placeholder, upload, search, onSend }: Props) {
  const [text, setText] = useState(() => localStorage.getItem(`draft:${draftKey}`) ?? '')
  useEffect(() => {
    if (text) localStorage.setItem(`draft:${draftKey}`, text)
    else localStorage.removeItem(`draft:${draftKey}`)
  }, [draftKey, text])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)

  // @ 补全：光标位置变化时重新判定；选中目录后保持打开继续往里敲
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [cursor, setCursor] = useState(0)
  const entries = useQuery({
    queryKey: ['entries', draftKey, mention?.query ?? ''],
    queryFn: () => search(mention!.query),
    enabled: mention !== null,
    placeholderData: (prev) => prev,
  })
  const options = mention ? (entries.data?.entries ?? []) : []
  const syncMention = () => {
    const el = textarea.current
    if (!el) return
    setMention(mentionAt(el.value, el.selectionStart))
    setCursor(0)
  }
  const pick = (opt: EntriesResponse['entries'][number]) => {
    const el = textarea.current
    if (!el || !mention) return
    const insert = `@${opt.path}${opt.dir ? '' : ' '}`
    const next = text.slice(0, mention.start) + insert + text.slice(el.selectionStart)
    const caret = mention.start + insert.length
    setText(next)
    // 等 React 写回 value 后再放光标；目录保持弹层继续浏览
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
      setMention(opt.dir ? { start: mention.start, query: opt.path } : null)
      setCursor(0)
    })
  }
  // 卸载时释放所有预览 URL
  const draftsRef = useRef(drafts)
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])
  useEffect(() => () => draftsRef.current.forEach((d) => URL.revokeObjectURL(d.previewUrl)), [])

  const patch = (key: string, next: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? ({ ...d, ...next } as Draft) : d)))

  const addFiles = (files: Iterable<File>) => {
    const images = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, maxPerMessage - drafts.length))
    if (images.length === 0) return
    const added: Draft[] = images.map((file) => ({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: 'uploading' }))
    setDrafts((ds) => [...ds, ...added])
    for (const d of added) {
      upload(d.file).then(
        (a) => patch(d.key, { status: 'done', id: a.id }),
        (err: Error) => patch(d.key, { status: 'error', message: err.message }),
      )
    }
  }
  const remove = (key: string) => {
    setDrafts((ds) => {
      const d = ds.find((x) => x.key === key)
      if (d) URL.revokeObjectURL(d.previewUrl)
      return ds.filter((x) => x.key !== key)
    })
  }

  const uploading = drafts.some((d) => d.status === 'uploading')
  const failed = drafts.find((d) => d.status === 'error')
  const ids = drafts.flatMap((d) => (d.status === 'done' ? [d.id] : []))
  const canSend = !disabled && !uploading && !failed && (text.trim() !== '' || ids.length > 0)

  const submit = () => {
    if (!canSend) return
    onSend(text.trim(), ids)
    drafts.forEach((d) => URL.revokeObjectURL(d.previewUrl))
    setText('')
    setDrafts([])
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (mention && options.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[cursor])
        return
      }
    }
    if (mention && e.key === 'Escape') {
      setMention(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length === 0) return
    e.preventDefault()
    addFiles(e.clipboardData.files)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  return (
    <div className={styles.wrap}>
      {drafts.length > 0 && (
        <div className={styles.chips}>
          {drafts.map((d) => (
            <div key={d.key} className={styles.chip} data-status={d.status} title={d.status === 'error' ? d.message : d.file.name}>
              <img className={styles.chipThumb} src={d.previewUrl} alt="" />
              <code className={styles.chipName}>{d.file.name}</code>
              <span className={styles.chipMeta}>{d.status === 'uploading' ? '上传中…' : d.status === 'error' ? '上传失败' : formatSize(d.file.size)}</span>
              <button type="button" className={styles.chipRemove} onClick={() => remove(d.key)} aria-label="移除">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.boxWrap}>
        {mention && (
          <div className={styles.mentions}>
            {options.length === 0 ? (
              <div className={styles.mentionEmpty}>{entries.isFetching ? '…' : '没有匹配'}</div>
            ) : (
              options.map((opt, i) => (
                <button
                  key={opt.path}
                  type="button"
                  className={styles.mention}
                  data-active={i === cursor || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(opt)}
                  onMouseEnter={() => setCursor(i)}
                >
                  {opt.dir ? <Folder size={14} /> : <File size={14} />}
                  <code className={styles.mentionPath}>{opt.path}</code>
                </button>
              ))
            )}
          </div>
        )}
        <div
          className={styles.box}
          data-dragging={dragging || undefined}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <textarea
            ref={textarea}
            className={styles.input}
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value)
              syncMention()
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => {
              // 上下键在弹层里选项，不动光标；左右 / Home / End 会移动光标，重新判定 @ 位置
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncMention()
            }}
            onClick={syncMention}
            onBlur={() => setMention(null)}
            onPaste={onPaste}
          />
          <div className={styles.bar}>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <button type="button" className={styles.attach} onClick={() => fileInput.current?.click()} disabled={drafts.length >= maxPerMessage} aria-label="添加图片" title="添加图片">
              <ImagePlus size={16} />
            </button>
            <span className={styles.meta}>{meta}</span>
            {(failed || uploading || hint) && (
              <span className={styles.hint} data-error={(failed || hintError) || undefined}>
                {failed ? failed.message : uploading ? '正在上传图片…' : hint}
              </span>
            )}
            {running ? (
              <button type="button" className={styles.stop} onClick={onInterrupt} disabled={interrupting} aria-label="中断" title="中断当前这一轮">
                <Square size={14} />
              </button>
            ) : (
              <button type="button" className={styles.send} onClick={submit} disabled={!canSend} aria-label="发送">
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)
