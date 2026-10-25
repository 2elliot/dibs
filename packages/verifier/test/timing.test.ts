import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/manifest.ts";
import { fixtureDir } from "../src/paths.ts";
import {
  parseTranscript,
  providerTiming,
  revisionTiming,
  sharedGlobs,
} from "../src/timing.ts";
import type { DeliveryTimes } from "../src/record.ts";

const manifest = loadManifest(fixtureDir);
const at = (hms: string) => Date.parse(`2026-10-24T${hms}Z`) * 1000;
const jsonl = (...lines: unknown[]) =>
  lines.map((l) => JSON.stringify(l)).join("\n");

// Claude Code's project log: assistant lines with tool_use blocks.
const claudeLine = (hms: string, name: string, input: unknown) => ({
  type: "assistant",
  timestamp: `2026-10-24T${hms}Z`,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "t", name, input }],
  },
});

// Codex's rollout file: response_item payloads; shell arguments are a JSON string.
const codexShell = (
  hms: string,
  script: string,
  workdir = "/Users/c/dibs-clones/codex/fixture",
) => ({
  timestamp: `2026-10-24T${hms}Z`,
  type: "response_item",
  payload: {
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["bash", "-lc", script], workdir }),
    call_id: "c",
  },
});
const codexPatch = (hms: string, patch: string) => ({
  timestamp: `2026-10-24T${hms}Z`,
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "apply_patch",
    input: patch,
    call_id: "p",
  },
});

describe("shared globs", () => {
  it("drop the test globs and keep the exclusions", () => {
    expect(sharedGlobs(manifest, "claude")).toEqual(["src/auth/**"]);
    expect(sharedGlobs(manifest, "codex")).toEqual([
      "public/**",
      "!public/index.html",
    ]);
    expect(sharedGlobs(manifest, "droid")).toEqual(["src/events/**"]);
  });
});

describe("parseTranscript", () => {
  it("reads Claude Code edits by file_path, and ignores reads, tests and other areas", () => {
    const text = jsonl(
      claudeLine("16:38:00", "Read", {
        file_path: "/w/fixture/src/auth/index.js",
      }),
      claudeLine("16:38:17", "Write", {
        file_path: "C:\\Users\\e\\fixture\\src\\auth\\index.js",
        content: "x",
      }),
      claudeLine("16:38:20", "Edit", {
        file_path: "C:\\Users\\e\\fixture\\test\\auth\\a.test.js",
      }),
      claudeLine("16:38:30", "Edit", {
        file_path: "C:\\Users\\e\\fixture\\src\\auth\\routes.js",
      }),
      claudeLine("16:38:40", "Edit", {
        file_path: "C:\\Users\\e\\fixture\\src\\events\\routes.js",
      }),
      {
        type: "user",
        timestamp: "2026-10-24T16:39:00Z",
        message: { content: "not json tool" },
      },
      "garbage line",
    );
    const edits = parseTranscript(text, sharedGlobs(manifest, "claude"), {
      clone: "c:/users/e/fixture",
    });
    expect(edits.map((e) => [e.path, e.how])).toEqual([
      ["src/auth/index.js", "edit-tool"],
      ["src/auth/routes.js", "edit-tool"],
    ]);
    expect(edits[0]!.atUs).toBe(at("16:38:17"));
  });

  it("reads Codex shell writes and apply_patch, not shell reads", () => {
    const text = jsonl(
      codexShell("16:40:10", "cat public/app.js src/auth/index.js"),
      codexShell(
        "16:40:30",
        "cat > public/app.js <<'EOF'\nconst token = null;\nEOF",
      ),
      codexShell(
        "16:40:40",
        "sed -i '' 's/a/b/' public/css/site.css && grep -n x public/index.html",
      ),
      codexShell("16:40:50", "echo hi > public/index.html"),
      codexPatch(
        "16:41:00",
        "*** Begin Patch\n*** Update File: public/app.js\n@@\n-a\n+b\n*** End Patch",
      ),
    );
    const edits = parseTranscript(text, sharedGlobs(manifest, "codex"), {
      clone: "/Users/c/dibs-clones/codex/fixture",
    });
    expect(
      edits.map((e) => [
        e.path,
        e.how,
        new Date(e.atUs / 1000).toISOString().slice(11, 19),
      ]),
    ).toEqual([
      ["public/app.js", "shell-write", "16:40:30"],
      ["public/css/site.css", "shell-write", "16:40:40"],
      ["public/app.js", "patch", "16:41:00"],
    ]);
  });

  it("ignores calls that ran in another folder, and absolute paths outside the clone (lobby 3, launch 3)", () => {
    const text = jsonl(
      codexShell(
        "16:48:30",
        "cat > public/app.js <<'EOF'\ncookie\nEOF",
        "/Users/c/Desktop/event-registration-fixture/app",
      ),
      codexShell(
        "16:48:40",
        "cat > /Users/c/Desktop/old/public/app.js <<'EOF'\nEOF",
        "/Users/c",
      ),
    );
    expect(
      parseTranscript(text, sharedGlobs(manifest, "codex"), {
        clone: "/Users/c/dibs-clones/codex/fixture",
      }),
    ).toEqual([]);
  });

  it("handles numeric timestamps and tool calls nested in other shapes (Droid-like)", () => {
    const text = jsonl({
      ts: at("16:45:00") / 1000, // milliseconds
      event: {
        toolName: "Create",
        parameters: { path: "src/events/routes.js" },
      },
    });
    const edits = parseTranscript(text, sharedGlobs(manifest, "droid"));
    expect(edits).toEqual([
      {
        atUs: at("16:45:00"),
        path: "src/events/routes.js",
        tool: "Create",
        how: "edit-tool",
      },
    ]);
  });
});

