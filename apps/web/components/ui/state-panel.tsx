"use client";

import type { ReactNode } from "react";

import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./state-panel.module.css";

export type StateKind =
  "loading" | "empty" | "error" | "disconnected" | "unauthorized" | "unsupported" | "info";

const kindLabels: Record<StateKind, MessageKey> = {
  loading: "states.loadingTitle",
  empty: "states.emptyTitle",
  error: "states.errorTitle",
  disconnected: "states.disconnectedTitle",
  unauthorized: "states.unauthorizedTitle",
  unsupported: "states.unsupportedTitle",
  info: "states.infoTitle",
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
  const { t } = useI18n();

  return (
    <section
      className={`${styles.panel} ${styles[kind]}`}
      role={live && kind === "error" ? "alert" : live && kind === "loading" ? "status" : undefined}
      aria-live={live && kind === "loading" ? "polite" : undefined}
    >
      <p className={styles.kind}>{t(kindLabels[kind])}</p>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{description}</p>
      {action ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}
