import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./actions.module.css";

type ActionVariant = "primary" | "secondary" | "ghost" | "danger";

export function ActionLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: ActionVariant;
}) {
  return (
    <Link href={href} className={`${styles.action} ${styles[variant]}`}>
      {children}
    </Link>
  );
}
