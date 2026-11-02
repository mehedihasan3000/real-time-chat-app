import { expect, test } from "@playwright/test";

test.describe("locale and theme preferences", () => {
  test.use({ colorScheme: "light" });

  test("locale switch changes the interface and survives reload", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("body")).toContainText("Settings");

    await page.locator('input[name="interface-language"][value="bn"]').check({ force: true });

    await expect(page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(page.locator("body")).toContainText("সেটিংস");
    expect(await page.evaluate(() => localStorage.getItem("chat-ui-locale"))).toBe("bn");

    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(page.locator('input[name="interface-language"][value="bn"]')).toBeChecked();
    await expect(page.locator("body")).toContainText("সেটিংস");

    await page.locator('input[name="interface-language"][value="en"]').check({ force: true });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await page.evaluate(() => localStorage.getItem("chat-ui-locale"))).toBe("en");
  });

  test("theme switch changes the resolved theme and survives reload", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.locator('input[name="theme-preference"][value="dark"]').check({ force: true });

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("chat-ui-theme"))).toBe("dark");

    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('input[name="theme-preference"][value="dark"]')).toBeChecked();

    await page.locator('input[name="theme-preference"][value="system"]').check({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("chat-ui-theme"))).toBe("system");
  });

  test("locale and theme preferences stay independent", async ({ page }) => {
    await page.goto("/settings");

    await page.locator('input[name="interface-language"][value="bn"]').check({ force: true });
    await page.locator('input[name="theme-preference"][value="dark"]').check({ force: true });

    const stored = await page.evaluate(() => ({
      locale: localStorage.getItem("chat-ui-locale"),
      theme: localStorage.getItem("chat-ui-theme"),
    }));

    expect(stored).toEqual({ locale: "bn", theme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});