describe("providerTiming", () => {
  const delivery = (
    provider: string,
    kind: string,
    shown: string,
    received = shown,
  ): DeliveryTimes => ({
    provider,
    kind,
    queuedAtUs: at(received) - 1,
    receivedAtUs: at(received),
    shownAtUs: shown ? at(shown) : 0,
  });
  const edit = (hms: string) => ({
    atUs: at(hms),
    path: "public/app.js",
    tool: "shell",
    how: "shell-write" as const,
  });

  it("tells the verdicts apart, timed by the first contract the agent saw", () => {
    const deliveries = [
      delivery("codex", "message", "16:39:30"),
      delivery("codex", "contract", "16:42:00"),
      delivery("codex", "aligned", "16:44:00"),
      delivery("codex", "fallback", "16:44:10"),
    ];
    const revised = providerTiming("codex", deliveries, [
      edit("16:40:00"),
      edit("16:43:00"),
    ]);
    expect(revised).toMatchObject({
      verdict: "revised-after-contract",
      contractAtUs: at("16:42:00"),
      contractKind: "contract",
      contractStage: "shown",
      fallbackAtUs: at("16:44:10"),
      sharedEditsBefore: 1,
      sharedEditsAfter: 1,
    });
    expect(
      providerTiming("codex", deliveries, [edit("16:41:00")]).verdict,
    ).toBe("never-revised");
    expect(
      providerTiming("codex", deliveries, [edit("16:43:00")]).verdict,
    ).toBe("built-after-contract");
    expect(providerTiming("codex", deliveries, []).verdict).toBe(
      "no-shared-edits",
    );
    expect(providerTiming("codex", deliveries, undefined).verdict).toBe(
      "no-transcript",
    );
    // A message carrying a contract isn't a contract delivery (lobby 3).
    expect(
      providerTiming("codex", [deliveries[0]!], [edit("16:40:00")]).verdict,
    ).toBe("no-contract");
  });

  it("falls back to the received time when the hook never showed it", () => {
    const t = providerTiming(
      "claude",
      [delivery("claude", "aligned", "", "16:42:00")],
      [edit("16:43:00")],
    );
    expect(t).toMatchObject({
      contractStage: "received",
      contractAtUs: at("16:42:00"),
    });
  });
});

describe("revisionTiming", () => {
  it("covers every provider with a transcript or a delivery", () => {
    const report = revisionTiming({
      lobbyId: 3,
      manifest,
      deliveries: [
        {
          provider: "claude",
          kind: "notice",
          queuedAtUs: 1,
          receivedAtUs: 0,
          shownAtUs: 0,
        },
      ],
      transcripts: {
        codex: {
          text: jsonl(
            codexShell("16:40:30", "cat > public/app.js <<'EOF'\nEOF"),
          ),
        },
      },
    });
    expect(report.providers.map((p) => [p.provider, p.verdict])).toEqual([
      ["claude", "no-transcript"],
      ["codex", "no-contract"],
    ]);
  });
});
