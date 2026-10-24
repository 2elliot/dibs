// Provider configs from templates/. Rewritten byte-for-byte on every prep, so Codex hook
// trust and Droid MCP approvals survive from one lobby to the next.

import fs from "node:fs";
import path from "node:path";
import type { Provider } from "@dibs/protocol";
import { packageRoot } from "./build-hash.ts";
import { forwardSlash } from "./home.ts";

const TRUST_BEGIN = "# dibs:trust:start\n";
const TRUST_END = "# dibs:trust:end\n";

export const DIBS_COMMAND =
  "Call `dibs_status` with `waitSec: 0` and summarize for the human in at most 6 lines: lobby and mode, each shared key's status, proposals awaiting you, agreed contracts, and `fallbackInSec`. Don't edit code.\n";

export interface RenderInput {
  participant: string;
  provider: Provider;
  clonePath: string;
  home: string;
  codexHome: string;
}

export interface RenderedFile {
  path: string;
  body: string;
  merge?: "trust";
}

export function bridgeBinary(): string {
  const file = path.join(packageRoot(), "dist", "bridge.mjs");
  if (!fs.existsSync(file))
    throw new Error(
      "dist/bridge.mjs is missing; run npm run build -w @dibs/bridge",
    );
  return file;
}

export function hookBinary(): string {
  const file = path.join(packageRoot(), "dist", "dibs-hook.mjs");
  if (!fs.existsSync(file))
    throw new Error(
      "dist/dibs-hook.mjs is missing; run npm run build -w @dibs/bridge",
    );
  return file;
}

export function renderProvider(input: RenderInput): RenderedFile[] {
  const vars = {
    __BRIDGE__: safe(forwardSlash(bridgeBinary())),
    __HOOK__: safe(forwardSlash(hookBinary())),
    __PARTICIPANT__: safe(input.participant),
    __PROVIDER__: safe(input.provider),
    __CLONE__: safe(forwardSlash(input.clonePath)),
  };
  const dir = path.join(input.home, input.participant);
  const clone = input.clonePath;
  const templates = path.join(packageRoot(), "templates");
  const command = fs.readFileSync(path.join(templates, "dibs.md"), "utf8");
  if (input.provider === "claude") {
    return [
      {
        path: path.join(dir, "claude.settings.json"),
        body: jsonTemplate("claude.settings.json", vars),
      },
      {
        path: path.join(dir, "claude.mcp.json"),
        body: jsonTemplate("claude.mcp.json", vars),
      },
      {
        path: path.join(clone, ".claude", "commands", "dibs.md"),
        body: command.endsWith("\n") ? command : `${command}\n`,
      },
    ];
  }
  if (input.provider === "codex") {
    return [
      {
        path: path.join(clone, ".codex", "config.toml"),
        body: textTemplate("codex.config.toml", vars),
      },
      {
        path: path.join(clone, ".codex", "hooks.json"),
        body: jsonTemplate("codex.hooks.json", vars),
      },
      {
        path: path.join(input.codexHome, "prompts", "dibs.md"),
        body: command.endsWith("\n") ? command : `${command}\n`,
      },
      {
        path: path.join(input.codexHome, "config.toml"),
        body: textTemplate("codex.trust.toml", vars),
        merge: "trust",
      },
    ];
  }
  return [
    {
      path: path.join(clone, ".factory", "mcp.json"),
      body: jsonTemplate("droid.mcp.json", vars),
    },
    {
      path: path.join(clone, ".factory", "hooks.json"),
      body: jsonTemplate("droid.hooks.json", vars),
    },
    {
      path: path.join(dir, "droid.settings.json"),
      body: jsonTemplate("droid.settings.json", vars),
    },
    {
      path: path.join(clone, ".factory", "commands", "dibs.md"),
      body: command.endsWith("\n") ? command : `${command}\n`,
    },
  ];
}

export function writeProvider(input: RenderInput): RenderedFile[] {
  const files = renderProvider(input);
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    if (file.merge === "trust") upsertTrust(file.path, file.body);
    else fs.writeFileSync(file.path, file.body);
  }
  return files;
}

export function launchFiles(
  provider: Provider,
  home: string,
  participant: string,
): { settings?: string; mcp?: string } {
  const dir = path.join(home, participant);
  if (provider === "claude")
    return {
      settings: path.join(dir, "claude.settings.json"),
      mcp: path.join(dir, "claude.mcp.json"),
    };
  if (provider === "droid")
    return { settings: path.join(dir, "droid.settings.json") };
  return {};
}

export function providerCommand(
  provider: Provider,
  files: { settings?: string; mcp?: string },
  prompt: string,
): string[] {
  if (provider === "claude") {
    return [
      "claude",
      "--settings",
      files.settings ?? "",
      "--mcp-config",
      files.mcp ?? "",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      prompt,
    ];
  }
  if (provider === "codex") {
    return [
      "codex",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      prompt,
    ];
  }
  return ["droid", "--settings", files.settings ?? "", prompt];
}

function jsonTemplate(name: string, vars: Record<string, string>): string {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(packageRoot(), "templates", name), "utf8"),
  ) as unknown;
  return `${JSON.stringify(fill(parsed, vars), null, 2)}\n`;
}

function textTemplate(name: string, vars: Record<string, string>): string {
  let text = fs.readFileSync(
    path.join(packageRoot(), "templates", name),
    "utf8",
  );
  for (const [key, value] of Object.entries(vars))
    text = text.split(key).join(value);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function fill(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return Object.entries(vars).reduce(
      (text, [key, replacement]) => text.split(key).join(replacement),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = fill(item, vars);
    return out;
  }
  return value;
}

function safe(value: string): string {
  if (/["\n\r]/.test(value))
    throw new Error(`path cannot contain quotes or newlines: ${value}`);
  return value;
}

export function upsertTrust(file: string, block: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wrapped = `${TRUST_BEGIN}${block.trim()}\n${TRUST_END}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const pattern = /# dibs:trust:start\n[\s\S]*?# dibs:trust:end\n/;
  const next = pattern.test(current)
    ? current.replace(pattern, wrapped)
    : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${wrapped}`;
  fs.writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`);
}
