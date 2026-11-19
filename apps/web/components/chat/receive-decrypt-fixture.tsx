"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  successEnvelope,
  type MessageNewEvent,
} from "@chat/contracts";
import { OlmAccountDevice, base64UrlDecode, base64UrlEncode } from "@chat/crypto";

import { ActionButton } from "@/components/ui/action-button";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import surface from "@/components/ui/surface.module.css";
import { ReceiveMessageTimeline, type ReceivedTimelineMessage } from "@/src/features/chat/receive";
import { useI18n } from "@/src/i18n/provider";

import { ReceivedMessageFeed } from "./message-feed";
import styles from "./message-feed.module.css";

const FIXTURE_CONVERSATION_ID = "conv_p206_fixture_01";
const FIXTURE_SENDER_ID = "usr_p206_alice_01";
const FIXTURE_RECIPIENT_ID = "usr_p206_bob_02";

const UNICODE_AND_SCRIPT_SAMPLES: readonly string[] = [
  "আমি বাংলায় কথা বলি — ক্ষ, জ্ঞ, য়, র‍্যাপিড এবং 🇧🇩👨‍👩‍👧‍👦💬🔐",
  `<script>window.__p206XssFired = true;</script><img src=x onerror="window.__p206XssFired = true" /> javascript:alert(1)`,
];

interface FixtureRuntime {
  alice: OlmAccountDevice;
  bob: OlmAccountDevice;
  timeline: ReceiveMessageTimeline;
  seq: number;
}

function mutateEnvelopeCiphertext(encodedEnvelope: string): string {
  const bytes = base64UrlDecode(encodedEnvelope);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<
    string,
    unknown
  >;
  const rawCt = base64UrlDecode(String(parsed.ciphertext));
  const tampered = new Uint8Array(rawCt);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
  parsed.ciphertext = base64UrlEncode(tampered);
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(parsed)));
}

function makeFixtureEvent(
  seq: number,
  senderDeviceId: string,
  encryptedEnvelope: string,
  protocolVersion: string = MESSAGE_ALLOWED_PROTOCOL_VERSION,
): MessageNewEvent {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: `msg_p206_seq_${seq}`,
    conversationId: FIXTURE_CONVERSATION_ID,
    seq,
    senderUserId: FIXTURE_SENDER_ID,
    senderDeviceId,
    clientMessageId: globalThis.crypto.randomUUID(),
    protocolVersion,
    encryptedEnvelope,
    committedAt: new Date(Date.UTC(2026, 10, 19, 10, 0, seq)).toISOString(),
  };
}

/**
 * Interactive real-WASM receive/decrypt/render showcase on `/states` (`P2-06`,
 * `TC-CHAT-008`, `FR-CHAT-013`, `FR-CHAT-014`, `NFR-REC-002`, `FR-SEC-013`).
 *
 * Uses in-browser `OlmAccountDevice` (`vodozemac` 0.11.2 WASM) purely in memory
 * with zero network traffic and zero `localStorage` persistence (`DATA-013`).
 */
