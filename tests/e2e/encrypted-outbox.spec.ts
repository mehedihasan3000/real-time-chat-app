import { expect, test } from "@playwright/test";

test.describe("P2-09 encrypted IndexedDB outbox & Web Locks fixtures", () => {
  test("persists encrypted WASM sends in browser IndexedDB without plaintext, survives real reload, serializes 2-tab Web Locks, warns on logout, and detects key eviction & tamper", async ({
    page,
  }, testInfo) => {
    const baseOrigin = new URL(testInfo.project.use.baseURL as string).origin;
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];

    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.protocol !== "data:" && url.protocol !== "blob:" && url.origin !== baseOrigin) {
        externalRequests.push(req.url());
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/states", { waitUntil: "networkidle" });
    const showcase = page.getByTestId("encrypted-outbox-fixture-showcase");
    await expect(showcase).toBeVisible();

    const telemetry = showcase.getByTestId("encrypted-outbox-telemetry");

    // 1. Queue offline encrypted Olm send in real browser IndexedDB
    await showcase.getByRole("button", { name: "Queue offline encrypted send" }).click();
    const queuedItem = showcase.getByTestId("send-state-item-queued");
    await expect(queuedItem).toHaveCount(1);
    await expect(telemetry).toHaveAttribute("data-sealed-count", "1");
    await expect(telemetry).toHaveAttribute("data-has-key", "true");
    await expect(telemetry).toHaveAttribute("data-plaintext-bytes", "0");

    const clientMessageId = await queuedItem.getAttribute("data-client-message-id");
    expect(clientMessageId).toBeTruthy();

    // 2. Inspect real browser storage (DATA-013, DEC-021 §6.1):
    // localStorage/sessionStorage empty; IndexedDB holds non-extractable AES-GCM CryptoKey + sealed ciphertext
    const storageAudit = await page.evaluate(async () => {
      const localKeys = Object.keys(localStorage);
      const sessionKeys = Object.keys(sessionStorage);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("chat_encrypted_outbox_v1", 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = db.transaction(["outbox_keys", "outbox_entries"], "readonly");
        const keysReq = tx.objectStore("outbox_keys").get("fixture_p209_user_a");
        const entriesReq = tx
          .objectStore("outbox_entries")
          .index("by_account")
          .getAll("fixture_p209_user_a");
        const result = await new Promise<{
          keyRecord: { key?: CryptoKey; keyId?: string } | undefined;
          entries: Array<{ iv?: string; ciphertext?: string }>;
        }>((resolve, reject) => {
          tx.oncomplete = () =>
            resolve({
              keyRecord: keysReq.result as { key?: CryptoKey; keyId?: string } | undefined,
              entries: entriesReq.result as Array<{ iv?: string; ciphertext?: string }>,
            });
          tx.onerror = () => reject(tx.error);
        });
        const rawEntriesJson = JSON.stringify(result.entries);
        return {
          localKeys,
          sessionKeys,
          hasKey: Boolean(result.keyRecord?.key),
          keyExtractable: result.keyRecord?.key?.extractable ?? null,
          keyAlgName:
            (result.keyRecord?.key?.algorithm as AesKeyAlgorithm | undefined)?.name ?? null,
          entryCount: result.entries.length,
          firstHasIvAndCiphertext:
            typeof result.entries[0]?.iv === "string" &&
            result.entries[0].iv.length > 0 &&
            typeof result.entries[0]?.ciphertext === "string" &&
            result.entries[0].ciphertext.length > 0,
          containsSecretMarker: rawEntriesJson.includes("SECRET_OUTBOX_MARKER_DO_NOT_PERSIST"),
          containsPlaintextWord: rawEntriesJson.includes("plaintext"),
        };
      } finally {
        db.close();
      }
    });

    expect(storageAudit.localKeys).toEqual([]);
    expect(storageAudit.sessionKeys).toEqual([]);
    expect(storageAudit.hasKey).toBe(true);
    expect(storageAudit.keyExtractable).toBe(false);
    expect(storageAudit.keyAlgName).toBe("AES-GCM");
    expect(storageAudit.entryCount).toBe(1);
    expect(storageAudit.firstHasIvAndCiphertext).toBe(true);
    expect(storageAudit.containsSecretMarker).toBe(false);
    expect(storageAudit.containsPlaintextWord).toBe(false);

    // 3. Real browser page reload -> hydrates sealed item from IndexedDB with exact clientMessageId (TC-CHAT-005)
    await page.reload({ waitUntil: "networkidle" });
    const reloadedShowcase = page.getByTestId("encrypted-outbox-fixture-showcase");
    const reloadedTelemetry = reloadedShowcase.getByTestId("encrypted-outbox-telemetry");
    await expect(reloadedTelemetry).toHaveAttribute("data-sealed-count", "1");
    await expect(reloadedShowcase.getByTestId("send-state-item-queued")).toHaveAttribute(
      "data-client-message-id",
      clientMessageId!,
    );

    // 4. Flush persisted outbox online -> confirms accepted at sequence 1 & evicts from outbox_entries
    await reloadedShowcase
      .getByRole("button", { name: "Reconnect & flush persisted outbox" })
      .click();
    const sentItem = reloadedShowcase.getByTestId("send-state-item-sent");
    await expect(sentItem).toHaveAttribute("data-client-message-id", clientMessageId!);
    await expect(sentItem).toContainText("Confirmed accepted at sequence 1");
    await expect(reloadedTelemetry).toHaveAttribute("data-sealed-count", "0");

    // 5. 2-tab Web Locks race -> single network send & both tabs converge
    await reloadedShowcase.getByRole("button", { name: "Simulate 2-tab Web Locks race" }).click();
    await expect(reloadedShowcase.getByTestId("send-state-item-sent")).toHaveCount(1);
    await expect(reloadedTelemetry).toHaveAttribute("data-network-sends", "1");
    await expect(reloadedTelemetry).toHaveAttribute("data-sealed-count", "0");

    // 6. Logout pending warning -> key intact until confirmed sign-out
    await reloadedShowcase.getByRole("button", { name: "Sign out (warn if pending)" }).click();
    await expect(reloadedShowcase).toContainText("Unsent encrypted messages waiting in outbox");
    await expect(reloadedTelemetry).toHaveAttribute("data-sealed-count", "1");
    await expect(reloadedTelemetry).toHaveAttribute("data-has-key", "true");

    await reloadedShowcase
      .getByRole("button", { name: "Confirm sign-out & delete outbox key" })
      .click();
    await expect(reloadedTelemetry).toHaveAttribute("data-sealed-count", "0");
    await expect(reloadedTelemetry).toHaveAttribute("data-has-key", "false");

    // 7. Key eviction (STORAGE_CLEARED) & ciphertext tamper (CORRUPT_OUTBOX)
    await reloadedShowcase
      .getByRole("button", { name: "Evict IndexedDB key (storage cleared)" })
      .click();
    await expect(reloadedShowcase).toContainText("Local browser storage was cleared or reset");

    await reloadedShowcase.getByRole("button", { name: "Tamper IndexedDB ciphertext" }).click();
    await expect(reloadedShowcase).toContainText(
      "Encrypted outbox records failed integrity verification",
    );

    await reloadedShowcase.getByRole("button", { name: "Reset encrypted outbox" }).click();
    await expect(reloadedTelemetry).toHaveAttribute("data-sealed-count", "0");
    await expect(reloadedTelemetry).toHaveAttribute("data-has-key", "false");

    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali encrypted-outbox controls cleanly at 320px without horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto("/settings");
    await page.locator('input[name="interface-language"][value="bn"]').check({ force: true });
    await page.goto("/states", { waitUntil: "networkidle" });

    const showcase = page.getByTestId("encrypted-outbox-fixture-showcase");
    const telemetry = showcase.getByTestId("encrypted-outbox-telemetry");
    await expect(showcase).toContainText("এনক্রিপ্টেড IndexedDB আউটবক্স ও Web Locks");

    await showcase.getByRole("button", { name: "অফলাইন এনক্রিপ্টেড বার্তা সারিতে রাখুন" }).click();
    await expect(showcase.getByTestId("send-state-item-queued")).toContainText("সারিতে আছে");
    await expect(telemetry).toHaveAttribute("data-sealed-count", "1");

    await showcase.getByRole("button", { name: "পুনঃসংযোগ ও আউটবক্স পাঠান" }).click();
    await expect(showcase.getByTestId("send-state-item-sent")).toContainText("পাঠানো হয়েছে");
    await expect(telemetry).toHaveAttribute("data-sealed-count", "0");

    await showcase.getByRole("button", { name: "এনক্রিপ্টেড আউটবক্স রিসেট করুন" }).click();

    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasOverflow).toBe(false);
  });
});
