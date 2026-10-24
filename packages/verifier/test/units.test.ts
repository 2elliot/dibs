import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inArea, inProviderArea, loadManifest } from "../src/manifest.ts";
import { pack, unpack } from "../src/oracle-crypto.ts";
import { parseTap } from "../src/oracle-runner.ts";
import { fixtureDir } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

describe("areas", () => {
  const manifest = loadManifest(fixtureDir);

  it("matches the plan's areas", () => {
    expect(inProviderArea(manifest, "claude", "src/auth/routes.js")).toBe(true);
    expect(inProviderArea(manifest, "claude", "test/auth/a/b.test.js")).toBe(
      true,
    );
    expect(inProviderArea(manifest, "claude", "src/events/routes.js")).toBe(
      false,
    );
    expect(inProviderArea(manifest, "codex", "public/app.js")).toBe(true);
    expect(inProviderArea(manifest, "codex", "public/css/x.css")).toBe(true);
    expect(inProviderArea(manifest, "codex", "public/index.html")).toBe(false);
    expect(inProviderArea(manifest, "droid", "src/events/routes.js")).toBe(
      true,
    );
    expect(inProviderArea(manifest, "droid", "src/data.js")).toBe(false);
    expect(inProviderArea(manifest, "droid", "package.json")).toBe(false);
  });

  it("handles ** and * like git globs", () => {
    expect(inArea("a/b/c.js", ["a/**"])).toBe(true);
    expect(inArea("a.js", ["*.js"])).toBe(true);
    expect(inArea("x/a.js", ["*.js"])).toBe(false);
    expect(inArea("x/a.js", ["**/*.js"])).toBe(true);
    expect(inArea("src\\auth\\x.js", ["src/auth/**"])).toBe(true);
  });

  it("lists the three shared keys and the frozen files", () => {
    expect(manifest.vocabulary.map((v) => v.key)).toEqual([
      "auth.session",
      "auth.server",
      "events.registration",
    ]);
    expect(manifest.frozen.sort()).toEqual([
      "public/index.html",
      "src/data.js",
      "src/server.js",
    ]);
  });
});

describe("oracle encryption", () => {
  const make = () => {
    const dir = tempDir("crypto");
    mkdirSync(join(dir, "plain", "references", "x"), { recursive: true });
    writeFileSync(
      join(dir, "plain", "oracle.test.mjs"),
      "// secret check alice-pass\n",
    );
    writeFileSync(
      join(dir, "plain", "references", "x", "a.js"),
      "export {};\n",
    );
    return dir;
  };

  it("round-trips and checks the hash", () => {
    const dir = make();
    const key = randomBytes(32);
    const hash = pack(join(dir, "plain"), join(dir, "oracle.enc"), key);
    expect(readFileSync(join(dir, "oracle.hash"), "utf8").trim()).toBe(hash);
    expect(readFileSync(join(dir, "oracle.enc"), "utf8")).not.toContain(
      "alice-pass",
    );
    expect(unpack(join(dir, "oracle.enc"), join(dir, "out"), key, hash)).toBe(
      hash,
    );
    expect(readFileSync(join(dir, "out", "oracle.test.mjs"), "utf8")).toContain(
      "alice-pass",
    );
    expect(
      readFileSync(join(dir, "out", "references", "x", "a.js"), "utf8"),
    ).toBe("export {};\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a wrong key, a tampered file and an unexpected hash", () => {
    const dir = make();
    const key = randomBytes(32);
    pack(join(dir, "plain"), join(dir, "oracle.enc"), key);
    expect(() =>
      unpack(join(dir, "oracle.enc"), join(dir, "o1"), randomBytes(32)),
    ).toThrow(/wrong key/);
    expect(() =>
      unpack(join(dir, "oracle.enc"), join(dir, "o2"), key, "f".repeat(64)),
    ).toThrow(/expected/);
    const sealed = JSON.parse(readFileSync(join(dir, "oracle.enc"), "utf8"));
    const data = Buffer.from(sealed.data, "base64");
    data[0]! ^= 1;
    sealed.data = data.toString("base64");
    writeFileSync(join(dir, "oracle.enc"), JSON.stringify(sealed));
    expect(() => unpack(join(dir, "oracle.enc"), join(dir, "o3"), key)).toThrow(
      /wrong key|changed/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("TAP parsing", () => {
  it("reads checks and their messages", () => {
    const tap = [
      "ok 1 - 1. a valid login",
      "not ok 2 - 2. a bad password returns 401",
      "  ---",
      "  error: |-",
      "    expected 401, got 501",
      "  ...",
    ].join("\n");
    expect(parseTap(tap)).toEqual([
      { check: 1, name: "a valid login", ok: true },
      {
        check: 2,
        name: "a bad password returns 401",
        ok: false,
        message: "expected 401, got 501",
      },
    ]);
  });
});
