"use client";

import type { CSSProperties } from "react";

import { avatarToneFor, firstGrapheme } from "@/lib/avatar";
import { useI18n } from "@/src/i18n/provider";

import styles from "./avatar.module.css";

export function GeneratedAvatar({
  userId,
  name,
  size = "md",
  decorative = true,
  ring = false,
}: {
  userId: string;
  name: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  decorative?: boolean;
  ring?: boolean;
}) {
  const { t } = useI18n();
  const label = firstGrapheme(name).toUpperCase();
  const hue = avatarToneFor(userId);

  return (
    <span
      className={`${styles.avatar} ${styles[size]} ${ring ? styles.ring : ""}`}
      style={{ "--avatar-hue": `${hue}` } as CSSProperties}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : t("common.generatedAvatarFor", { name })}
      aria-hidden={decorative ? true : undefined}
    >
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
