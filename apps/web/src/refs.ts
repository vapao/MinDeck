export type RefSegment = { kind: 'text' | 'skill' | 'file'; text: string } | { kind: 'session'; text: string; title: string; id: string }

/** 把消息拆成普通文字、开头的 $skill（调用方已对照列表确认才传）、@ 文件引用和 # 会话引用，供输入框与消息气泡着色 */
export function splitRefs(text: string, skill: string | null | undefined): RefSegment[] {
  const segments: RefSegment[] = []
  let rest = text
  if (skill) {
    segments.push({ kind: 'skill', text: `$${skill}` })
    rest = text.slice(skill.length + 1)
  }
  let last = 0
  // 与补全的判定一致：引用前面是开头或空白；带空格的路径写成 @"..."，末尾未闭合的引号视为正在补全
  for (const m of rest.matchAll(/(?<=^|\s)(?:#\[([^\]\r\n]*)\]\(session:([\w-]+)\)|@"[^"\r\n]*(?:"|$)|@\S+)/g)) {
    if (m.index > last) segments.push({ kind: 'text', text: rest.slice(last, m.index) })
    segments.push(m[2] ? { kind: 'session', text: m[0], title: m[1], id: m[2] } : { kind: 'file', text: m[0] })
    last = m.index + m[0].length
  }
  if (last < rest.length) segments.push({ kind: 'text', text: rest.slice(last) })
  return segments
}
