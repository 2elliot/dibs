import { defineConfig } from "vitest/config";

// The oracle starts real servers on 4140–4149 and the verify test builds git repos, so the
// test files run one at a time.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
