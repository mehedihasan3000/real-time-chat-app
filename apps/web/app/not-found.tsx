import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import styles from "./status.module.css";

export default function NotFound() {
  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <section className={styles.card} aria-labelledby="not-found-title">
        <p className={styles.eyebrow}>Error 404</p>
        <h1 className={styles.title} id="not-found-title">
          Page not found
        </h1>
        <p className={styles.description}>
          This route does not exist in the UI shell. Check the address or return to a known surface.
        </p>
        <div className={styles.actions}>
          <ActionLink href="/">Return home</ActionLink>
          <ActionLink href="/conversations" variant="secondary">
            Open conversations
          </ActionLink>
        </div>
        <p className={styles.reference}>
          Looking for the state gallery? <Link href="/states">Open UI states</Link>.
        </p>
      </section>
    </main>
  );
}
