import { expect, test } from "@playwright/test";

test.describe("P2-06 receive/decrypt/render fixtures (TC-CHAT-008, FR-CHAT-013, FR-CHAT-014, NFR-REC-002)", () => {
  test("decrypts Bengali, emoji, and script-like messages via vodozemac WASM in Chromium inertly with zero XSS and zero localStorage plaintext", async ({
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
    const showcase = page.getByTestId("receive-decrypt-showcase");
    await expect(showcase).toBeVisible();

    // 1. Real vodozemac WASM encrypt -> decrypt -> inert render of Bengali, emoji, and hostile script text
    await showcase.getByRole("button", { name: "Receive Bengali, emoji & script text" }).click();
    const feed = showcase.getByTestId("receive-message-feed");
    await expect(feed.locator('[data-message-kind="decrypted"]')).toHaveCount(2);

    const bnPlaintext = feed.getByTestId("received-plaintext-msg_p206_seq_1");
    await expect(bnPlaintext).toHaveText("আমি বাংলায় কথা বলি — ক্ষ, জ্ঞ, য়, র‍্যাপিড এবং 🇧🇩👨‍👩‍👧‍👦💬🔐");

    const scriptPlaintext = feed.getByTestId("received-plaintext-msg_p206_seq_2");
    await expect(scriptPlaintext).toHaveText(
      `<script>window.__p206XssFired = true;</script><img src=x onerror="window.__p206XssFired = true" /> javascript:alert(1)`,
    );

    // Assert zero DOM script/img execution or injected elements inside the message feed (FR-SEC-013)
    expect(await feed.locator("script, img").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__p206XssFired),
    ).toBeUndefined();

    // Assert zero message plaintext persisted in localStorage or sessionStorage (DATA-013)
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.local).not.toContain("বাংলা");
    expect(storageDump.local).not.toContain("__p206XssFired");
    expect(storageDump.session).not.toContain("বাংলা");
    expect(storageDump.session).not.toContain("__p206XssFired");

    // 2. Tampered ciphertext, missing-key, and unsupported-version placeholders (FR-CHAT-014, NFR-REC-002)
    await showcase.getByRole("button", { name: "Receive tampered ciphertext" }).click();
    const tamperedItem = feed.locator('[data-failure-state="tampered-envelope"]');
    await expect(tamperedItem).toHaveCount(1);
    await expect(tamperedItem).toHaveAttribute("data-receipt-eligible", "false");
    await expect(tamperedItem).toContainText("Message integrity check failed");

    await showcase
      .getByRole("button", { name: "Receive missing-key & unsupported version" })
      .click();
    const missingKeyItem = feed.locator('[data-failure-state="missing-key"]');
    await expect(missingKeyItem).toHaveCount(1);
    await expect(missingKeyItem).toHaveAttribute("data-receipt-eligible", "false");
    await expect(missingKeyItem).toContainText("Unable to decrypt this message on this device");

    const unsupportedItem = feed.locator('[data-failure-state="unsupported-version"]');
    await expect(unsupportedItem).toHaveCount(1);
    await expect(unsupportedItem).toHaveAttribute("data-receipt-eligible", "false");
    await expect(unsupportedItem).toContainText("Unsupported message encryption version");

    // 3. Reset clears in-memory decrypted messages
    await showcase.getByRole("button", { name: "Clear received fixtures" }).click();
    await expect(showcase.getByTestId("receive-feed-empty")).toBeVisible();

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders localized Bengali and English receive/decrypt placeholders without horizontal overflow at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addInitScript(() => {
      window.localStorage.setItem("chat-ui-locale", "bn");
    });

    await page.goto("/states", { waitUntil: "networkidle" });
    const showcase = page.getByTestId("receive-decrypt-showcase");
    await expect(showcase).toContainText("গ্রহণ, ডিক্রিপশন ও নিরাপদ প্রদর্শন (P2-06 প্রিভিউ)");

    await showcase
      .getByRole("button", { name: "বাংলা, ইমোজি ও স্ক্রিপ্ট টেক্সট গ্রহণ করুন" })
      .click();
    await showcase.getByRole("button", { name: "পরিবর্তিত সাইফারটেক্সট গ্রহণ করুন" }).click();
    await showcase.getByRole("button", { name: "কী-বিহীন ও অসমর্থিত সংস্করণ গ্রহণ করুন" }).click();

    await expect(showcase).toContainText("বার্তার অখণ্ডতা যাচাই ব্যর্থ হয়েছে");
    await expect(showcase).toContainText("এই ডিভাইসে বার্তাটি ডিক্রিপ্ট করা যায়নি");
    await expect(showcase).toContainText("বার্তার এনক্রিপশন সংস্করণ সমর্থিত নয়");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
