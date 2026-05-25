import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to source as *.test.ts. The tests/ folder holds
    // Playwright e2e specs which require a running server and use the
    // @playwright/test runner — exclude them from vitest.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "tests"],
  },
});
