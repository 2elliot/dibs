import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The oracle starts real servers on 4140–4149 and the verify test builds git repos, so the
// test files run one at a time. DIBS_HOME is a temp dir: tests never touch the real ~/.dibs.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    env: { DIBS_HOME: mkdtempSync(join(tmpdir(), "dibs-i4-home-")) },
  },
});
