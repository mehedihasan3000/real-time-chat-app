import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./auth-layout.module.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Real-Time Chat and Calling home">
          <span className={styles.brandMark} aria-hidden="true">
            RC
          </span>
          <span>Real-Time Chat</span>
        </Link>
        <nav className={styles.headerNav} aria-label="Account">
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up">Create account</Link>
        </nav>
      </header>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      <footer className={styles.footer}>
        <p>Preview only — authentication is implemented in P1-06.</p>
        <nav aria-label="Secondary">
          <Link href="/">Home</Link>
          <Link href="/states">UI states</Link>
        </nav>
      </footer>
    </div>
  );
}
