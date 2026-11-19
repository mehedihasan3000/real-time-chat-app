import { expect, test } from "@playwright/test";

test.describe("P2-07 encrypted history pagination & UI states (TC-HIST-001, TC-HIST-004, FR-HIST-002, FR-HIST-005)", () => {
  test("exercises paginated Olm history loading, concurrent send deduplication, non-destructive older-page retry, and all FR-HIST-005 states without XSS or localStorage plaintext", async ({
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
    const showcase = page.getByTestId("history-fixture-showcase");
    await expect(showcase).toBeVisible();

    // 1. Load initial page (3 newest messages: seq 5, 6, 7) with real WASM decrypt & inert script rendering
    await showcase.getByRole("button", { name: "Load paginated history" }).click();
    const readyPanel = showcase.getByTestId("history-state-ready");
    await expect(readyPanel).toBeVisible();
    const feed = readyPanel.getByTestId("receive-message-feed");
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(3);
    await expect(feed.getByTestId("received-plaintext-msg_p207_seq_5")).toHaveText(
      `<script>window.__p207XssFired = true;</script><img src=x onerror="window.__p207XssFired = true" />`,
    );
    expect(await feed.locator("script, img").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__p207XssFired),
    ).toBeUndefined();

    // 2. Concurrent send adds seq 8 once (deduped) without breaking older cursor pagination
    await showcase.getByRole("button", { name: "Simulate concurrent send" }).click();
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(4);
    await expect(feed.getByTestId("received-plaintext-msg_p207_seq_8")).toContainText(
      "Concurrent live message without duplicates",
    );

    // 3. Page older messages -> seq 2, 3, 4 prepended (total 7) -> then seq 1 + end-of-history
    await readyPanel.getByRole("button", { name: "Load older messages" }).click();
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(7);
    await expect(feed.getByTestId("received-plaintext-msg_p207_seq_2")).toContainText(
      "যুক্তাক্ষর: ক্ষ, জ্ঞ, য় ও র‍্যাপিড",
    );

    await readyPanel.getByRole("button", { name: "Load older messages" }).click();
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(8);
    await expect(readyPanel.getByTestId("history-end-of-history")).toBeVisible();

    // Assert zero decrypted message plaintext written to localStorage/sessionStorage (DATA-013)
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.local).not.toContain("__p207XssFired");
    expect(storageDump.local).not.toContain("যুক্তাক্ষর");
    expect(storageDump.session).not.toContain("__p207XssFired");
    expect(storageDump.session).not.toContain("যুক্তাক্ষর");

    // 4. Fail older page preserves loaded seq 5, 6, 7 and recovers cleanly on Retry
    await showcase.getByRole("button", { name: "Fail older page" }).click();
    await expect(readyPanel.getByTestId("history-older-error")).toBeVisible();
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(3);
    await readyPanel.getByRole("button", { name: "Retry older messages" }).click();
    await expect(readyPanel.getByTestId("history-older-error")).toHaveCount(0);
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(6);

    // 5. TC-HIST-004 distinct states: loading, empty, offline + retry, failed + retry, forbidden, key-unavailable
    await showcase.getByRole("button", { name: "Loading state" }).click();
    await expect(showcase.getByTestId("history-state-loading")).toBeVisible();

    await showcase.getByRole("button", { name: "Empty state" }).click();
    await expect(showcase.getByTestId("history-state-empty")).toBeVisible();

    await showcase.getByRole("button", { name: "Offline state" }).click();
    const offlineState = showcase.getByTestId("history-state-offline");
    await expect(offlineState).toBeVisible();
    await offlineState.getByRole("button", { name: "Retry loading history" }).click();
    await expect(showcase.getByTestId("history-state-ready")).toBeVisible();

    await showcase.getByRole("button", { name: "Failed state" }).click();
    const failedState = showcase.getByTestId("history-state-failed");
    await expect(failedState).toBeVisible();
    await failedState.getByRole("button", { name: "Retry loading history" }).click();
    await expect(showcase.getByTestId("history-state-ready")).toBeVisible();

    await showcase.getByRole("button", { name: "Forbidden state" }).click();
    const forbiddenState = showcase.getByTestId("history-state-forbidden");
    await expect(forbiddenState).toBeVisible();
    await expect(showcase.getByTestId("history-state-ready")).toHaveCount(0);

    await showcase.getByRole("button", { name: "Key-unavailable state" }).click();
    const keyUnavailable = showcase.getByTestId("history-state-key-unavailable");
    await expect(keyUnavailable).toBeVisible();
    await expect(
      keyUnavailable.getByRole("link", { name: "Review encryption & recovery" }),
    ).toHaveAttribute("href", "/settings/encryption");

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali history states and paginated feed cleanly at 320px without horizontal overflow", async ({
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
    const showcase = page.getByTestId("history-fixture-showcase");
    await expect(showcase).toContainText(
      "এনক্রিপ্টেড ইতিহাস পৃষ্ঠাঙ্কন ও UI অবস্থা (P2-07 প্রিভিউ)",
    );

    await showcase.getByRole("button", { name: "পৃষ্ঠাঙ্কিত ইতিহাস লোড করুন" }).click();
    const readyPanel = showcase.getByTestId("history-state-ready");
    await expect(readyPanel).toBeVisible();
    await expect(readyPanel.getByRole("button", { name: "পুরোনো বার্তা লোড করুন" })).toBeVisible();

    await showcase.getByRole("button", { name: "পুরোনো পৃষ্ঠা ব্যর্থ করুন" }).click();
    await expect(showcase).toContainText("পুরোনো বার্তা লোড করা যায়নি");

    await showcase.getByRole("button", { name: "কী-অনুপলব্ধ অবস্থা" }).click();
    await expect(showcase).toContainText("এই ডিভাইসে ডিক্রিপশন কী উপলব্ধ নয়");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(consoleErrors).toEqual([]);
  });
});
