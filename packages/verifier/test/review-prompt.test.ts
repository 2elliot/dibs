import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/manifest.ts";
import { fixtureDir } from "../src/paths.ts";
import { reviewPrompt, scaffoldSection } from "../src/review.ts";
import type { VerifyReport } from "../src/verify.ts";

const manifest = loadManifest(fixtureDir);
const report = {
  passed: 6,
  total: 6,
  checks: [1, 2, 3, 4, 5, 6].map((check) => ({
    check,
    name: `check ${check}`,
    ok: true,
  })),
} as unknown as VerifyReport;
const clauses = [
  {
    key: "auth.session",
    text: "Bearer token only. No cookies are set or read.",
    source: "agreed" as const,
  },
];

describe("review prompt", () => {
  it("names the frozen scaffold and says it can't be an agent's violation (lobby 4)", () => {
    const prompt = reviewPrompt(clauses, report, "", manifest);
    for (const file of ["src/server.js", "src/data.js", "public/index.html"])
      expect(prompt).toContain(`- ${file}`);
    expect(prompt).toMatch(/never a violation by any agent/);
    expect(prompt).toMatch(/never name it as the rootCause/);
    // Areas come from the manifest, not a hard-coded list.
    expect(prompt).toContain(
      "codex: public/**, !public/index.html, test/ui/**",
    );
  });

  it("keeps working without a manifest", () => {
    const prompt = reviewPrompt(clauses, report, "");
    expect(prompt).toContain("claude: src/auth/**");
    expect(prompt).not.toContain("Frozen scaffold files");
    expect(scaffoldSection([])).toBe("");
  });
});
