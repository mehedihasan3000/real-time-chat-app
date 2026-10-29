"use client";

import { useId, useState } from "react";

import { ActionButton } from "./action-button";
import styles from "./preview-form.module.css";

export type PreviewField = {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "search";
  autoComplete?: string;
  hint?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
};

export function PreviewForm({
  fields,
  submitLabel,
  statusMessage,
  children,
}: {
  fields: readonly PreviewField[];
  submitLabel: string;
  statusMessage: string;
  children?: React.ReactNode;
}) {
  const formId = useId().replaceAll(":", "");
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      {fields.map((field) => {
        const inputId = `${formId}-${field.name}`;
        const hintId = field.hint ? `${inputId}-hint` : undefined;

        return (
          <div className={styles.field} key={field.name}>
            <label className={styles.label} htmlFor={inputId}>
              {field.label}
            </label>
            <input
              className={styles.input}
              id={inputId}
              name={field.name}
              type={field.type ?? "text"}
              autoComplete={field.autoComplete}
              required={field.required}
              minLength={field.minLength}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              aria-describedby={hintId}
            />
            {field.hint ? (
              <p className={styles.hint} id={hintId}>
                {field.hint}
              </p>
            ) : null}
          </div>
        );
      })}
      {children}
      <div>
        <ActionButton type="submit" variant="primary">
          {submitLabel}
        </ActionButton>
      </div>
      {submitted ? (
        <p className={styles.status} role="status">
          {statusMessage}
        </p>
      ) : null}
    </form>
  );
}
