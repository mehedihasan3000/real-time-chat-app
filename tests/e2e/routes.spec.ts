import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/conversations",
  "/conversations/sample-conversation",
  "/conversations/unknown-conversation",
  "/calls",
  "/calls/sample-call",
  "/calls/sample-call-missed",
  "/calls/unknown-call",
  "/search",
  "/profile",
  "/profile/nusrat_j",
  "/profile/unknown_user",
  "/settings",
  "/states",
  "/ai",
  "/onboarding/profile",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
] as const;

for (const route of routes) {
  test(`renders ${route} with a main landmark and skip link`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    const response = await page.goto(route, { waitUntil: "domcontentloaded" });

    expect(response?.status()).toBe(200);
    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.locator('a[href="#main-content"]')).toHaveCount(1);
    await expect(page.locator("body")).not.toBeEmpty();
    expect(consoleErrors).toEqual([]);
  });
}
