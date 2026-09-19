import { useEffect, useReducer, useRef } from 'react'
import type { AgentEvent, ApprovalDecision, Attachment, PendingRequest, QuestionAnswers, ServerMessage, Session, SessionStatus, UsageInfo } from '@agentdeck/shared'

// 会话页的实时状态 = 对事件流做 reduce（方案 §13.1）。一个 seq 只处理一次，重放与 live 共用同一条路径。

export type StreamItem =
  | { kind: 'user'; key: string; text: string; attachments: Attachment[]; at: string }
  | { kind: 'assistant'; key: string; messageId: string; text: string; streaming: boolean; at: string }
  | { kind: 'tool'; key: string; toolUseId: string; name: string; input: unknown; output: string | null; isError: boolean; at: string }
  | { kind: 'error'; key: string; message: string; at: string }
  | { kind: 'interrupted'; key: string; at: string }
  | { kind: 'approval'; key: string; request: Extract<PendingRequest, { kind: 'approval' }>; state: PendingState; decision: ApprovalDecision | null; resolvedAt: string | null }
  | { kind: 'question'; key: string; request: Extract<PendingRequest, { kind: 'question' }>; state: PendingState; answers: QuestionAnswers | null; response: string | null; resolvedAt: string | null }

export type PendingState = 'pending' | 'resolved' | 'expired'

export type StreamState = {
  session: Session | null
  status: SessionStatus
  /** Provider 启动 / 恢复时报告的模型；首轮 init 前为 null */
  model: string | null
  items: StreamItem[]
  lastSeq: number
  /** connecting：首次连接；reconnecting：掉线后自动重连中；open：已连上 */
  connection: 'connecting' | 'reconnecting' | 'open'
  /** 最近一次重连补齐的事件范围，给 ConnectionBanner 用；几秒后清空 */
  replay: { from: number; to: number } | null
  /** snapshot 里仍在等待的请求 id；重放结束后据此把陈旧的 pending 卡片标成已过期 */
  livePendingIds: string[]
  /** 账号级额度，按 rateLimitType 存最新值 */
  usage: Record<string, UsageInfo>
}

type Action =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connection'; value: StreamState['connection'] }
  | { type: 'replay.dismiss' }
  | { type: 'reset' }

const initial: StreamState = { session: null, status: 'idle', model: null, items: [], lastSeq: 0, connection: 'connecting', replay: null, livePendingIds: [], usage: {} }

function reduce(state: StreamState, action: Action): StreamState {
  if (action.type === 'reset') return initial
  if (action.type === 'connection') return { ...state, connection: action.value }
  if (action.type === 'replay.dismiss') return { ...state, replay: null }
  const m = action.message
  switch (m.type) {
    case 'snapshot':
      // 重连时的 snapshot 记下本地已有的 seq，replay.completed 时据此算出补齐了多少
      return {
        ...state,
        session: m.session,
        status: m.session.status,
        livePendingIds: m.pendingRequests.map((r) => r.id),
        usage: m.usage,
        replay: state.connection === 'reconnecting' ? { from: state.lastSeq, to: state.lastSeq } : null,
      }
    case 'event':
      if (m.event.seq <= state.lastSeq) return state
      return applyEvent({ ...state, lastSeq: m.event.seq }, m.event)
    case 'replay.completed':
      return {
        ...state,
        connection: 'open',
        replay: state.replay && { ...state.replay, to: state.lastSeq },
        items: state.items.map((it) =>
          (it.kind === 'approval' || it.kind === 'question') && it.state === 'pending' && !state.livePendingIds.includes(it.request.id)
            ? { ...it, state: 'expired' }
            : it,
        ),
      }
    default:
      return state
  }
}

