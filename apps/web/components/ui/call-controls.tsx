"use client";

import { useState } from "react";

import { CameraIcon, MicIcon, PhoneOffIcon } from "@/components/icons";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./call-controls.module.css";

const controls = [
  {
    id: "microphone",
    labelKey: "call.controlMicrophone",
    messageKey: "call.controlMicrophoneMessage",
    icon: MicIcon,
  },
  {
    id: "camera",
    labelKey: "call.controlCamera",
    messageKey: "call.controlCameraMessage",
    icon: CameraIcon,
  },
  {
    id: "end",
    labelKey: "call.controlEnd",
    messageKey: "call.controlEndMessage",
    icon: PhoneOffIcon,
    danger: true,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  labelKey: MessageKey;
  messageKey: MessageKey;
  icon: typeof MicIcon;
  danger?: boolean;
}>;

export function CallControls() {
  const { t } = useI18n();
  const [messageKey, setMessageKey] = useState<MessageKey | null>(null);

  return (
    <div className={styles.controls}>
      <div className={styles.buttons}>
        {controls.map((control) => {
          const Icon = control.icon;

          return (
            <button
              className={`${styles.button} ${"danger" in control && control.danger ? styles.danger : ""}`}
              key={control.id}
              type="button"
              onClick={() => setMessageKey(control.messageKey)}
              aria-describedby="call-controls-hint"
            >
              <Icon size={20} />
              <span>{t(control.labelKey)}</span>
            </button>
          );
        })}
      </div>
      {messageKey ? (
        <p className={styles.status} role="status">
          {t(messageKey)}
        </p>
      ) : null}
    </div>
  );
}
