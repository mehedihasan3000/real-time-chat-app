import type { ReactNode } from "react";

import styles from "./actions.module.css";

type ActionVariant = "primary" | "secondary" | "ghost" | "danger";

export function ActionButton({
  children,
  variant = "secondary",
  disabled = false,
  onClick,
  type = "button",
  ariaDescribedBy,
}: {
  children: ReactNode;
  variant?: ActionVariant;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  ariaDescribedBy?: string;
}) {
  return (
    <button
      type={type}
      className={`${styles.action} ${styles[variant]}`}
      disabled={disabled}
      onClick={onClick}
      aria-describedby={ariaDescribedBy}
    >
      {children}
    </button>
  );
}
