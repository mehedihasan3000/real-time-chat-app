import type { ReactNode } from "react";

import styles from "./placeholder-notice.module.css";

export function PlaceholderNotice({
  title,
  children,
  tone = "info",
}: {
  title: string;
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <aside className={`${styles.notice} ${styles[tone]}`} aria-label={title}>
      <p className={styles.title}>{title}</p>
      <div className={styles.body}>{children}</div>
    </aside>
  );
}
