import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export type Provider = "claude" | "codex";
type Json = Record<string, any>;
interface Edit {
  keys: string[];
  value: unknown;
  append?: boolean;
}
export interface Change {
  file: string;
  before: string | null;
  after: string;
  kind: "json" | "toml";
  edits: Edit[];
  block?: string;
}
export interface Attachment {
  project: string;
  provider: Provider;
  home: string;
  changes: Change[];
}
const BEGIN = "# dibs project attachment: begin";
const END = "# dibs project attachment: end";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const asset = (name: string) =>
  fileURLToPath(new URL(`../dist/${name}`, import.meta.url));

function checkedFile(project: string, relative: string) {
  const file = path.resolve(project, relative);
  const contained = path.relative(project, file);
  if (
    contained === ".." ||
    contained.startsWith(`..${path.sep}`) ||
    path.isAbsolute(contained)
  )
    throw new Error(
      "Attachment configuration must remain inside the project directory.",
    );
  let candidate = file;
  while (candidate !== project) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink())
      throw new Error(
        `Refusing to change symlinked configuration: ${candidate}`,
      );
    candidate = path.dirname(candidate);
  }
  return file;
}
function read(file: string) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function object(text: string | null, file: string): Json {
  let parsed: unknown;
  try {
    parsed = text === null ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      `Cannot parse ${file}. Fix its JSON before attaching; no configuration was changed.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Expected an object in ${file}`);
  return parsed;
}
function parent(root: Json, keys: string[], create: boolean): Json | undefined {
  let current = root;
  for (const key of keys.slice(0, -1)) {
    if (current[key] === undefined && create) current[key] = {};
    if (
      !current[key] ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      if (create)
        throw new Error(
          `Configuration key ${keys.join(".")} conflicts with dibs`,
        );
      return;
    }
    current = current[key];
  }
  return current;
}
function jsonChange(file: string, edits: Edit[]): Change {
  const before = read(file);
  const root = object(before, file);
  const owned: Edit[] = [];
  for (const edit of edits) {
    const container = parent(root, edit.keys, true)!;
    const key = edit.keys.at(-1)!;
    if (edit.append) {
      const old = container[key] ?? [];
      if (!Array.isArray(old))
        throw new Error(
          `Expected an array at ${edit.keys.join(".")} in ${file}`,
        );
      if (!old.some((entry: unknown) => same(entry, edit.value))) {
        container[key] = [...old, edit.value];
        owned.push(edit);
      }
    } else if (container[key] === undefined) {
      container[key] = edit.value;
      owned.push(edit);
    } else if (!same(container[key], edit.value)) {
      throw new Error(
        `An existing dibs configuration conflicts in ${file}; detach it before joining another room.`,
      );
    }
  }
  return {
    file,
    before,
    after: JSON.stringify(root, null, 2) + "\n",
    kind: "json",
    edits: owned,
  };
}

