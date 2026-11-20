import { expect, test } from "@playwright/test";

test.describe("P2-10 offline recipient delivery & recovery UI (TC-CHAT-004, DEC-015, DEC-020, DEC-021)", () => {
  test("delivers retained offline ciphertext after missing-key reconnect and key unseal, enforces opt-in focused read, and keeps storage/DOM free of plaintext leaks", async ({
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
    const showcase = page.getByTestId("offline-delivery-fixture-showcase");
    await expect(showcase).toBeVisible();

    const status = showcase.getByTestId("offline-delivery-fixture-status");
    const readSharing = showcase.getByTestId("offline-delivery-read-sharing");

    // 1. Send 3 messages while recipient device is sealed/offline (+35d retention)
    await showcase
      .getByRole("button", { name: "Send 3 messages while recipient offline (+35d)" })
      .click();

    await expect(status).toHaveAttribute("data-recipient-state", "offline");
    await expect(status).toHaveAttribute("data-retained-count", "3");
    await expect(status).toHaveAttribute("data-sent-count", "3");
    await expect(status).toHaveAttribute("data-delivered-count", "0");
    await expect(status).toHaveAttribute("data-read-count", "0");
    await expect(status).toContainText("Offline retention: 35d");
    await expect(
      showcase.locator('[data-testid^="offline-sender-item-"][data-delivery-stage="sent"]'),
    ).toHaveCount(3);

    // 2. Reconnect while recipient key is still locked -> missing-key placeholders, zero delivery advancement
    await showcase
      .getByRole("button", { name: "Reconnect recipient (key locked / missing)" })
      .click();
    await expect(status).toHaveAttribute("data-recipient-state", "key_locked");
    await expect(status).toHaveAttribute("data-sent-count", "3");
    await expect(status).toHaveAttribute("data-delivered-count", "0");
    await expect(status).toHaveAttribute("data-read-count", "0");

    const feed = showcase.getByTestId("receive-message-feed");
    await expect(feed.locator('[data-message-kind="decryption_failed"]')).toHaveCount(3);
    await expect(feed.locator('[data-failure-state="missing-key"]')).toHaveCount(3);
    await expect(feed.locator('[data-receipt-eligible="false"]')).toHaveCount(3);

    // Focusing missing-key placeholders must never emit read or delivery receipts.
    await showcase
      .getByRole("button", { name: "Display in focused view (emit read if enabled)" })
      .click();
    await expect(status).toHaveAttribute("data-delivered-count", "0");
    await expect(status).toHaveAttribute("data-read-count", "0");

    // 3. Unseal recipient Olm device key -> decrypt all 3 retained messages in seq order & advance to delivered
    await showcase.getByRole("button", { name: "Unseal recipient key & deliver" }).click();
    await expect(status).toHaveAttribute("data-recipient-state", "delivered");
    await expect(status).toHaveAttribute("data-sent-count", "3");
    await expect(status).toHaveAttribute("data-delivered-count", "3");
    await expect(status).toHaveAttribute("data-read-count", "0");
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(3);
    await expect(feed.locator('[data-receipt-eligible="true"]')).toHaveCount(3);
    await expect(
      showcase.locator('[data-testid^="offline-sender-item-"][data-delivery-stage="delivered"]'),
    ).toHaveCount(3);

    await expect(feed.getByTestId("received-plaintext-msg_p210_seq_1")).toContainText(
      "Offline retained message 1 — durable sent while recipient disconnected",
    );
    await expect(feed.getByTestId("received-plaintext-msg_p210_seq_2")).toContainText(
      "অফলাইন বার্তা ২ — যুক্তাক্ষর: ক্ষ, জ্ঞ 🇧🇩",
    );
    await expect(feed.getByTestId("received-plaintext-msg_p210_seq_3")).toHaveText(
      `<script>window.__p210XssFired = true;</script><img src=x onerror="window.__p210XssFired = true" />`,
    );
    expect(await feed.locator("script, img").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__p210XssFired),
    ).toBeUndefined();

    // 4. Focused display with default-off read sharing keeps stage at delivered (readCount stays 0)
    await expect(readSharing).toContainText("Read sharing: Off (default)");
    await showcase
      .getByRole("button", { name: "Display in focused view (emit read if enabled)" })
      .click();
    await expect(status).toHaveAttribute("data-delivered-count", "3");
    await expect(status).toHaveAttribute("data-read-count", "0");

    // 5. Toggle opt-in read sharing On + focus -> advances monotonically delivered -> read
    await showcase.getByRole("button", { name: "Toggle recipient read sharing" }).click();
    await expect(readSharing).toContainText("Read sharing: On (reciprocal opt-in)");
    await showcase
      .getByRole("button", { name: "Display in focused view (emit read if enabled)" })
      .click();
    await expect(status).toHaveAttribute("data-recipient-state", "read");
    await expect(status).toHaveAttribute("data-delivered-count", "3");
    await expect(status).toHaveAttribute("data-read-count", "3");
    await expect(
      showcase.locator('[data-testid^="offline-sender-item-"][data-delivery-stage="read"]'),
    ).toHaveCount(3);

    // Zero decrypted message plaintext persisted in localStorage/sessionStorage (DATA-013)
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.local).not.toContain("__p210XssFired");
    expect(storageDump.local).not.toContain("Offline retained message 1");
    expect(storageDump.session).not.toContain("__p210XssFired");
    expect(storageDump.session).not.toContain("Offline retained message 1");

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali offline recipient delivery flow at 320px without horizontal overflow", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.setViewportSize({ width: 320, height: 740 });
    await page.addInitScript(() => {
      window.localStorage.setItem("chat-ui-locale", "bn");
    });

    await page.goto("/states", { waitUntil: "networkidle" });
    const showcase = page.getByTestId("offline-delivery-fixture-showcase");
    await expect(showcase).toContainText(
      "অফলাইন প্রাপকের বার্তা গ্রহণ ও সংরক্ষিত ক্যাচ-আপ (P2-10 প্রিভিউ)",
    );

    await showcase
      .getByRole("button", { name: "প্রাপক অফলাইনে থাকা অবস্থায় ৩টি বার্তা পাঠান (+৩৫ দিন)" })
      .click();
    const status = showcase.getByTestId("offline-delivery-fixture-status");
    await expect(status).toHaveAttribute("data-sent-count", "3");
    await expect(showcase.getByTestId("offline-delivery-sender-ledger")).toContainText(
      "পাঠানো হয়েছে (সার্ভারে সংরক্ষিত)",
    );

    await showcase
      .getByRole("button", { name: "প্রাপক পুনরায় সংযুক্ত (কী লকড / অনুপস্থিত)" })
      .click();
    await expect(status).toHaveAttribute("data-recipient-state", "key_locked");

    await showcase.getByRole("button", { name: "প্রাপক কী আনসিল ও বার্তা গ্রহণ" }).click();
    await expect(status).toHaveAttribute("data-delivered-count", "3");
    await expect(showcase.getByTestId("offline-delivery-sender-ledger")).toContainText(
      "গৃহীত (এন্ডপয়েন্টে ডিক্রিপ্ট হয়েছে)",
    );
    await expect(showcase.getByTestId("received-plaintext-msg_p210_seq_2")).toContainText(
      "অফলাইন বার্তা ২ — যুক্তাক্ষর: ক্ষ, জ্ঞ 🇧🇩",
    );

    await showcase.getByRole("button", { name: "পঠিত রসিদ শেয়ারিং বদলান" }).click();
    await showcase
      .getByRole("button", { name: "ফোকাসড ভিউয়ে দেখুন (সম্মতি থাকলে পঠিত পাঠান)" })
      .click();
    await expect(status).toHaveAttribute("data-read-count", "3");
    await expect(showcase.getByTestId("offline-delivery-sender-ledger")).toContainText(
      "পঠিত (ফোকাসড ও সম্মত)",
    );

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    expect(consoleErrors).toEqual([]);
  });
});
