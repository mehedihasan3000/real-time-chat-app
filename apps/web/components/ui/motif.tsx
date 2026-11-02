import { HeartIcon } from "@/components/icons";

import styles from "./motif.module.css";

export function HeartDivider({ className }: { className?: string }) {
  return (
    <div className={`${styles.divider} ${className ?? ""}`} aria-hidden="true">
      <span />
      <HeartIcon size={16} />
      <span />
    </div>
  );
}

export function PressedFlower({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`${styles.flower} ${className ?? ""}`}
      fill="none"
      focusable="false"
      viewBox="0 0 120 120"
    >
      <path
        d="M60 66c-1-14 3-27 13-37 7-7 16-10 25-9-1 9-4 18-11 25-9 9-18 13-27 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
      <path
        d="M60 70c-11-8-17-19-17-32 0-9 3-17 9-23 6 6 9 14 9 23 0 12-4 23-1 32"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
      <path
        d="M60 70c-12-2-22-8-29-18-5-7-7-15-6-23 8 1 16 5 21 12 7 9 11 19 14 29Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
      <path
        d="M60 70c2-12 8-22 18-29 7-5 15-7 23-6-1 8-5 16-12 21-9 7-19 11-29 14Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
      <circle cx="60" cy="72" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M60 78v30M60 92c-8 0-14-4-17-11 8-1 14 3 17 11ZM60 98c7-1 12-5 14-11-7-1-12 3-14 11Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function HeartMark({ className }: { className?: string }) {
  return (
    <span className={`${styles.mark} ${className ?? ""}`} aria-hidden="true">
      <HeartIcon size={18} />
    </span>
  );
}
