import { expect, test } from "@playwright/test";

test("keeps the honest not-connected disclosure and makes no external requests", async ({
  page,
}, testInfo) => {
  const baseOrigin = new URL(testInfo.project.use.baseURL as string).origin;
  const externalRequests: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());

    if (url.protocol !== "data:" && url.protocol !== "blob:" && url.origin !== baseOrigin) {
      externalRequests.push(request.url());
    }
  });

  await page.goto("/conversations", { waitUntil: "networkidle" });

  await expect(page.locator("body")).toContainText("Not connected");
  expect(externalRequests).toEqual([]);

  const imageSources = await page
    .locator("img")
    .evaluateAll((images) => images.map((image) => image.getAttribute("src") ?? ""));

  for (const source of imageSources) {
    expect(source.startsWith("/") || source.startsWith("data:")).toBe(true);
  }
});

test("does not persist anything beyond the two approved UI preferences", async ({ page }) => {
  await page.goto("/settings");

  const keys = await page.evaluate(() => Object.keys(localStorage).sort());

  expect(keys).toEqual([]);
});
