import type { CSSProperties } from "react";

import { avatarToneFor, firstGrapheme } from "@/lib/avatar";

import styles from "./avatar.module.css";

export function GeneratedAvatar({
  userId,
  name,
  size = "md",
  decorative = true,
}: {
  userId: string;
  name: string;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
}) {
  const label = firstGrapheme(name).toUpperCase();
  const hue = avatarToneFor(userId);

  return (
    <span
      className={`${styles.avatar} ${styles[size]}`}
      style={{ "--avatar-hue": `${hue}` } as CSSProperties}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : `Generated avatar for ${name}`}
      aria-hidden={decorative ? true : undefined}
    >
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
