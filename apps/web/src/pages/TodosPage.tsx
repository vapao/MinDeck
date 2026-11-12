import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { Todo } from '@mindeck/shared'
import { api } from '../api'
import { navigate } from '../router'
import { dialog } from '../components/Dialog'
import { TabBar } from '../components/TabBar'
import { localDay, openTodo } from '../components/TodoDialog'
import { useMediaQuery } from '../session/useMediaQuery'
import { useSessions } from '../session/useSessions'
import manage from './Manage.module.css'
import layout from './SchedulesPage.module.css'
import styles from './TodosPage.module.css'

export const useTodos = (done: boolean) => useQuery({ queryKey: ['todos', done], queryFn: () => api.listTodos(done), refetchInterval: 30_000 })

export function formatDay(day: string) {
  if (day === localDay()) return 'Today'
  if (day === localDay(1)) return 'Tomorrow'
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }) })
}

// Todos：先记下、以后再处理的事。用户手记、会话页 Create todo 起草、Agent 用 add_todo 记；到提醒日期进 Inbox
export function TodosPage() {
  const desktop = useMediaQuery('(min-width: 1024px)')
  const [showDone, setShowDone] = useState(false)
  const open = useTodos(false)
  const done = useTodos(true)
  const list = showDone ? done : open
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const sessions = useSessions()
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] })
    queryClient.invalidateQueries({ queryKey: ['inbox'] })
  }
  const [text, setText] = useState('')
  const add = useMutation({ mutationFn: (title: string) => api.createTodo({ title }), onSuccess: () => { setText(''); invalidate() } })
  const toggle = useMutation({ mutationFn: (t: Todo) => api.updateTodo(t.id, { done: !t.doneAt }), onSuccess: invalidate })
  const remove = useMutation({ mutationFn: api.deleteTodo, onSuccess: invalidate })
  const alias = (cwd: string) => workspaces.data?.find((w) => w.path === cwd)?.alias ?? cwd.split('/').pop()
  const today = localDay()
  const error = list.error ?? add.error ?? toggle.error ?? remove.error

  return (
    <div className={layout.page}>
      <header className={layout.top}>
        <h1 className={layout.title}>Todos</h1>
        <div className={styles.filters}>
          <button type="button" className={styles.chip} data-on={!showDone || undefined} onClick={() => setShowDone(false)}>Open <b>{open.data?.length ?? ''}</b></button>
          <button type="button" className={styles.chip} data-on={showDone || undefined} onClick={() => setShowDone(true)}>Done</button>
        </div>
        <button type="button" className={layout.newTask} onClick={() => openTodo()}>
          <Plus size={14} />
          New todo
        </button>
      </header>
      <div className={layout.scroll}>
        <div className={`${layout.column} ${styles.column}`}>
          {!showDone && (
            <form className={styles.add} onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(text.trim()) }}>
              <Plus size={16} />
              <input className={styles.addInput} value={text} placeholder="Add a todo and press Enter" onChange={(e) => setText(e.target.value)} disabled={add.isPending} />
            </form>
          )}
          {error && <div className={manage.error}>{error.message}</div>}
          {list.data?.length === 0 && <div className={layout.none}>{showDone ? 'Nothing done yet' : 'Nothing to do. Add things you need to come back to later.'}</div>}
          {list.data?.map((t) => {
            const session = t.sessionId ? sessions.data?.find((s) => s.id === t.sessionId) : undefined
            return (
              <div key={t.id} className={styles.row} data-done={t.doneAt ? '' : undefined}>
                <button type="button" className={styles.check} onClick={() => toggle.mutate(t)} disabled={toggle.isPending} aria-label={t.doneAt ? 'Mark as not done' : 'Mark as done'} title={t.doneAt ? 'Mark as not done' : 'Mark as done'}>
                  {t.doneAt && <Check size={12} strokeWidth={3} />}
                </button>
                <button type="button" className={styles.body} onClick={() => openTodo({ todo: t })}>
                  <span className={styles.title}>{t.title}</span>
                  {t.note && <span className={styles.note}>{t.note.split('\n')[0]}</span>}
                  {(t.cwd || t.remindOn) && (
                    <span className={styles.meta}>
                      {t.cwd && <span className={styles.project}>{alias(t.cwd)}</span>}
                      {t.remindOn && !t.doneAt && <span className={styles.day} data-due={t.remindOn <= today || undefined}>{formatDay(t.remindOn)}</span>}
                    </span>
                  )}
                </button>
                {session && <button type="button" className={styles.session} onClick={() => navigate(`/s/${session.id}`)} title="Open the linked session">{session.title ?? 'Session'}</button>}
                {t.doneAt && (
                  <button type="button" className={manage.rowButton} data-danger onClick={async () => { if (await dialog.confirm({ title: 'Delete this todo?', ok: 'Delete', danger: true })) remove.mutate(t.id) }} aria-label="Delete" title="Delete">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {!desktop && <TabBar />}
    </div>
  )
}
