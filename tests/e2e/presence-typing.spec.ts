import { expect, test } from "@playwright/test";

test.describe("P2-12 presence & typing UI fixture (TC-PRES-001, TC-PRES-002)", () => {
  test("verifies multi-tab aggregation, 60s lease timeout, backend restart unknown state, 2s typing coalescing, 5s expiry, disconnect/reconnect clear, activity sharing, and block override", async ({
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

    await page.goto("/states", { waitUntil: "domcontentloaded" });
    const showcase = page.getByTestId("presence-typing-fixture");
    await expect(showcase).toBeVisible();

    const peerStatus = showcase.getByTestId("presence-peer-status");
    const typingIndicator = showcase.getByTestId("presence-typing-indicator");
    const summary = showcase.getByTestId("presence-typing-summary");

    // 1. Initial state: unknown, not typing, activity sharing On by default, unblocked.
    await expect(peerStatus).toHaveAttribute("data-status", "unknown");
    await expect(peerStatus).toHaveAttribute("data-typing", "false");
    await expect(summary).toContainText("Activity sharing: On (default)");

    // 2. Multi-tab aggregation (FR-PRES-002): Tab 1 + Tab 2 -> online; closing Tab 1 keeps online; closing Tab 2 -> offline.
    await showcase.getByRole("button", { name: "Connect Tab 1" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "online");
    await expect(peerStatus).toContainText("Active tabs: 1");

    await showcase.getByRole("button", { name: "Connect Tab 2" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "online");
    await expect(peerStatus).toContainText("Active tabs: 2");

    await showcase.getByRole("button", { name: "Close Tab 1" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "online");
    await expect(peerStatus).toContainText("Active tabs: 1");

    await showcase.getByRole("button", { name: "Close Tab 2" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "offline");
    await expect(peerStatus).toContainText("Active tabs: 0");

    // 3. Reconnect and advance past 60s lease -> offline; backend restart -> unknown (FR-PRES-001).
    await showcase.getByRole("button", { name: "Connect Tab 1" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "online");
    await showcase.getByRole("button", { name: "Advance +61s lease timeout" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "offline");

    await showcase.getByRole("button", { name: "Simulate backend restart" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "unknown");

    // 4. Typing start, 2s coalescing burst, explicit stop, 5s expiry, and disconnect/reconnect clear (FR-PRES-003, TC-PRES-002).
    await showcase.getByRole("button", { name: "Peer typing signal (2s coalesce)" }).click();
    await expect(peerStatus).toHaveAttribute("data-typing", "true");
    await expect(typingIndicator).toContainText("Bob is typing");
    await expect(summary).toContainText("Emitted typing signals: 1");
    await expect(summary).toContainText("Coalesced within 2s: 0");

    await showcase.getByRole("button", { name: "Peer typing signal (2s coalesce)" }).click();
    await expect(summary).toContainText("Emitted typing signals: 1");
    await expect(summary).toContainText("Coalesced within 2s: 1");

    await showcase.getByRole("button", { name: "Peer explicit stop" }).click();
    await expect(peerStatus).toHaveAttribute("data-typing", "false");
    await expect(typingIndicator).toContainText("Not typing");

    // Advance past 5s window -> start again cleanly, then expire at +5s.
    await showcase.getByRole("button", { name: "Advance +5s typing expiry" }).click();
    await showcase.getByRole("button", { name: "Peer typing signal (2s coalesce)" }).click();
    await expect(peerStatus).toHaveAttribute("data-typing", "true");
    await showcase.getByRole("button", { name: "Advance +5s typing expiry" }).click();
    await expect(peerStatus).toHaveAttribute("data-typing", "false");

    // Reconnect clears stale typing without replay.
    await showcase.getByRole("button", { name: "Peer typing signal (2s coalesce)" }).click();
    await expect(peerStatus).toHaveAttribute("data-typing", "true");
    await showcase.getByRole("button", { name: "Disconnect & reconnect" }).click();
    await expect(peerStatus).toHaveAttribute("data-typing", "false");
    await expect(peerStatus).toHaveAttribute("data-status", "online");

    // 5. Activity sharing off masks presence & typing; turning back on reveals online; bilateral block overrides activity sharing (FR-PRES-004, DEC-008).
    await showcase.getByRole("button", { name: "Peer typing signal (2s coalesce)" }).click();
    await showcase.getByRole("button", { name: "Toggle activity sharing" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "unknown");
    await expect(peerStatus).toHaveAttribute("data-typing", "false");
    await expect(summary).toContainText("Activity sharing: Off");

    await showcase.getByRole("button", { name: "Toggle activity sharing" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "online");
    await expect(summary).toContainText("Activity sharing: On (default)");

    await showcase.getByRole("button", { name: "Toggle bilateral block" }).click();
    await expect(peerStatus).toHaveAttribute("data-status", "unknown");
    await expect(peerStatus).toHaveAttribute("data-typing", "false");
    await expect(summary).toContainText("Block: Blocked");

    // Verify no lastSeen or presence history leaked into DOM or Web Storage.
    const bodyText = await showcase.innerText();
    expect(bodyText.toLowerCase()).not.toContain("lastseen");
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.local.toLowerCase()).not.toContain("lastseen");
    expect(storageDump.session.toLowerCase()).not.toContain("lastseen");

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali P2-12 presence & typing fixture at 320px without horizontal overflow", async ({
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

    await page.goto("/states", { waitUntil: "domcontentloaded" });
    const showcase = page.getByTestId("presence-typing-fixture");
    await expect(showcase).toBeVisible();
    await expect(showcase).toContainText("উপস্থিতি ও টাইপিং সূচক (পি২-১২)");

    await showcase.getByRole("button", { name: "ট্যাব ১ সংযুক্ত করুন" }).click();
    await expect(showcase.getByTestId("presence-peer-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    await expect(showcase.getByTestId("presence-peer-status")).toContainText("অনলাইন");

    await showcase.getByRole("button", { name: "টাইপিং সংকেত (২ সেকেন্ড সীমা)" }).click();
    await expect(showcase.getByTestId("presence-typing-indicator")).toContainText("বব টাইপ করছে");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    expect(consoleErrors).toEqual([]);
  });
});
