import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pack } from "../src/oracle-crypto.ts";
import { benchDir } from "../src/paths.ts";
import { assembledTreePath, verifyLobby } from "../src/verify.ts";
import {
  FakeReviewRunner,
  reviewLobby,
  type ReviewRunner,
} from "../src/review.ts";
import { validate } from "../src/schema.ts";
import { REVIEW_SCHEMA } from "@dibs/protocol";
import {
  hasPlaintextOracle,
  makeLobbiesRepo,
  tempDir,
  testUi,
} from "./helpers.ts";

// Needs the plaintext oracle (M3 only). Elsewhere these tests are skipped.
describe.skipIf(!hasPlaintextOracle)(
  "dibs verify on a local lobbies repo",
  () => {
    const key = randomBytes(32);
    let scratch: string;
    let oracleEnc: string;
    let oracleHash: string;
    let repo: string;
    let base: string;

    beforeAll(() => {
      scratch = tempDir("verify");
      oracleEnc = join(scratch, "oracle.enc");
      oracleHash = pack(join(benchDir, "oracle"), oracleEnc, key);
      ({ repo, base } = makeLobbiesRepo({
        1: {
          reference: { claude: "cookie", codex: "cookie", droid: "cookie" },
          // Claude also touches the UI and a frozen file: both must be ignored and counted.
          extra: {
            claude: {
              "public/app.js":
                "throw new Error('claude should not be here');\n",
              "src/server.js": "process.exit(1);\n",
            },
          },
        },
        2: {
          reference: { claude: "bearer", codex: "bearer", droid: "bearer" },
        },
        3: {
          reference: {
            claude: "mismatch",
            codex: "mismatch",
            droid: "mismatch",
          },
        },
      }));
    });

    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    const run = (lobbyId: number, baseSha?: string) =>
      verifyLobby({
        lobbyId,
        remote: repo,
        baseSha,
        oracleEnc,
        expectHash: oracleHash,
        key,
        work: join(scratch, "work"),
        results: join(scratch, "results", String(lobbyId)),
        log: () => {},
      });

    const expectChecks = (
      checks: { check: number; ok: boolean }[],
      expected: boolean[],
    ) => {
      const ok = [1, 2, 3, 4, 5, 6].map(
        (n) => checks.find((c) => c.check === n)?.ok ?? false,
      );
      expect(ok.slice(0, 5)).toEqual(expected.slice(0, 5));
      if (testUi) expect(ok[5]).toBe(expected[5]);
    };

    it("assembles the cookie lobby by area, ignores out-of-area files, and passes", async () => {
      const { report, reportPath } = await run(1, base);
      expect(report.baseSha).toBe(base);
      expect(Object.keys(report.assembledFrom).sort()).toEqual([
        "claude",
        "codex",
        "droid",
      ]);
      expect(report.outOfArea.claude?.sort()).toEqual([
        "public/app.js",
        "src/server.js",
      ]);
      expect(report.outOfArea.codex).toEqual([]);
      expect(report.applied.codex).toEqual(["public/app.js"]);
      expectChecks(report.checks, [true, true, true, true, true, true]);
      expect(report.oracleHash).toBe(oracleHash);
      // Claude and Codex both changed public/app.js, so a real merge would conflict.
      expect(report.mergeTreeClean).toBe(false);
      expect(existsSync(reportPath)).toBe(true);
      const row = JSON.parse(
        readFileSync(
          join(scratch, "results", "1", "verification.json"),
          "utf8",
        ),
      );
      expect(row.lobbyId).toBe(1);
      expect(JSON.parse(row.assembledFrom)).toEqual(report.assembledFrom);
      expect(row.reportHash).toMatch(/^[0-9a-f]{64}$/);
      // The assembled tree stays for review; the plaintext oracle doesn't.
      expect(
        existsSync(
          join(
            assembledTreePath(join(scratch, "work"), 1),
            "src/auth/routes.js",
          ),
        ),
      ).toBe(true);
      expect(
        readdirSync(join(benchDir, ".work")).filter((n) =>
          n.startsWith("oracle-"),
        ),
      ).toEqual([]);
    });

    it("passes the bearer lobby, with the base found from the heads", async () => {
      const { report } = await run(2);
      expect(report.baseSha).toBe(base);
      expect(report.mergeTreeClean).toBe(true);
      expectChecks(report.checks, [true, true, true, true, true, true]);
    });

    it("fails the mismatched lobby on the UI check only", async () => {
      const { report } = await run(3);
      expectChecks(report.checks, [true, true, true, true, true, false]);
      expect(report.passed).toBeLessThan(6);
    });

    const review = (
      lobbyId: number,
      runner: ReviewRunner = new FakeReviewRunner(),
    ) =>
      reviewLobby({
        lobbyId,
        runner,
        work: join(scratch, "work"),
        results: join(scratch, "results", String(lobbyId)),
      });

    it("reviews the mismatched lobby with the fake SDK: valid findings, root cause in the UI", async () => {
      const { findings, reviewPath } = await review(3);
      expect(validate(REVIEW_SCHEMA, findings)).toEqual([]);
      expect(findings.clauses.map((c) => c.key)).toEqual([
        "auth.session",
        "auth.server",
        "events.registration",
      ]);
      expect(
        findings.clauses.find((c) => c.key === "auth.session")?.verdict,
      ).toBe("violates");
      if (testUi)
        expect(findings.rootCause).toMatchObject({
          key: "auth.session",
          violator: "codex",
        });
      const saved = JSON.parse(readFileSync(reviewPath, "utf8"));
      expect(saved.kind).toBe("diagnosis");
      const row = JSON.parse(
        readFileSync(join(scratch, "results", "3", "review-row.json"), "utf8"),
      );
      expect(JSON.parse(row.findingsJson)).toEqual(findings);
    });

    it("gives the runner a read-only copy with no agent config, and rejects invalid output", async () => {
      let seen = "";
      const bad: ReviewRunner = {
        name: "bad",
        async run(input) {
          seen = input.cwd;
          expect(existsSync(join(input.cwd, "src/auth/routes.js"))).toBe(true);
          expect(existsSync(join(input.cwd, "node_modules"))).toBe(false);
          expect(existsSync(join(input.cwd, ".git"))).toBe(false);
          expect(input.prompt).toContain("auth.session");
          return {
            findings: { summary: "x", clauses: [{ key: "auth.session" }] },
            model: "m",
            sessionId: "s",
          };
        },
      };
      await expect(review(2, bad)).rejects.toThrow(/REVIEW_SCHEMA/);
      expect(existsSync(seen)).toBe(false);
    });

    it("refuses an oracle with the wrong hash", async () => {
      await expect(
        verifyLobby({
          lobbyId: 2,
          remote: repo,
          oracleEnc,
          expectHash: "0".repeat(64),
          key,
          work: join(scratch, "work"),
          results: join(scratch, "results", "x"),
          log: () => {},
        }),
      ).rejects.toThrow(/isn't the expected/);
    });
  },
);
