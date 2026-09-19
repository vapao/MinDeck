import { useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import type { Resolution } from '@agentdeck/shared'
import { api } from '../api'
import { navigate } from '../router'
import { useSessionStream } from '../session/useSessionStream'
import { StatusPill } from '../components/StatusPill'
import { UserMessage } from '../components/UserMessage'
import { AssistantMessage } from '../components/AssistantMessage'
import { ToolCard } from '../components/ToolCard'
import { ErrorCard } from '../components/ErrorCard'
import { ApprovalCard } from '../components/ApprovalCard'
import { QuestionCard } from '../components/QuestionCard'
import { Composer } from '../components/Composer'
import styles from './SessionPage.module.css'

export function SessionPage({ sessionId }: { sessionId: string }) {
  const { session, status, items, lastSeq, connection } = useSessionStream(sessionId)
  const send = useMutation({ mutationFn: (text: string) => api.sendMessage(sessionId, { text }) })
  // 同一时刻只会有一个待处理请求在提交；409（已在别处处理）随后会被 resolved 事件覆盖掉卡片
  const resolve = useMutation({ mutationFn: ({ id, body }: { id: string; body: Resolution }) => api.resolvePending(id, body) })
  const pendingProps = (id: string) => ({
    busy: resolve.isPending && resolve.variables?.id === id,
    error: resolve.error && resolve.variables?.id === id ? resolve.error.message : null,
  })
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [items])

  const busy = status === 'running' || status === 'waiting_user'
  const hint = send.error
    ? send.error.message
    : connection === 'closed'
      ? '连接已断开，刷新页面重连'
      : status === 'waiting_user'
        ? '处理上方的请求后 claude 才会继续'
        : status === 'running'
          ? '等待本轮结束后再发送'
          : 'Enter 发送，Shift+Enter 换行'

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="返回">
          <ChevronLeft size={20} />
        </button>
        <div className={styles.title}>
          <code className={styles.cwd}>{session?.cwd ?? '…'}</code>
          <span className={styles.sub}>
            <code className={styles.chip}>claude</code>
            <code>seq {lastSeq}</code>
          </span>
        </div>
        <StatusPill status={connection === 'closed' ? 'error' : status} />
      </header>

      <main className={styles.stream}>
        <div className={styles.column}>
          {items.map((it) => {
            switch (it.kind) {
              case 'user':
                return <UserMessage key={it.key} text={it.text} at={it.at} />
              case 'assistant':
                return <AssistantMessage key={it.key} text={it.text} streaming={it.streaming} at={it.at} />
              case 'tool':
                return <ToolCard key={it.key} name={it.name} input={it.input} output={it.output} isError={it.isError} />
              case 'error':
                return <ErrorCard key={it.key} message={it.message} />
              case 'approval':
                return (
                  <ApprovalCard
                    key={it.key}
                    request={it.request}
                    cwd={session?.cwd ?? ''}
                    state={it.state}
                    decision={it.decision}
                    resolvedAt={it.resolvedAt}
                    {...pendingProps(it.request.id)}
                    onResolve={(decision) => resolve.mutate({ id: it.request.id, body: { kind: 'approval', decision } })}
                  />
                )
              case 'question':
                return (
                  <QuestionCard
                    key={it.key}
                    request={it.request}
                    state={it.state}
                    answers={it.answers}
                    response={it.response}
                    resolvedAt={it.resolvedAt}
                    {...pendingProps(it.request.id)}
                    onSubmit={(answers, response) => resolve.mutate({ id: it.request.id, body: { kind: 'question', answers, response } })}
                  />
                )
            }
          })}
          <div ref={bottom} />
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.column}>
          <Composer disabled={busy || connection !== 'open'} hint={hint} onSend={(text) => send.mutate(text)} />
        </div>
      </footer>
    </div>
  )
}