/** Pure preflight: validates every target before a remote seat is allocated. */
export function planAttachment(
  projectPath: string,
  provider: Provider,
  home: string,
  runtimeDir?: string,
): Attachment {
  const project = fs.realpathSync(projectPath);
  const journal = path.join(home, "attachment.json");
  if (fs.existsSync(journal)) {
    const previous = JSON.parse(fs.readFileSync(journal, "utf8")) as Attachment;
    if (
      previous.project !== project ||
      previous.provider !== provider ||
      previous.home !== home
    )
      throw new Error("Attachment recovery state does not match this project.");
    for (const change of previous.changes) {
      checkedFile(project, path.relative(project, change.file));
      const current = read(change.file);
      if (current !== change.before && current !== change.after)
        throw new Error(
          `Configuration changed during interrupted setup: ${change.file}. Run dibs leave --local before retrying.`,
        );
    }
    return previous;
  }
  const dist = runtimeDir ?? path.dirname(asset("bridge.mjs"));
  const bridge = path.join(dist, "bridge.mjs");
  const hook = path.join(dist, "dibs-hook.mjs");
  if (!fs.existsSync(bridge) || !fs.existsSync(hook))
    throw new Error("dibs runtime assets are missing; reinstall the package.");
  const args = [
    bridge,
    "--participant",
    provider,
    "--provider",
    provider,
    "--home",
    home,
  ];
  const hookArgs = [
    hook,
    "--participant",
    provider,
    "--provider",
    provider,
    "--home",
    home,
  ];
  const changes: Change[] = [];
  const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
  if (provider === "claude") {
    changes.push(
      jsonChange(checkedFile(project, ".mcp.json"), [
        {
          keys: ["mcpServers", "dibs"],
          value: { command: process.execPath, args },
        },
      ]),
    );
    changes.push(
      jsonChange(checkedFile(project, ".claude/settings.local.json"), [
        ...events.map((event) => ({
          keys: ["hooks", event],
          append: true,
          value: {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: hookArgs,
                timeout: 10,
              },
            ],
          },
        })),
        ...["dibs_plan", "dibs_status", "dibs_respond", "dibs_message"].map(
          (tool) => ({
            keys: ["permissions", "allow"],
            append: true,
            value: `mcp__dibs__${tool}`,
          }),
        ),
      ]),
    );
  } else {
    const file = checkedFile(project, ".codex/config.toml");
    const before = read(file);
    let parsed: any;
    try {
      parsed = parseToml(before ?? "");
    } catch {
      throw new Error(`Cannot parse ${file}. No configuration was changed.`);
    }
    if (parsed.mcp_servers?.dibs || (before ?? "").includes(BEGIN))
      throw new Error(
        `An existing dibs MCP entry is present in ${file}; run dibs leave first.`,
      );
    const block = `${BEGIN}\n[mcp_servers.dibs]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 30\nrequired = true\ndefault_tools_approval_mode = "approve"\n${END}\n`;
    const after =
      (before === null || before.endsWith("\n")
        ? (before ?? "")
        : before + "\n") + block;
    parseToml(after);
    changes.push({ file, before, after, kind: "toml", edits: [], block });
    // Codex's native trust review remains required. Never edit the user's trust file.
    const command = [process.execPath, ...hookArgs]
      .map(shellArgument)
      .join(" ");
    changes.push(
      jsonChange(
        checkedFile(project, ".codex/hooks.json"),
        events.map((event) => ({
          keys: ["hooks", event],
          append: true,
          value: { hooks: [{ type: "command", command, timeout: 10 }] },
        })),
      ),
    );
  }
  return { project, provider, home, changes };
}
function shellArgument(value: string) {
  // Native hook commands pass through a shell. Refuse metacharacters rather
  // than interpolating an unsafe directory or user-supplied home into a command.
  if (/[\r\n"`$%!&|<>^]/.test(value))
    throw new Error(
      "The runtime/project-state path contains unsupported shell characters.",
    );
  return `"${value}"`;
}
export function applyAttachment(plan: Attachment) {
  const written: Change[] = [];
  fs.mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  // Write-ahead journal: preserve original contents and owned entries before
  // the first config write, including across a process crash/power interruption.
  const journal = path.join(plan.home, "attachment.json");
  const temporary = journal + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(plan), { mode: 0o600 });
  fs.renameSync(temporary, journal);
  try {
    for (const change of plan.changes) {
      checkedFile(plan.project, path.relative(plan.project, change.file));
      if (read(change.file) === change.after) continue;
      if (read(change.file) !== change.before)
        throw new Error(
          `Configuration changed during setup: ${change.file}. Retry.`,
        );
      fs.mkdirSync(path.dirname(change.file), { recursive: true });
      fs.writeFileSync(change.file, change.after);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      if (read(change.file) !== change.after) continue;
      if (change.before === null) fs.unlinkSync(change.file);
      else fs.writeFileSync(change.file, change.before);
    }
    throw error;
  }
}
export function detachAttachment(home: string): string[] {
  const manifest = path.join(home, "attachment.json");
  if (!fs.existsSync(manifest)) return [];
  const plan = JSON.parse(fs.readFileSync(manifest, "utf8")) as Attachment;
  const warnings: string[] = [];
  for (const change of plan.changes) {
    checkedFile(plan.project, path.relative(plan.project, change.file));
    const current = read(change.file);
    if (current === null || current === change.before) continue;
    if (current === change.after) {
      if (change.before === null) fs.unlinkSync(change.file);
      else fs.writeFileSync(change.file, change.before);
      continue;
    }
    try {
      if (change.kind === "toml") {
        if (change.block && current.includes(change.block))
          fs.writeFileSync(change.file, current.replace(change.block, ""));
        else
          warnings.push(`Kept modified dibs configuration in ${change.file}.`);
      } else {
        const root = object(current, change.file);
        for (const edit of change.edits) {
          const container = parent(root, edit.keys, false);
          if (!container) continue;
          const key = edit.keys.at(-1)!;
          if (edit.append && Array.isArray(container[key]))
            container[key] = container[key].filter(
              (entry: unknown) => !same(entry, edit.value),
            );
          else if (same(container[key], edit.value)) delete container[key];
          else if (!edit.append)
            warnings.push(
              `Kept modified ${edit.keys.join(".")} in ${change.file}.`,
            );
        }
        fs.writeFileSync(change.file, JSON.stringify(root, null, 2) + "\n");
      }
    } catch {
      warnings.push(
        `Could not safely detach ${change.file}; it was left untouched.`,
      );
    }
  }
  fs.renameSync(
    manifest,
    path.join(home, `attachment-detached-${Date.now()}.json`),
  );
  return warnings;
}
