import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import styles from './Select.module.css'

export type SelectOption = { value: string; label: string; hint?: string }

type Props = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel?: string
  /** 当前值不在 options 里时显示 */
  placeholder?: string
  /** 弹层顶部加输入框，按 label / hint 过滤 */
  searchable?: boolean
}

// 原生 <select> 的弹层不跟随主题，这里用按钮 + 自绘列表替代；键盘：上下 / Enter / Escape，与 Composer 的 @ 弹层一致
export function Select({ value, options, onChange, disabled, ariaLabel, placeholder = 'Select', searchable }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value)
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)) : options

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const show = () => {
    setQuery('')
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    if (searchable) trigger.current?.focus()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    // 搜索框里空格是输入
    if (e.key === ' ' && e.target !== trigger.current) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        show()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => Math.min(shown.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => Math.max(0, i - 1))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (shown[active]) pick(shown[active].value)
        break
      case 'Escape':
        // 在弹窗里时，Escape 只收起下拉，不关外层 <dialog>
        e.preventDefault()
        setOpen(false)
        if (searchable) trigger.current?.focus()
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        data-open={open || undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className={styles.value} data-empty={!current || undefined}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className={styles.chevron} />
      </button>
      {open && (
        <div className={styles.list}>
          {searchable && (
            <input
              className={styles.search}
              value={query}
              placeholder="Search"
              aria-label={`Search ${ariaLabel ?? ''}`.trim()}
              aria-controls={listId}
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
            />
          )}
          <ul id={listId} role="listbox" className={styles.options}>
            {shown.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={styles.option}
                data-active={i === active || undefined}
                onMouseEnter={() => setActive(i)}
                // mousedown 而非 click：避免先触发外层的关闭再丢掉点击
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(o.value)
                }}
              >
                <span className={styles.optionLabel}>{o.label}</span>
                {o.hint && <span className={styles.optionHint}>{o.hint}</span>}
                {o.value === value && <Check size={14} className={styles.check} />}
              </li>
            ))}
          </ul>
          {shown.length === 0 && <div className={styles.none}>No matches</div>}
        </div>
      )}
    </div>
  )
}
