"use client";

import { useState } from "react";

import { ActionButton } from "./action-button";
import styles from "./preview-form.module.css";

export function PreviewAction({
  children,
  message,
  variant = "secondary",
  describedBy,
}: {
  children: React.ReactNode;
  message: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);

  return (
    <div>
      <ActionButton
        variant={variant}
        ariaDescribedBy={describedBy}
        onClick={() => {
          setShown(true);
        }}
      >
        {children}
      </ActionButton>
      {shown ? (
        <p className={styles.status} role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
