import { effortOptions, modelOptions, type ProviderId } from '@mindeck/shared'

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

/** 今天只写时分，更早的带上日期，免得隔天回看分不清；compact 用于侧栏，非今天只写日期 */
export function formatTime(iso: string, compact = false) {
  const date = new Date(iso)
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return time
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
  return compact ? day : `${day} ${time}`
}
