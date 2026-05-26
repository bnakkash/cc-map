import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

function token(): string {
  if (process.env.CC_MAP_TOKEN) return process.env.CC_MAP_TOKEN;
  const tokenPath = join(homedir(), ".cc-map", "token");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  return "";
}

function appUrl(path = "/"): string {
  const t = token();
  return t ? `${path}?token=${encodeURIComponent(t)}` : path;
}

async function openMap(page: Page) {
  await page.getByRole("tab", { name: "map", exact: true }).click();
  await page.waitForSelector("canvas", { state: "visible", timeout: 10000 });
  await expect(page.getByText("Display", { exact: true })).toBeVisible();
}

function layoutButton(page: Page, name: "grid" | "column" | "timeline") {
  const titles = {
    grid: "trees wrap into rows (square-ish)",
    column: "sessions line up horizontally; prompts vertical, replies horizontal",
    timeline: "one column per session; Y is real time — reveals burst sessions and idle gaps",
  };
  return page.locator(`button[title="${titles[name]}"]`);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem("cc-map-seen-welcome", "1");
  });
  await page.goto(appUrl("/"));
  await expect(page.getByRole("tab", { name: "map", exact: true })).toBeVisible({ timeout: 10000 });
  (page as unknown as { __errors: string[] }).__errors = errors;
});

test.afterEach(async ({ page }, info) => {
  const errors = (page as unknown as { __errors: string[] }).__errors ?? [];
  const fatal = errors.filter((e) => e.startsWith("pageerror"));
  if (fatal.length > 0) {
    await info.attach("page-errors.txt", { body: fatal.join("\n"), contentType: "text/plain" });
    throw new Error(`Page errors detected:\n${fatal.join("\n")}`);
  }
});

test("boot: opens the map with canvas and overview chrome", async ({ page }) => {
  await openMap(page);
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.screenshot({ path: "test-results/smoke/boot-map.png", fullPage: false });
});

test("viewer: has searchable session picker and auto-opens a message", async ({ page }) => {
  await page.getByRole("tab", { name: "viewer", exact: true }).click();
  await expect(page.getByRole("button", { name: /.+ · .+/ })).toBeVisible({ timeout: 10000 });
  await expect(page.locator("[data-chip-id]").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("No message selected.")).toHaveCount(0);
  await page.screenshot({ path: "test-results/smoke/viewer.png", fullPage: false });
});

test("layout: switches grid to column to timeline without errors", async ({ page }) => {
  await openMap(page);
  for (const dir of ["grid", "column", "timeline"]) {
    await layoutButton(page, dir as "grid" | "column" | "timeline").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/smoke/layout-${dir}.png` });
  }
});

test("nodes and color controls remain reachable", async ({ page }) => {
  await openMap(page);
  for (const style of ["dots", "cards"] as const) {
    const title = style === "dots" ? "small dots" : "text cards";
    await page.locator(`button[title^="${title}"]`).click();
    await page.waitForTimeout(400);
  }
  for (const mode of ["role", "recency", "cost"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(250);
  }
});

test("search: opens, types, and steps through matches", async ({ page }) => {
  await openMap(page);
  await page.keyboard.press("/");
  const input = page.locator('input[placeholder="search messages…"]');
  await expect(input).toBeVisible({ timeout: 2000 });
  await input.fill("the");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/smoke/search-the.png" });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
});

test("calendar: exposes button cells and selected-day summary", async ({ page }) => {
  await page.getByRole("tab", { name: "calendar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("grid", { name: "Prompt activity by day" })).toBeVisible();
  await expect(page.getByText("Selected day", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/smoke/calendar.png", fullPage: false });
});

test("follow live toggle persists", async ({ page }) => {
  await openMap(page);
  if ((await page.getByRole("button", { name: /follow live/i }).count()) === 0) {
    await page.locator("button").filter({ hasText: "Live" }).first().click();
  }
  const btn = page.getByRole("button", { name: /follow live/i });
  await btn.click();
  await expect(btn).toContainText(/ON/i);
  await page.reload();
  await openMap(page);
  if ((await page.getByRole("button", { name: /follow live/i }).count()) === 0) {
    await page.locator("button").filter({ hasText: "Live" }).first().click();
  }
  const btn2 = page.getByRole("button", { name: /follow live/i });
  await expect(btn2).toContainText(/ON/i);
  await btn2.click();
});

test("save view round-trip uses in-app dialog", async ({ page }) => {
  await openMap(page);
  const savedGroup = page.getByRole("button", { name: /Saved/ });
  if ((await page.getByRole("button", { name: "+ save", exact: true }).count()) === 0) {
    await savedGroup.click();
  }
  const viewName = `smoke-${Date.now()}`;
  await page.getByRole("button", { name: "+ save", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await expect(dialog).toBeVisible();
  await dialog.locator("input").fill(viewName);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(viewName, { exact: true })).toBeVisible({ timeout: 2000 });
});
