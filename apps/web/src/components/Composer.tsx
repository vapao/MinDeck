import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUp, ImagePlus, X } from 'lucide-react'
import type { Attachment } from '@agentdeck/shared'
import styles from './Composer.module.css'

type Props = {
  /** 草稿按此 key 存 localStorage，切走再切回来输入内容还在 */
  draftKey: string
  disabled: boolean
  hint: string
  placeholder: string
  upload: (file: File) => Promise<Attachment>
  onSend: (text: string, attachmentIds: string[]) => void
}

// 选中即上传，发送时只引用服务端返回的 attachmentId（方案 §9.1）
type Draft = { key: string; file: File; previewUrl: string } & ({ status: 'uploading' } | { status: 'done'; id: string } | { status: 'error'; message: string })

const maxPerMessage = 5

export function Composer({ draftKey, disabled, hint, placeholder, upload, onSend }: Props) {
  const [text, setText] = useState(() => localStorage.getItem(`draft:${draftKey}`) ?? '')
  useEffect(() => {
    if (text) localStorage.setItem(`draft:${draftKey}`, text)
    else localStorage.removeItem(`draft:${draftKey}`)
  }, [draftKey, text])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
      <div className={styles.hint}>{failed ? failed.message : uploading ? '正在上传图片…' : hint}</div>
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
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => {
          if (e.target.files) addFiles(e.target.files)
          e.target.value = ''
        }} />
        <button type="button" className={styles.attach} onClick={() => fileInput.current?.click()} disabled={drafts.length >= maxPerMessage} aria-label="添加图片">
          <ImagePlus size={18} />
        </button>
        <textarea
          className={styles.input}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button type="button" className={styles.send} onClick={submit} disabled={!canSend} aria-label="发送">
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
  )
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)
