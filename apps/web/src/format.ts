import { effortOptions, modelOptions, type ProviderId } from '@agentdeck/shared'

export const providerName: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' }

export function formatModel(provider: ProviderId, model: string | null | undefined) {
  if (!model) return ''
  if (provider === 'deepseek') model = model.replace(/\[1m\]$/, '')
  return modelOptions[provider].find((option) => option.value === model)?.label
    ?? model.replace(/^claude-/, '').replace(/(^|-)([a-z])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase()).replace(/^Gpt(?=-|$)/, 'GPT')
}

export function formatEffort(provider: ProviderId, effort: string | null | undefined) {
  if (!effort) return ''
  return effortOptions[provider].find((option) => option.value === effort)?.label ?? effort.replace(/^[a-z]/, (letter) => letter.toUpperCase())
}

/** 20.1K / 1.2M 这种紧凑写法 */
export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
