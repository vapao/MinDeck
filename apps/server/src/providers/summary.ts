// 工具卡片单行摘要：常见工具取最有辨识度的参数，其余压成一行 JSON。事件里只存这一行，不存完整 input（Write 的 content 之类能有几十 KB）
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  let summary = '';
  for (const k of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'skill', 'description']) {
    if (typeof o[k] === 'string') {
      summary = o[k];
      break;
    }
  }
  if (!summary) summary = JSON.stringify(o);
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
}
