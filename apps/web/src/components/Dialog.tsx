import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { X } from 'lucide-react'
import styles from './Dialog.module.css'

type Base = { title: string; message?: string; ok?: string; cancel?: string }
type Request = { id: number } & (
  | (Base & { kind: 'alert'; resolve: (v: undefined) => void })
  | (Base & { kind: 'confirm'; danger?: boolean; resolve: (v: boolean | null) => void })
  | (Base & { kind: 'prompt'; initial?: string; placeholder?: string; resolve: (v: string | null) => void })
)

// 原生 confirm / alert / prompt 不跟随主题，这里用 <dialog> 自绘，API 仍是"调用返回 Promise"，调用方不用管状态。
// 右上角 ×、Escape、点遮罩都是"关掉，什么也不做"：confirm 回 null（区别于点「取消」按钮的 false），prompt 回 null
// 请求排队，一次只显示一个；<DialogHost /> 在根部挂一次
let queue: Request[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const push = (r: Omit<Request, 'id'>) => {
  queue = [...queue, { id: ++seq, ...r } as Request]
  emit()
}

export const dialog = {
  alert: (opts: Base) => new Promise<undefined>((resolve) => push({ kind: 'alert', ...opts, resolve })),
  confirm: (opts: Base & { danger?: boolean }) => new Promise<boolean | null>((resolve) => push({ kind: 'confirm', ...opts, resolve })),
  prompt: (opts: Base & { initial?: string; placeholder?: string }) => new Promise<string | null>((resolve) => push({ kind: 'prompt', ...opts, resolve })),
}

export function DialogHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => queue[0],
  )
  if (!current) return null
  // key 让每个请求都挂一个新的 <dialog>，showModal 只需在挂载时调一次
  return <Modal key={current.id} request={current} />
}

function Modal({ request }: { request: Request }) {
  const el = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(request.kind === 'prompt' ? (request.initial ?? '') : '')
  const settled = useRef(false)
  useEffect(() => {
    if (!el.current!.open) el.current!.showModal()
  }, [])

  const finish = (value: boolean | string | null | undefined) => {
    if (settled.current) return
    settled.current = true
    ;(request.resolve as (v: unknown) => void)(value)
    queue = queue.filter((r) => r !== request)
    emit()
  }
  // 关闭（×、Escape、遮罩）统一走 onClose；按钮先 finish 再 close，onClose 再来时已 settled 不会覆盖
  const dismiss = () => finish(request.kind === 'alert' ? undefined : null)
  const cancel = () => {
    finish(request.kind === 'confirm' ? false : null)
    el.current!.close()
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    finish(request.kind === 'confirm' ? true : request.kind === 'prompt' ? text : undefined)
  }

  return (
    <dialog
      ref={el}
      className={styles.dialog}
      onClose={dismiss}
      // 遮罩区域就是 dialog 自身（内容在 .box 里），点到它等于关闭
      onClick={(e) => e.target === el.current && el.current.close()}
    >
      <form className={styles.box} onSubmit={onSubmit}>
        <div className={styles.head}>
          <div className={styles.title}>{request.title}</div>
          <button type="button" className={styles.close} onClick={() => el.current!.close()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {request.message && <div className={styles.message}>{request.message}</div>}
        {request.kind === 'prompt' && (
          <input
            className={styles.input}
            value={text}
            placeholder={request.placeholder}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            onFocus={(e) => e.target.select()}
          />
        )}
        <div className={styles.actions}>
          {request.kind !== 'alert' && (
            <button type="button" className={styles.secondary} onClick={cancel}>
              {request.cancel ?? 'Cancel'}
            </button>
          )}
          <button type="submit" className={styles.primary} data-danger={(request.kind === 'confirm' && request.danger) || undefined} autoFocus={request.kind !== 'prompt'}>
            {request.ok ?? 'OK'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
