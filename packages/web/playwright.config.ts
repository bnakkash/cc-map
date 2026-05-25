import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests assume the cc-map server is running on http://127.0.0.1:5174
 * (the default for `npm run dev`). To run:
 *
 *   1. npm install                         # install @playwright/test
 *   2. npx playwright install chromium     # one-time browser download (~150MB)
 *   3. In one shell: npm run dev           # starts the server + Vite
 *   4. In another:    npm run e2e --workspace=packages/web
 *
 * BASE_URL env var lets you point at a different host if your server runs elsewhere.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:5174",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 5000,
    navigationTimeout: 10000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
