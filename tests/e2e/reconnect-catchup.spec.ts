import { expect, test } from "@playwright/test";

test.describe("P2-08 reconnect catch-up & expired-session UI (TC-HIST-002, FR-AUTH-007, FR-CHAT-012, FR-HIST-003)", () => {
  test("recovers offline messages, subscribe/catch-up live races, and dropped/reordered gaps in browser WASM and stops actions on session expiry without XSS or localStorage leakage", async ({
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
    const showcase = page.getByTestId("reconnect-fixture-showcase");
    await expect(showcase).toBeVisible();

    // 1. Disconnect + offline messages + live seq 5 arriving between subscribe & HTTP catch-up
    await showcase.getByRole("button", { name: "Simulate disconnect & subscribe race" }).click();
    const banner = showcase.getByTestId("realtime-sync-banner");
    await expect(banner).toHaveAttribute("data-connection-status", "connected");
    await expect(showcase.getByTestId("reconnect-fixture-status")).toContainText(
      "Watermark seq: 5",
    );

    const feed = showcase.getByTestId("receive-message-feed");
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(5);
    await expect(feed.getByTestId("received-plaintext-msg_p208_seq_2")).toContainText(
      "যুক্তাক্ষর: ক্ষ, জ্ঞ",
    );
    await expect(feed.getByTestId("received-plaintext-msg_p208_seq_4")).toHaveText(
      `<script>window.__p208XssFired = true;</script><img src=x onerror="window.__p208XssFired = true" />`,
    );
    await expect(feed.getByTestId("received-plaintext-msg_p208_seq_5")).toContainText(
      "Fifth message arrived between subscribe & catch-up",
    );
    expect(await feed.locator("script, img").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__p208XssFired),
    ).toBeUndefined();

    // 2. Dropped/reordered live event + permanent gap seq 6 -> converges seq 1..5, 7, 8 (7 items)
    await showcase.getByRole("button", { name: "Simulate dropped/reordered gap" }).click();
    await expect(showcase.getByTestId("reconnect-fixture-status")).toContainText(
      "Watermark seq: 8",
    );
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(7);
    await expect(feed.getByTestId("received-plaintext-msg_p208_seq_7")).toContainText(
      "Recovered missed seq 7 across permanent gap 6",
    );
    await expect(feed.getByTestId("received-plaintext-msg_p208_seq_8")).toContainText(
      "Out-of-order seq 8 triggers gap catch-up",
    );

    // Zero decrypted message plaintext persisted in localStorage/sessionStorage (DATA-013)
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.local).not.toContain("__p208XssFired");
    expect(storageDump.local).not.toContain("Out-of-order seq 8");
    expect(storageDump.session).not.toContain("__p208XssFired");
    expect(storageDump.session).not.toContain("Out-of-order seq 8");

    // 3. Expired/revoked session -> reauth_required blocks protected actions & shows /sign-in link
    await showcase.getByRole("button", { name: "Simulate expired/revoked session" }).click();
    await expect(banner).toHaveAttribute("data-connection-status", "reauth_required");
    await expect(banner).toHaveAttribute("data-protected-blocked", "true");
    await expect(banner).toContainText("Your session expired or was revoked");
    await expect(banner.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/sign-in",
    );
    await expect(showcase.getByTestId("reconnect-fixture-status")).toContainText(
      "Protected blocked: true",
    );

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali reconnect & expired-session banners cleanly at 320px without horizontal overflow", async ({
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
    const showcase = page.getByTestId("reconnect-fixture-showcase");
    await expect(showcase).toContainText(
      "পুনঃসংযোগ ক্যাচ-আপ ও মেয়াদোত্তীর্ণ সেশন সিঙ্ক (P2-08 প্রিভিউ)",
    );

    await showcase.getByRole("button", { name: "বিচ্ছিন্নতা ও সাবস্ক্রাইব রেস চালান" }).click();
    const banner = showcase.getByTestId("realtime-sync-banner");
    await expect(banner).toHaveAttribute("data-connection-status", "connected");
    await expect(banner).toContainText("লাইভ সিঙ্ক সক্রিয়");

    await showcase.getByRole("button", { name: "মেয়াদোত্তীর্ণ/বাতিল সেশন চালান" }).click();
    await expect(banner).toHaveAttribute("data-connection-status", "reauth_required");
    await expect(banner).toContainText("আপনার সেশনের মেয়াদ শেষ হয়েছে বা বাতিল হয়েছে");
    await expect(banner.getByRole("link", { name: "আবার সাইন ইন করুন" })).toHaveAttribute(
      "href",
      "/sign-in",
    );

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(consoleErrors).toEqual([]);
  });
});
