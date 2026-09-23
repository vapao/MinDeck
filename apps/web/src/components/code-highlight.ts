import { createLowlight } from 'lowlight'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'

const highlighter = createLowlight({ python, javascript, typescript, json, xml, css, bash, sql, yaml, markdown })
export type CodeToken = { text: string; className: string }

export function highlightLines(text: string, language: string): CodeToken[][] {
  if (!highlighter.registered(language)) return text.split('\n').map((text) => [{ text, className: '' }])
  const tree = highlighter.highlight(language, text)
  const lines: CodeToken[][] = [[]]
  // 先解析全文再分行，让跨行字符串、注释的颜色延续到下一行。
  function visit(nodes: typeof tree.children, classes: string[]) {
    for (const node of nodes) {
      if (node.type === 'element') visit(node.children, [...classes, ...node.properties.className as string[]])
      else if (node.type === 'text') node.value.split('\n').forEach((text, i) => {
        if (i) lines.push([])
        if (text) lines[lines.length - 1].push({ text, className: classes.join(' ') })
      })
    }
  }
  visit(tree.children, [])
  return lines
}
