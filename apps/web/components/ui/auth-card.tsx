import type { ReactNode } from "react";

import styles from "./auth-card.module.css";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={styles.card} aria-labelledby="auth-title">
      <p className={styles.eyebrow}>Account access</p>
      <h1 className={styles.title} id="auth-title">
        {title}
      </h1>
      <p className={styles.description}>{description}</p>
      <div className={styles.body}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </section>
  );
}