function applyEvent(state: StreamState, e: AgentEvent): StreamState {
  const items = state.items
  switch (e.type) {
    case 'message.user':
      return { ...state, items: [...items, { kind: 'user', key: `u${e.seq}`, text: e.payload.text, attachments: e.payload.attachments ?? [], at: e.createdAt }] }
    case 'message.delta':
    case 'message.completed': {
      const { messageId, text } = e.payload
      const done = e.type === 'message.completed'
      const i = items.findIndex((it) => it.kind === 'assistant' && it.messageId === messageId)
      if (i === -1) {
        return { ...state, items: [...items, { kind: 'assistant', key: messageId, messageId, text, streaming: !done, at: e.createdAt }] }
      }
      const cur = items[i] as Extract<StreamItem, { kind: 'assistant' }>
      // completed 携带完整文本，覆盖 delta 拼接结果
      const next = { ...cur, text: done ? text : cur.text + text, streaming: !done }
      return { ...state, items: items.toSpliced(i, 1, next) }
    }
    case 'tool.started':
      return {
        ...state,
        items: [...items, { kind: 'tool', key: e.payload.toolUseId, toolUseId: e.payload.toolUseId, name: e.payload.name, input: e.payload.input, output: null, isError: false, at: e.createdAt }],
      }
    case 'tool.completed': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.toolUseId === e.payload.toolUseId)
      if (i === -1) return state
      const cur = items[i] as Extract<StreamItem, { kind: 'tool' }>
      return { ...state, items: items.toSpliced(i, 1, { ...cur, output: e.payload.output, isError: e.payload.isError }) }
    }
    case 'approval.requested':
      return { ...state, items: [...items, { kind: 'approval', key: e.payload.request.id, request: e.payload.request, state: 'pending', decision: null, resolvedAt: null }] }
    case 'user_input.requested':
      return { ...state, items: [...items, { kind: 'question', key: e.payload.request.id, request: e.payload.request, state: 'pending', answers: null, response: null, resolvedAt: null }] }
    case 'approval.resolved': {
      const i = items.findIndex((it) => it.kind === 'approval' && it.request.id === e.payload.requestId)
      if (i === -1) return state
      const cur = items[i] as Extract<StreamItem, { kind: 'approval' }>
      const { decision } = e.payload
      const next = decision === 'expired' ? { state: 'expired' as const, decision: null } : { state: 'resolved' as const, decision }
      return { ...state, items: items.toSpliced(i, 1, { ...cur, ...next, resolvedAt: e.createdAt }) }
    }
    case 'user_input.resolved': {
      const i = items.findIndex((it) => it.kind === 'question' && it.request.id === e.payload.requestId)
      if (i === -1) return state
      const cur = items[i] as Extract<StreamItem, { kind: 'question' }>
      return { ...state, items: items.toSpliced(i, 1, { ...cur, state: e.payload.answers ? 'resolved' : 'expired', answers: e.payload.answers, response: e.payload.response ?? null, resolvedAt: e.createdAt }) }
    }
    case 'turn.failed':
    case 'error':
      return { ...state, items: [...items, { kind: 'error', key: `e${e.seq}`, message: e.payload.message, at: e.createdAt }] }
    case 'turn.completed':
      if (e.payload.reason !== 'interrupted') return state
      return { ...state, items: [...items, { kind: 'interrupted', key: `i${e.seq}`, at: e.createdAt }] }
    case 'usage.updated':
      return { ...state, usage: { ...state.usage, [e.payload.rateLimitType]: e.payload } }
    case 'session.status':
      return { ...state, status: e.payload.status }
    case 'session.started':
    case 'session.resumed':
      return { ...state, model: e.payload.model }
    default:
      return state
  }
}

// 心跳：iOS 切后台 / 网络切换时 socket 常常"假活"，收不到 close；ping 后超时没回应就主动关掉触发重连
const pingInterval = 25_000
const pongTimeout = 10_000
const maxBackoff = 15_000

export function useSessionStream(sessionId: string): StreamState {
  const [state, dispatch] = useReducer(reduce, initial)
  // 重连时带上已有 seq，只补缺的事件；放 ref 是为了不让连接 effect 依赖 state
  const lastSeq = useRef(0)
  useEffect(() => {
    lastSeq.current = state.lastSeq
  }, [state.lastSeq])

  useEffect(() => {
    dispatch({ type: 'reset' })
    // reset 要到下次渲染才反映到 ref，切换会话时不能带着上一个会话的 seq 去订阅
    lastSeq.current = 0
    let ws: WebSocket | null = null
    let stopped = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let pongTimer: ReturnType<typeof setTimeout> | undefined
    let dismissTimer: ReturnType<typeof setTimeout> | undefined

    const clearHeartbeat = () => {
      clearInterval(pingTimer)
      clearTimeout(pongTimer)
    }
    const connect = () => {
      clearTimeout(retryTimer)
      if (stopped || (ws && ws.readyState <= WebSocket.OPEN)) return
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws = socket
      socket.onopen = () => {
        attempts = 0
        socket.send(JSON.stringify({ type: 'subscribe', sessionId, afterSeq: lastSeq.current }))
        pingTimer = setInterval(() => {
          socket.send(JSON.stringify({ type: 'ping' }))
          pongTimer = setTimeout(() => socket.close(), pongTimeout)
        }, pingInterval)
      }
      socket.onmessage = (ev) => {
        const message = JSON.parse(ev.data as string) as ServerMessage
        if (message.type === 'pong') return clearTimeout(pongTimer)
        dispatch({ type: 'server', message })
        if (message.type === 'replay.completed') {
          clearTimeout(dismissTimer)
          dismissTimer = setTimeout(() => dispatch({ type: 'replay.dismiss' }), 5000)
        }
      }
      socket.onclose = () => {
        clearHeartbeat()
        if (stopped) return
        dispatch({ type: 'connection', value: 'reconnecting' })
        retryTimer = setTimeout(connect, Math.min(maxBackoff, 1000 * 2 ** attempts++))
      }
    }
    // 回到前台 / 网络恢复时不等退避，立刻重试
    const wake = () => {
      if (document.visibilityState === 'visible') connect()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    connect()

    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      clearTimeout(retryTimer)
      clearTimeout(dismissTimer)
      clearHeartbeat()
      ws?.close()
    }
  }, [sessionId])

  return state
}
