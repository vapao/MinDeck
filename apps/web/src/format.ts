import type { ProviderId } from '@agentdeck/shared'

export const providerName: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' }

/** 20.1K / 1.2M 这种紧凑写法 */
export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
