import type { ReactNode } from "react";

import styles from "./state-panel.module.css";

export type StateKind =
  "loading" | "empty" | "error" | "disconnected" | "unauthorized" | "unsupported" | "info";

const kindLabels: Record<StateKind, string> = {
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  disconnected: "Disconnected",
  unauthorized: "Access required",
  unsupported: "Unsupported",
  info: "Information",
};

export function StatePanel({
  kind,
  title,
  description,
  action,
  live = false,
}: {
  kind: StateKind;
  title: string;
  description: string;
  action?: ReactNode;
  live?: boolean;
}) {
  return (
    <section
      className={`${styles.panel} ${styles[kind]}`}
      role={live && kind === "error" ? "alert" : live && kind === "loading" ? "status" : undefined}
      aria-live={live && kind === "loading" ? "polite" : undefined}
    >
      <p className={styles.kind}>{kindLabels[kind]}</p>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{description}</p>
      {action ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}
