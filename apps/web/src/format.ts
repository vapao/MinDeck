import type { ProviderId } from '@agentdeck/shared'

export const providerName: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' }

/** 20.1K / 1.2M 这种紧凑写法 */
export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 工具卡片单行摘要：常见工具取最有辨识度的参数，其余压成一行 JSON
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const o = input as Record<string, unknown>
  for (const k of ['command', 'file_path', 'pattern', 'path', 'query', 'description']) {
    if (typeof o[k] === 'string') return o[k]
  }
  return JSON.stringify(o)
}
