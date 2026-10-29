import Link from "next/link";
import type { ReactNode } from "react";

import { PrimaryNav } from "./primary-nav";
import styles from "./app-shell.module.css";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand} aria-label="Real-Time Chat and Calling home">
            <span className={styles.brandMark} aria-hidden="true">
              RC
            </span>
            <span className={styles.brandText}>Real-Time Chat</span>
          </Link>
          <PrimaryNav />
        </div>
      </header>

      <aside className={styles.connection} aria-label="Connection status">
        <span className={styles.dot} aria-hidden="true" />
        <p>
          <strong>Not connected.</strong> This is a static UI preview. Real-time transport,
          sessions, and message data are not implemented yet.
        </p>
      </aside>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      <footer className={styles.footer}>
        <p>UI shell preview. No security, capacity, or accessibility certification is claimed.</p>
        <nav aria-label="Secondary">
          <Link href="/">Home</Link>
          <Link href="/states">UI states</Link>
        </nav>
      </footer>
    </div>
  );
}
