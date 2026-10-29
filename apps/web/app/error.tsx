"use client";

import Link from "next/link";

import { ActionButton } from "@/components/ui/action-button";
import styles from "./status.module.css";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <section className={styles.card} role="alert" aria-labelledby="error-title">
        <p className={styles.eyebrow}>Error</p>
        <h1 className={styles.title} id="error-title">
          Something went wrong
        </h1>
        <p className={styles.description}>
          The shell could not render this route. No message, call, or AI request is implied by this
          error. Try again, or return to a known surface.
        </p>
        {error.digest ? (
          <p className={styles.reference}>
            Safe reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <div className={styles.actions}>
          <ActionButton variant="primary" onClick={reset}>
            Try again
          </ActionButton>
          <Link href="/">Return home</Link>
          <Link href="/states">View UI states</Link>
        </div>
      </section>
    </main>
  );
}
