import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Square } from 'lucide-react'
import type { Resolution } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { useSessionStream } from '../session/useSessionStream'
import { StatusPill } from '../components/StatusPill'
import { UserMessage } from '../components/UserMessage'
import { AssistantMessage } from '../components/AssistantMessage'
import { ToolCard } from '../components/ToolCard'
import { ErrorCard } from '../components/ErrorCard'
import { InterruptedRow } from '../components/InterruptedRow'
import { RateMeter } from '../components/RateMeter'
import { ApprovalCard } from '../components/ApprovalCard'
import { QuestionCard } from '../components/QuestionCard'
import { Composer } from '../components/Composer'
import styles from './SessionPage.module.css'

export function SessionPage({ sessionId }: { sessionId: string }) {
  const { session, status, items, lastSeq, connection, usage } = useSessionStream(sessionId)
  const queryClient = useQueryClient()
  const send = useMutation({
    mutationFn: (body: { text: string; attachmentIds: string[] }) => api.sendMessage(sessionId, body),
    // 首条消息决定列表里的标题
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  const interrupt = useMutation({ mutationFn: () => api.interrupt(sessionId) })
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

  const running = status === 'running' || status === 'waiting_user'
  // snapshot 到达前先按 claude 渲染，随后被真实 provider 覆盖
  const provider = session?.provider ?? 'claude'
  const hint = send.error
    ? send.error.message
    : interrupt.error
      ? interrupt.error.message
      : connection === 'closed'
        ? '连接已断开，刷新页面重连'
        : status === 'waiting_user'
          ? `处理上方的请求后 ${provider} 才会继续`
          : status === 'running'
            ? '当前有一轮在运行，发送将作为追加指令排队'
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
            <code className={styles.chip}>{provider}</code>
            <code>seq {lastSeq}</code>
          </span>
        </div>
        <div className={styles.meter}>
          <RateMeter provider={provider} usage={usage} />
        </div>
        {running && (
          <button type="button" className={styles.interrupt} onClick={() => interrupt.mutate()} disabled={interrupt.isPending}>
            <Square size={12} />
            中断
          </button>
        )}
        <StatusPill status={connection === 'closed' ? 'error' : status} />
      </header>

      <main className={styles.stream}>
        <div className={styles.column}>
          {items.map((it) => {
            switch (it.kind) {
              case 'user':
                return <UserMessage key={it.key} text={it.text} attachments={it.attachments} at={it.at} />
              case 'assistant':
                return <AssistantMessage key={it.key} provider={provider} text={it.text} streaming={it.streaming} at={it.at} />
              case 'tool':
                return <ToolCard key={it.key} name={it.name} input={it.input} output={it.output} isError={it.isError} />
              case 'error':
                return <ErrorCard key={it.key} message={it.message} />
              case 'interrupted':
                return <InterruptedRow key={it.key} at={it.at} />
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
                    provider={provider}
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
          <Composer
            disabled={status === 'waiting_user' || connection !== 'open'}
            hint={hint}
            placeholder={`给 ${providerName[provider]} 发消息…`}
            upload={(file) => api.uploadAttachment(sessionId, file)}
            onSend={(text, attachmentIds) => send.mutate({ text, attachmentIds })}
          />
        </div>
      </footer>
    </div>
  )
}
