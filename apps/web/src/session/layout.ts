import type { StreamItem } from './useSessionStream'

// 消息流的渲染布局：按 turn 落款切成一轮轮，已结束的轮次按中途答完的回复分段，各段把中间过程折成一块；连续的工具卡并成一组紧凑显示。
// 纯函数，不改 reducer——事件流本身保持原样。

export type ToolItem = Extract<StreamItem, { kind: 'tool' }>
export type Entry =
  | StreamItem
  | { kind: 'tools'; key: string; items: ToolItem[] }
  /** 一轮已结束时的中间过程：工具卡、中间文本、处理完的审批 / 提问 */
  | { kind: 'process'; key: string; items: StreamItem[]; steps: number; tools: string }

export function layout(items: StreamItem[]): Entry[] {
  const out: Entry[] = []
  let start = 0
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'turn') continue
    out.push(...segments(items.slice(start, i + 1)).flatMap(collapse))
    start = i + 1
  }
  // 最后一段没有落款（进行中，或还没跑过）：不折叠，看着它跑
  out.push(...groupTools(items.slice(start)))
  return out
}

// 轮中追加的消息在发送时就记进了流里，可能早于 Agent 对前一条的汇总，所以不按用户消息切，按 Provider 报的"答完一段"切
function segments(turn: StreamItem[]): StreamItem[][] {
  const out: StreamItem[][] = [[]]
  for (const it of turn) {
    out[out.length - 1].push(it)
    if (it.kind === 'assistant' && it.endsReply) out.push([])
  }
  return out.filter((s) => s.length)
}

// 一段里最后一条 Agent 文本就是汇总说明；用户消息、报错、落款和仍待回答的卡片保持可见，其余归入过程块。
function collapse(turn: StreamItem[]): Entry[] {
  const finalIdx = turn.findLastIndex((it) => it.kind === 'assistant')
  const isProcess = (it: StreamItem, i: number) => i !== finalIdx && it.kind !== 'user' && it.kind !== 'error' && it.kind !== 'turn' && !((it.kind === 'question' || it.kind === 'approval') && it.state === 'pending')
  const process = turn.filter(isProcess)
  if (process.length === 0) return turn
  const block: Entry = { kind: 'process', key: `p${turn[turn.length - 1].key}`, items: process, steps: process.length, tools: summarizeTools(process) }
  const out: Entry[] = []
  turn.forEach((it, i) => {
    if (!isProcess(it, i)) out.push(it)
    else if (!out.includes(block)) out.push(block)
  })
  return out
}

// 用到的工具按次数降序：`Bash ×2 · Skill`；没有工具调用（只有中间文本 / 提问）时为空
function summarizeTools(process: StreamItem[]): string {
  const counts = new Map<string, number>()
  for (const it of process) if (it.kind === 'tool') counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' · ')
}

export function groupTools(items: StreamItem[]): Entry[] {
  const out: Entry[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (it.kind !== 'tool') out.push(it)
    else if (last?.kind === 'tools') last.items.push(it)
    else out.push({ kind: 'tools', key: `g${it.key}`, items: [it] })
  }
  return out
}
