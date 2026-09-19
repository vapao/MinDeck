import styles from './ErrorCard.module.css'

export function ErrorCard({ message }: { message: string }) {
  return (
    <div className={styles.card}>
      <div className={styles.title}>出错了</div>
      <div className={styles.body}>{message}</div>
    </div>
  )
}
