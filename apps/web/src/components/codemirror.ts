import { basicSetup } from 'codemirror'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { indentUnit, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { unifiedMergeView } from '@codemirror/merge'
import { classHighlighter, highlightCode } from '@lezer/highlight'

// 编辑器、diff 与 Markdown 静态高亮都输出 tok-* class，配色只在 FilePreview.module.css 维护一份
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'var(--text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--text-4)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--text-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-bg-2) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selected)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-bg-2)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-2)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-bg-2)', color: 'var(--text-strong)' },
  '.cm-changedLine': { backgroundColor: 'var(--ok-bg) !important' },
  '.cm-changedText': { background: 'none !important', backgroundColor: 'rgba(141, 187, 157, 0.18) !important' },
  '.cm-deletedChunk': { backgroundColor: 'var(--danger-bg) !important' },
  '.cm-deletedChunk .cm-deletedText': { background: 'none !important', backgroundColor: 'rgba(217, 141, 132, 0.2) !important' },
  '.cm-collapsedLines': { background: 'var(--surface)', color: 'var(--text-3)' },
}, { dark: true })

async function language(path: string): Promise<Extension> {
  const match = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? '')
  return match ? await match.load() : []
}

// 沿用文件已有缩进：有 Tab 缩进行多于空格缩进行就用 Tab，否则取最小的空格缩进（至少 2），没有缩进行时用默认 2 空格
function detectIndent(text: string): string {
  let tabs = 0
  let spaces = 0
  let min = Infinity
  for (const line of text.split('\n', 500)) {
    const lead = /^[ \t]*/.exec(line)![0]
    if (!lead || lead.length === line.length) continue
    if (lead[0] === '\t') tabs++
    else { spaces++; if (lead.length >= 2) min = Math.min(min, lead.length) }
  }
  if (tabs > spaces) return '\t'
  return ' '.repeat(Number.isFinite(min) ? min : 2)
}

function base(lang: Extension, readOnly: Compartment, editable: boolean): Extension {
  // 只读用 readOnly 而不是 editable=false：保留焦点，预览里也能 ⌘F 搜索
  return [basicSetup, keymap.of([indentWithTab]), syntaxHighlighting(classHighlighter), theme, lang, readOnly.of(EditorState.readOnly.of(!editable))]
}

export type CodeView = { view: EditorView; setEditable: (editable: boolean) => void; setText: (text: string) => void }

export async function createCodeView(parent: HTMLElement, opts: { text: string; path: string; editable: boolean; line?: number; onChange: (text: string) => void; onSave: () => void }): Promise<CodeView> {
  const readOnly = new Compartment()
  const state = EditorState.create({
    doc: opts.text,
    extensions: [
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { opts.onSave(); return true } }]),
      base(await language(opts.path), readOnly, opts.editable),
      indentUnit.of(detectIndent(opts.text)),
      EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange(u.state.doc.toString()) }),
    ],
  })
  const view = new EditorView({ state, parent })
  if (opts.line && opts.line <= state.doc.lines) {
    const pos = state.doc.line(opts.line).from
    view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  }
  return {
    view,
    setEditable: (editable) => {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(!editable)) })
      if (editable) view.focus()
    },
    setText: (text) => { if (text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }) },
  }
}

export async function createDiffView(parent: HTMLElement, opts: { original: string; current: string; path: string }): Promise<EditorView> {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.current,
      extensions: [
        base(await language(opts.path), new Compartment(), false),
        unifiedMergeView({ original: opts.original, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } }),
      ],
    }),
  })
}

export type CodeToken = { text: string; className: string }

/** Markdown 渲染视图里的 fenced code：不挂编辑器实例，只用同一套解析器出静态 token */
export async function highlightLines(text: string, name: string): Promise<CodeToken[][]> {
  const match = LanguageDescription.matchLanguageName(languages, name, true)
  const lines: CodeToken[][] = [[]]
  if (!match) return text.split('\n').map((text) => [{ text, className: '' }])
  const parser = (await match.load()).language.parser
  highlightCode(text, parser.parse(text), classHighlighter, (text, className) => lines[lines.length - 1].push({ text, className }), () => lines.push([]))
  return lines
}
