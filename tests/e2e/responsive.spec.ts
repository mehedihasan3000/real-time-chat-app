import { expect, test } from "@playwright/test";

const reflowRoutes = [
  "/",
  "/conversations",
  "/conversations/sample-conversation",
  "/calls/sample-call",
  "/search",
  "/profile/nusrat_j",
  "/settings",
  "/states",
  "/onboarding/profile",
  "/sign-up",
] as const;

for (const route of reflowRoutes) {
  test(`${route} does not overflow horizontally at the 320 px baseline`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main#main-content")).toBeVisible();

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });
}

test("the 320 px baseline keeps the mobile primary navigation reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/conversations");

  const nav = page.getByRole("navigation", { name: /primary/i });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(4);
});
