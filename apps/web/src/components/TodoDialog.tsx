import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Todo } from '@agentdeck/shared'
import { api } from '../api'
import { useSessions } from '../session/useSessions'
import { Select } from './Select'
import { dialog } from './Dialog'
import modal from './Dialog.module.css'
import form from './NewSessionDialog.module.css'
import manage from '../pages/Manage.module.css'
import styles from './TodoDialog.module.css'

// 待办的新建 / 编辑是全局弹窗：Todos 页、Inbox（Later、提醒）、会话页（Create todo）都从这里开。<TodoHost /> 在根部挂一次
// draftFrom：会话 ID，打开后用 AI 标题模型从对话起草标题和备注，失败就空着让用户自己填
type Init = { todo?: Todo; title?: string; note?: string; cwd?: string | null; sessionId?: string | null; remindOn?: string | null; draftFrom?: string }
let request: (Init & { id: number }) | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
export function openTodo(init: Init = {}) {
  request = { ...init, id: ++seq }
  emit()
}
const closeTodo = () => {
  request = null
  emit()
}

export function TodoHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => request,
  )
  return current && <TodoDialog key={current.id} init={current} />
}

/** 本地日期 YYYY-MM-DD，offset 天后 */
export const localDay = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('sv')
}

function TodoDialog({ init }: { init: Init }) {
  const el = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!el.current!.open) el.current!.showModal()
  }, [])
  const todo = init.todo
  const [title, setTitle] = useState(todo?.title ?? init.title ?? '')
  const [note, setNote] = useState(todo?.note ?? init.note ?? '')
  const [cwd, setCwd] = useState(todo ? todo.cwd : (init.cwd ?? null))
  const [remindOn, setRemindOn] = useState(todo ? todo.remindOn : (init.remindOn ?? null))
  const sessionId = todo ? todo.sessionId : (init.sessionId ?? null)
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const queryClient = useQueryClient()
  const draft = useMutation({
    mutationFn: api.todoDraft,
    onSuccess: (d) => {
      setTitle((t) => t || d.title)
      setNote((n) => n || d.note)
    },
  })
  useEffect(() => {
    if (init.draftFrom) draft.mutate(init.draftFrom)
  }, [])
  const done = () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] })
    queryClient.invalidateQueries({ queryKey: ['inbox'] })
    el.current!.close()
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), note: note.trim(), cwd, remindOn }
      return todo ? api.updateTodo(todo.id, body) : api.createTodo({ ...body, sessionId })
    },
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: () => api.deleteTodo(todo!.id), onSuccess: done })
  const session = useSessions().data?.find((s) => s.id === sessionId)
  // 项目下拉的值是路径；待办上的项目已被移除时也照样显示出来
  const projects = [{ value: '', label: 'None' }, ...(workspaces.data ?? []).map((w) => ({ value: w.path, label: w.alias, hint: w.path }))]
  if (cwd && !projects.some((p) => p.value === cwd)) projects.push({ value: cwd, label: cwd.split('/').pop() ?? cwd, hint: cwd })
  const quick = [
    { label: 'Tomorrow', value: localDay(1) },
    { label: 'In 3 days', value: localDay(3) },
    { label: 'Next week', value: localDay(7) },
  ]

  return (
    <dialog ref={el} className={modal.dialog} style={{ overflow: 'visible', width: 'min(calc(100vw - 32px), 520px)' }} onClose={closeTodo} onClick={(e) => e.target === el.current && el.current.close()}>
      <div className={modal.box}>
        <div className={modal.head}>
          <div className={modal.title}>{todo ? 'Edit todo' : 'New todo'}</div>
          <button type="button" className={modal.close} onClick={() => el.current!.close()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className={form.body}>
          {draft.isPending && <div className={styles.hint}>Drafting from the conversation…</div>}
          {draft.error && <div className={styles.hint}>Couldn't draft it: {draft.error.message}</div>}
          <label className={form.field}>
            <span>Title</span>
            <input className={manage.input} value={title} autoFocus={!init.draftFrom} placeholder="What needs doing" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className={form.field}>
            <span>Note</span>
            <textarea className={`${manage.input} ${styles.note}`} value={note} rows={4} placeholder="Context to pick it up again" onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className={form.field}>
            <span>Project</span>
            <Select ariaLabel="Project" searchable value={cwd ?? ''} onChange={(v) => setCwd(v || null)} options={projects} />
          </div>
          <div className={form.field}>
            <span>Remind me on</span>
            <div className={styles.remind}>
              <input className={`${manage.input} ${styles.date}`} type="date" value={remindOn ?? ''} onChange={(e) => setRemindOn(e.target.value || null)} />
              {quick.map((q) => (
                <button key={q.label} type="button" className={styles.chip} data-on={remindOn === q.value || undefined} onClick={() => setRemindOn(q.value)}>{q.label}</button>
              ))}
              {remindOn && <button type="button" className={styles.chip} onClick={() => setRemindOn(null)}>No reminder</button>}
            </div>
            <div className={styles.hint}>It shows up in your Inbox from that day.</div>
          </div>
          {sessionId && <div className={styles.hint}>Linked to session: {session?.title ?? 'Session'}</div>}
          {(save.error ?? remove.error) && <div className={form.error}>{(save.error ?? remove.error)!.message}</div>}
        </div>
        <div className={modal.actions}>
          {todo && (
            <button
              type="button"
              className={`${modal.secondary} ${styles.delete}`}
              disabled={remove.isPending}
              onClick={async () => {
                if (await dialog.confirm({ title: 'Delete this todo?', ok: 'Delete', danger: true })) remove.mutate()
              }}
            >
              Delete
            </button>
          )}
          <button type="button" className={modal.secondary} onClick={() => el.current!.close()}>
            Cancel
          </button>
          <button type="button" className={modal.primary} disabled={!title.trim() || save.isPending || draft.isPending} onClick={() => save.mutate()}>
            {todo ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
