import { expect, test } from "@playwright/test";

test.describe("P2-11 monotonic receipts, opt-in read sharing & private unread UI (TC-CHAT-006, TC-HIST-003)", () => {
  test("verifies endpoint decryption delivery, 500 ms focus debounce, reciprocal opt-in read sharing, undecryptable exclusion, monotonic merge, and DOM/storage safety", async ({
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
    const showcase = page.getByTestId("receipts-unread-fixture");
    await expect(showcase).toBeVisible();

    const status = showcase.getByTestId("receipts-unread-status");

    // 1. Seed 3 decryptable messages (seq 1..3), gap at seq 4, and 1 undecryptable message (seq 5)
    await showcase.getByRole("button", { name: "Seed incoming messages" }).click();
    await expect(status).toHaveAttribute("data-phase", "seeded_unread");
    await expect(status).toHaveAttribute("data-unread-count", "5");
    await expect(status).toHaveAttribute("data-read-through-seq", "0");
    await expect(status).toHaveAttribute("data-bob-share", "false");
    await expect(status).toHaveAttribute("data-alice-share", "false");
    await expect(
      showcase.locator('[data-testid^="receipts-sender-row-"][data-stage="sent"]'),
    ).toHaveCount(4);

    // 2. Decrypt on Bob's endpoint: seq 1..3 advance to delivered; undecryptable seq 5 stays sent
    await showcase.getByRole("button", { name: "Receive & decrypt" }).click();
    await expect(status).toHaveAttribute("data-phase", "decrypted_delivered");
    await expect(status).toHaveAttribute("data-unread-count", "4");
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_1")).toHaveAttribute(
      "data-stage",
      "delivered",
    );
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_2")).toHaveAttribute(
      "data-stage",
      "delivered",
    );
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_3")).toHaveAttribute(
      "data-stage",
      "delivered",
    );
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_5")).toHaveAttribute(
      "data-stage",
      "sent",
    );

    const feed = showcase.getByTestId("receive-message-feed");
    await expect(feed.getByTestId("received-plaintext-msg_p211_seq_2")).toContainText(
      "গোপনীয় বার্তা ২ — যুক্তাক্ষর: ক্ষ, জ্ঞ 🇧🇩",
    );
    await expect(feed.getByTestId("received-plaintext-msg_p211_seq_3")).toHaveText(
      `<script>window.__p211XssFired = true;</script>Safe sanitized render 3`,
    );
    expect(await feed.locator("script, img").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__p211XssFired),
    ).toBeUndefined();

    // 3. Opt-in reciprocal read sharing on both sides, then focus <500 ms and blur -> cancels timer cleanly
    await showcase.getByRole("button", { name: "Toggle Bob read sharing" }).click();
    await showcase.getByRole("button", { name: "Toggle Alice read sharing" }).click();
    await expect(status).toHaveAttribute("data-bob-share", "true");
    await expect(status).toHaveAttribute("data-alice-share", "true");

    await showcase.getByRole("button", { name: "Focus conversation (500 ms)" }).click();
    await showcase.getByRole("button", { name: "Blur / leave conversation" }).click();
    await page.waitForTimeout(580);
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_1")).toHaveAttribute(
      "data-stage",
      "delivered",
    );
    await expect(status).toHaveAttribute("data-read-through-seq", "0");
    await expect(status).toHaveAttribute("data-unread-count", "4");

    // 4. Focus conversation for >= 500 ms -> private unread drops to 0 and seq 1..3 become "read"
    await showcase.getByRole("button", { name: "Focus conversation (500 ms)" }).click();
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_1")).toHaveAttribute(
      "data-stage",
      "read",
      { timeout: 3000 },
    );
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_2")).toHaveAttribute(
      "data-stage",
      "read",
    );
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_3")).toHaveAttribute(
      "data-stage",
      "read",
    );
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_5")).toHaveAttribute(
      "data-stage",
      "sent",
    );
    await expect(status).toHaveAttribute("data-read-through-seq", "5");
    await expect(status).toHaveAttribute("data-unread-count", "0");

    // 5. Replay stale lower "delivered" receipt & duplicate timeline -> monotonic stage & 0 unread hold
    await showcase.getByRole("button", { name: "Replay stale receipt & gap" }).click();
    await expect(status).toHaveAttribute("data-regressed-blocked", "1");
    await expect(status).toHaveAttribute("data-unread-count", "0");
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_1")).toHaveAttribute(
      "data-stage",
      "read",
    );

    // 6. Toggle bilateral block -> historical confirmed receipts preserved
    await showcase.getByRole("button", { name: "Toggle bilateral block" }).click();
    await expect(status).toHaveAttribute("data-blocked", "true");
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_1")).toHaveAttribute(
      "data-stage",
      "read",
    );

    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.local).not.toContain("__p211XssFired");
    expect(storageDump.local).not.toContain("Receipts check 1");
    expect(storageDump.session).not.toContain("__p211XssFired");
    expect(storageDump.session).not.toContain("Receipts check 1");

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali P2-11 receipts & unread UI at 320px without horizontal overflow", async ({
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
    const showcase = page.getByTestId("receipts-unread-fixture");
    await expect(showcase).toContainText("একমুখী রসিদ ও ব্যক্তিগত পঠিত অগ্রগতি (P2-11)");

    await showcase.getByRole("button", { name: "আগত বার্তা সিড করুন" }).click();
    await showcase.getByRole("button", { name: "গ্রহণ ও ডিক্রিপ্ট করুন" }).click();
    const status = showcase.getByTestId("receipts-unread-status");
    await expect(status).toHaveAttribute("data-unread-count", "4");

    // Focus with read sharing still default OFF -> unread clears to 0 without emitting read
    await showcase.getByRole("button", { name: "কথোপকথনে ফোকাস করুন (৫০০ মি.সে.)" }).click();
    await expect(status).toHaveAttribute("data-unread-count", "0", { timeout: 3000 });
    await expect(showcase.getByTestId("receipts-sender-row-msg_p211_seq_1")).toHaveAttribute(
      "data-stage",
      "delivered",
    );

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    expect(consoleErrors).toEqual([]);
  });
});