export function ReceiveDecryptFixtureShowcase() {
  const { t } = useI18n();
  const runtimeRef = useRef<FixtureRuntime | null>(null);
  const [items, setItems] = useState<readonly ReceivedTimelineMessage[]>([]);
  const [busy, setBusy] = useState(false);

  const ensureRuntime = useCallback(async (): Promise<FixtureRuntime> => {
    if (runtimeRef.current) return runtimeRef.current;
    const [alice, bob] = await Promise.all([
      OlmAccountDevice.create({ deviceId: "dev_p206_alice_01" }),
      OlmAccountDevice.create({ deviceId: "dev_p206_bob_02" }),
    ]);
    const timeline = new ReceiveMessageTimeline({
      accountId: FIXTURE_RECIPIENT_ID,
      conversationId: FIXTURE_CONVERSATION_ID,
      device: bob,
    });
    timeline.subscribe((next) => {
      setItems(next);
    });
    const rt: FixtureRuntime = { alice, bob, timeline, seq: 0 };
    runtimeRef.current = rt;
    return rt;
  }, []);

  useEffect(() => {
    return () => {
      if (runtimeRef.current) {
        runtimeRef.current.timeline.dispose();
        runtimeRef.current.alice.dispose();
        runtimeRef.current.bob.dispose();
        runtimeRef.current = null;
      }
    };
  }, []);

  const runValidUnicodeAndScriptFixture = useCallback(async () => {
    setBusy(true);
    try {
      const rt = await ensureRuntime();
      const bobBundle = rt.bob.toPublicKeyBundle();
      const firstPreKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;

      for (const sample of UNICODE_AND_SCRIPT_SAMPLES) {
        const encrypted = await rt.alice.encryptForPeer(
          {
            peerUserId: FIXTURE_RECIPIENT_ID,
            peerDeviceId: rt.bob.deviceId,
            peerIdentityKey: rt.bob.identityKey,
            peerSenderKey: rt.bob.senderKey,
            peerOneTimeOrFallbackKey: firstPreKey,
          },
          sample,
        );
        if (!encrypted.ok) continue;
        rt.seq += 1;
        const event = makeFixtureEvent(
          rt.seq,
          rt.alice.deviceId,
          encrypted.value.encryptedEnvelope,
        );
        await rt.timeline.ingestSocketMessageNew(successEnvelope(event));
      }
    } finally {
      setBusy(false);
    }
  }, [ensureRuntime]);

  const runTamperedFixture = useCallback(async () => {
    setBusy(true);
    try {
      const rt = await ensureRuntime();
      const bobBundle = rt.bob.toPublicKeyBundle();
      const preKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;
      const encrypted = await rt.alice.encryptForPeer(
        {
          peerUserId: FIXTURE_RECIPIENT_ID,
          peerDeviceId: rt.bob.deviceId,
          peerIdentityKey: rt.bob.identityKey,
          peerSenderKey: rt.bob.senderKey,
          peerOneTimeOrFallbackKey: preKey,
        },
        "Tampered integrity sample",
      );
      if (!encrypted.ok) return;
      rt.seq += 1;
      const corrupted = mutateEnvelopeCiphertext(encrypted.value.encryptedEnvelope);
      const event = makeFixtureEvent(rt.seq, rt.alice.deviceId, corrupted);
      await rt.timeline.ingestSocketMessageNew(successEnvelope(event));
    } finally {
      setBusy(false);
    }
  }, [ensureRuntime]);

  const runMissingKeyAndUnsupportedFixture = useCallback(async () => {
    setBusy(true);
    try {
      const rt = await ensureRuntime();
      const strayDevice = await OlmAccountDevice.create({ deviceId: "dev_p206_other_99" });
      try {
        const strayBundle = strayDevice.toPublicKeyBundle();
        const encrypted = await rt.alice.encryptForPeer(
          {
            peerUserId: "usr_p206_stray_99",
            peerDeviceId: strayDevice.deviceId,
            peerIdentityKey: strayDevice.identityKey,
            peerSenderKey: strayDevice.senderKey,
            peerOneTimeOrFallbackKey:
              strayBundle.oneTimeKeys[0]?.key ?? strayBundle.fallbackKey.key,
          },
          "Encrypted for a different device",
        );
        if (encrypted.ok) {
          rt.seq += 1;
          const missingKeyEvent = makeFixtureEvent(
            rt.seq,
            rt.alice.deviceId,
            encrypted.value.encryptedEnvelope,
          );
          await rt.timeline.ingestSocketMessageNew(successEnvelope(missingKeyEvent));

          rt.seq += 1;
          const downgradeEvent = makeFixtureEvent(
            rt.seq,
            rt.alice.deviceId,
            encrypted.value.encryptedEnvelope,
            "olm-v0",
          );
          await rt.timeline.ingestSocketMessageNew(successEnvelope(downgradeEvent));
        }
      } finally {
        strayDevice.dispose();
      }
    } finally {
      setBusy(false);
    }
  }, [ensureRuntime]);

  const handleReset = useCallback(() => {
    if (runtimeRef.current) {
      runtimeRef.current.timeline.dispose();
      runtimeRef.current.alice.dispose();
      runtimeRef.current.bob.dispose();
      runtimeRef.current = null;
    }
    setItems([]);
  }, []);

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-labelledby="receive-decrypt-showcase-title"
      data-testid="receive-decrypt-showcase"
    >
      <div className={styles.wrapper}>
        <div>
          <h2 className={surface.cardTitle} id="receive-decrypt-showcase-title">
            {t("states.receiveDecryptTitle")}
          </h2>
          <p className={surface.cardDescription}>{t("states.receiveDecryptDescription")}</p>
        </div>

        <PlaceholderNotice title={t("states.receiveDecryptNoticeTitle")}>
          <p>{t("states.receiveDecryptNoticeBody")}</p>
        </PlaceholderNotice>

        <div className={styles.toolbar}>
          <ActionButton
            variant="primary"
            disabled={busy}
            onClick={() => void runValidUnicodeAndScriptFixture()}
          >
            {t("states.receiveDecryptRunValid")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            onClick={() => void runTamperedFixture()}
          >
            {t("states.receiveDecryptRunTampered")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            onClick={() => void runMissingKeyAndUnsupportedFixture()}
          >
            {t("states.receiveDecryptRunMissingKey")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={handleReset}>
            {t("states.receiveDecryptReset")}
          </ActionButton>
        </div>

        <ReceivedMessageFeed
          items={items}
          ariaLabel={t("receiveMessage.listLabel")}
          emptyMessage={t("receiveMessage.empty")}
        />
      </div>
    </section>
  );
}
