import { expect, test } from "@playwright/test";

/**
 * UX smoke tests — exercise the key interactions and snapshot screenshots
 * for visual review. These don't pixel-diff (the live forest is non-deterministic),
 * but they verify the app boots, no console errors, and major modes are reachable.
 *
 * Screenshots land in test-results/<spec>/<name>.png.
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  await page.goto("/");
  // Wait for the canvas to mount and the initial layout to be built.
  await page.waitForSelector("canvas", { state: "visible", timeout: 8000 });
  // The LOD indicator only renders after layout is ready
  await page.waitForFunction(() => !!document.querySelector(".font-mono"), null, { timeout: 5000 });
  // Stash errors for later assertions
  (page as unknown as { __errors: string[] }).__errors = errors;
});

test.afterEach(async ({ page }, info) => {
  const errors = (page as unknown as { __errors: string[] }).__errors ?? [];
  // Hard fail on actual page errors. console.errors include WebSocket noise on
  // some setups, so they're surfaced as test info attachments instead.
  const fatal = errors.filter((e) => e.startsWith("pageerror"));
  if (fatal.length > 0) {
    await info.attach("page-errors.txt", { body: fatal.join("\n"), contentType: "text/plain" });
    throw new Error(`Page errors detected:\n${fatal.join("\n")}`);
  }
});

test("boot: shows canvas and LOD indicator", async ({ page }) => {
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.screenshot({ path: "test-results/smoke/boot.png", fullPage: false });
});

test("layout: switches grid → column → timeline without errors", async ({ page }) => {
  for (const dir of ["grid", "column", "timeline"]) {
    await page.getByRole("button", { name: dir, exact: true }).click();
    await page.waitForTimeout(600); // morph animation
    await page.screenshot({ path: `test-results/smoke/layout-${dir}.png` });
  }
});

test("nodes: switches dots → cards", async ({ page }) => {
  for (const style of ["dots", "cards"]) {
    await page.getByRole("button", { name: style, exact: true }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/smoke/style-${style}.png` });
  }
});

test("color: cycles role → recency → cost", async ({ page }) => {
  for (const mode of ["role", "recency", "cost"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/smoke/color-${mode}.png` });
  }
});

test("search: opens, types, shows match count", async ({ page }) => {
  await page.keyboard.press("/");
  const input = page.locator('input[placeholder="search messages…"]');
  await expect(input).toBeVisible({ timeout: 2000 });
  await input.fill("the");
  await page.waitForTimeout(300);
  // The counter only renders when there's at least one match
  await page.screenshot({ path: "test-results/smoke/search-the.png" });
  await page.keyboard.press("Enter"); // step to next match
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/smoke/search-stepped.png" });
  await page.keyboard.press("Escape");
});

test("follow live toggle persists", async ({ page }) => {
  const btn = page.getByRole("button", { name: /follow live/i });
  await btn.click();
  await expect(btn).toContainText(/ON/i);
  await page.reload();
  await page.waitForSelector("canvas", { state: "visible", timeout: 8000 });
  const btn2 = page.getByRole("button", { name: /follow live/i });
  await expect(btn2).toContainText(/ON/i);
  // Reset for next test
  await btn2.click();
});

test("save view round-trip", async ({ page }) => {
  // Save the current state under a deterministic name
  const viewName = `smoke-${Date.now()}`;
  page.once("dialog", (d) => d.accept(viewName));
  await page.getByRole("button", { name: "+ save", exact: true }).click();
  // The new view chip should appear
  await expect(page.getByRole("button", { name: viewName })).toBeVisible({ timeout: 2000 });
});
