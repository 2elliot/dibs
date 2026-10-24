import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.DIBS_LIVE ? [] : ["**/live-*.test.ts"]),
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
