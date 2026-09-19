import { useState, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import styles from './Composer.module.css'

type Props = { disabled: boolean; hint: string; onSend: (text: string) => void }

export function Composer({ disabled, hint, onSend }: Props) {
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.hint}>{hint}</div>
      <div className={styles.box}>
        <textarea
          className={styles.input}
          rows={1}
          value={text}
          placeholder="给 Claude 发消息…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className={styles.send} onClick={submit} disabled={disabled || !text.trim()} aria-label="发送">
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
  )
}
