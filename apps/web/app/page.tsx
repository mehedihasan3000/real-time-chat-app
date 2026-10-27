import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Application scaffold</p>
        <h1 className={styles.title}>Real-Time Chat and Calling</h1>
        <p className={styles.lead}>
          One-to-one messaging and audio/video calling. The workspace is running; product features
          land in later tasks.
        </p>
        <p className={styles.note}>
          No security, capacity, or accessibility claim is made at this stage.
        </p>
      </section>
    </main>
  );
}
