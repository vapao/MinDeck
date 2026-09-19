import { useEffect, useReducer } from 'react'
import type { AgentEvent, ServerMessage, Session, SessionStatus } from '@agentdeck/shared'

// 会话页的实时状态 = 对事件流做 reduce（方案 §13.1）。一个 seq 只处理一次，重放与 live 共用同一条路径。

export type StreamItem =
  | { kind: 'user'; key: string; text: string; at: string }
  | { kind: 'assistant'; key: string; messageId: string; text: string; streaming: boolean; at: string }
  | { kind: 'tool'; key: string; toolUseId: string; name: string; input: unknown; output: string | null; isError: boolean; at: string }
  | { kind: 'error'; key: string; message: string; at: string }

export type StreamState = {
  session: Session | null
  status: SessionStatus
  items: StreamItem[]
  lastSeq: number
  connection: 'connecting' | 'open' | 'closed'
}

type Action = { type: 'server'; message: ServerMessage } | { type: 'connection'; value: StreamState['connection'] } | { type: 'reset' }

const initial: StreamState = { session: null, status: 'idle', items: [], lastSeq: 0, connection: 'connecting' }

function reduce(state: StreamState, action: Action): StreamState {
  if (action.type === 'reset') return initial
  if (action.type === 'connection') return { ...state, connection: action.value }
  const m = action.message
  switch (m.type) {
    case 'snapshot':
      return { ...state, session: m.session, status: m.session.status }
    case 'event':
      if (m.event.seq <= state.lastSeq) return state
      return applyEvent({ ...state, lastSeq: m.event.seq }, m.event)
    default:
      return state
  }
}

function applyEvent(state: StreamState, e: AgentEvent): StreamState {
  const items = state.items
  switch (e.type) {
    case 'message.user':
      return { ...state, items: [...items, { kind: 'user', key: `u${e.seq}`, text: e.payload.text, at: e.createdAt }] }
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
    case 'turn.failed':
    case 'error':
      return { ...state, items: [...items, { kind: 'error', key: `e${e.seq}`, message: e.payload.message, at: e.createdAt }] }
    case 'session.status':
      return { ...state, status: e.payload.status }
    default:
      return state
  }
}

export function useSessionStream(sessionId: string): StreamState {
  const [state, dispatch] = useReducer(reduce, initial)

  useEffect(() => {
    dispatch({ type: 'reset' })
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws.onopen = () => {
      dispatch({ type: 'connection', value: 'open' })
      ws.send(JSON.stringify({ type: 'subscribe', sessionId, afterSeq: 0 }))
    }
    ws.onmessage = (ev) => dispatch({ type: 'server', message: JSON.parse(ev.data as string) as ServerMessage })
    ws.onclose = () => dispatch({ type: 'connection', value: 'closed' })
    return () => ws.close()
  }, [sessionId])

  return state
}
