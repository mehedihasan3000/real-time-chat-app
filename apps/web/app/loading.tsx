import styles from "./status.module.css";

export default function RootLoading() {
  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <section className={styles.card} role="status" aria-live="polite">
        <p className={styles.eyebrow}>Loading</p>
        <h1 className={styles.title}>Loading the UI shell</h1>
        <p className={styles.description}>
          No session, message, call, or AI data is being fetched.
        </p>
      </section>
    </main>
  );
}
