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
