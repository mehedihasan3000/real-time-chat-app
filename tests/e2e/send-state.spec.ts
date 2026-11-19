import { expect, test } from "@playwright/test";

test.describe("P2-05 send-state UI fixtures", () => {
  test("displays truthful queued, unknown, reload, failed/manual-retry, revocation & storage-unavailable states without false sent or external requests", async ({
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
    const showcase = page.getByTestId("send-state-fixture-showcase");
    await expect(showcase).toBeVisible();

    // 1. Offline / queued: shows Queued + Connection interrupted banner, NEVER Sent
    await showcase.getByRole("button", { name: "Offline / queued" }).click();
    await expect(showcase.getByTestId("send-state-item-queued")).toHaveCount(1);
    await expect(showcase).toContainText("Connection interrupted");
    await expect(showcase.getByTestId("send-state-item-sent")).toHaveCount(0);

    await showcase.getByRole("button", { name: "Reset fixtures" }).click();

    // 2. Dropped ack -> Simulate reload -> Reconnect & confirm preserves exact clientMessageId
    await showcase.getByRole("button", { name: "Dropped ack (unknown)" }).click();
    const unknownItem = showcase.getByTestId("send-state-item-unknown");
    await expect(unknownItem).toHaveCount(1);
    const sendId = await unknownItem.getAttribute("data-client-message-id");
    expect(sendId).toBeTruthy();

    await showcase.getByRole("button", { name: "Simulate reload" }).click();
    await expect(showcase.getByTestId("send-state-item-unknown")).toHaveAttribute(
      "data-client-message-id",
      sendId!,
    );

    await showcase.getByRole("button", { name: "Reconnect & confirm" }).click();
    const sentItem = showcase.getByTestId("send-state-item-sent");
    await expect(sentItem).toHaveAttribute("data-client-message-id", sendId!);
    await expect(sentItem).toContainText("Confirmed accepted at sequence 1");

    await showcase.getByRole("button", { name: "Reset fixtures" }).click();

    // 3. Exhaust 10 attempts -> manual retry recovers with same Send ID
    await showcase.getByRole("button", { name: "Exhaust 10 attempts" }).click();
    const exhaustedItem = showcase.getByTestId("send-state-item-failed");
    await expect(exhaustedItem).toContainText("10-attempt or 24-hour limit");
    const exhaustedId = await exhaustedItem.getAttribute("data-client-message-id");
    await exhaustedItem.getByRole("button", { name: "Retry manually" }).click();
    await expect(showcase.getByTestId("send-state-item-sent")).toHaveAttribute(
      "data-client-message-id",
      exhaustedId!,
    );

    await showcase.getByRole("button", { name: "Reset fixtures" }).click();

    // 4. Session revoked, Device revoked, and Storage unavailable states expose recovery guidance
    await showcase.getByRole("button", { name: "Session revoked" }).click();
    await expect(showcase.getByTestId("send-state-item-failed")).toContainText("Session ended");
    await expect(showcase.getByRole("link", { name: "Sign in again" })).toBeVisible();

    await showcase.getByRole("button", { name: "Reset fixtures" }).click();
    await showcase.getByRole("button", { name: "Device revoked" }).click();
    await expect(showcase.getByTestId("send-state-item-failed")).toContainText("Device revoked");
    await expect(showcase.getByRole("link", { name: "Review device setup" })).toBeVisible();

    await showcase.getByRole("button", { name: "Reset fixtures" }).click();
    await showcase.getByRole("button", { name: "Storage unavailable" }).click();
    await expect(showcase).toContainText("Outbox storage: Unavailable");
    await expect(showcase).toContainText("Encrypted local outbox storage is unavailable here");

    // 5. No localStorage persistence or external calls
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali send-state controls cleanly at 320px without horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto("/settings");
    await page.locator('input[name="interface-language"][value="bn"]').check({ force: true });
    await page.goto("/states", { waitUntil: "networkidle" });

    const showcase = page.getByTestId("send-state-fixture-showcase");
    await expect(showcase).toContainText("পাঠানোর অবস্থার রূপান্তর");
    await showcase.getByRole("button", { name: "অফলাইন / সারিতে" }).click();
    await expect(showcase.getByTestId("send-state-item-queued")).toContainText("সারিতে আছে");

    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasOverflow).toBe(false);
  });
});
