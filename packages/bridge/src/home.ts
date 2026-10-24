// Per-participant files under DIBS_HOME. config.json is the only machine-wide file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIBS_FILES, DIBS_HOME_ENV, type BridgeLock } from "@dibs/protocol";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function assertParticipant(name: string): void {
  if (!NAME.test(name))
    throw new Error(`invalid participant name ${JSON.stringify(name)}`);
}

export function resolveHome(override?: string): string {
  const raw =
    override || process.env[DIBS_HOME_ENV] || path.join(os.homedir(), ".dibs");
  const expanded = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.resolve(expanded);
}

export function participantDir(home: string, participant: string): string {
  assertParticipant(participant);
  return path.join(home, participant);
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function canonicalPath(file: string): string {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist yet still compares by its resolved form.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or a directory inside it. */
export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function forwardSlash(file: string): string {
  return path.resolve(file).replaceAll("\\", "/");
}

export function acquireLock(
  dir: string,
  participant: string,
  nowUs = Date.now() * 1000,
): { ok: true; release: () => void } | { ok: false; holder: number } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, DIBS_FILES.bridgeLock);
  const existing = readJson(file) as Partial<BridgeLock> | undefined;
  if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) {
    return { ok: false, holder: existing.pid as number };
  }
  const lock: BridgeLock = {
    pid: process.pid,
    participant,
    startedAtUs: nowUs,
  };
  writeJsonAtomic(file, lock);
  return {
    ok: true,
    release() {
      const current = readJson(file) as Partial<BridgeLock> | undefined;
      if (current?.pid === process.pid) fs.rmSync(file, { force: true });
    },
  };
}

export function configPath(home: string): string {
  return path.join(home, DIBS_FILES.config);
}

export function tokenPath(dir: string): string {
  return path.join(dir, DIBS_FILES.token);
}
