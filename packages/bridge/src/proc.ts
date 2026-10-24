import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pidAlive } from "./home.ts";

const exec = promisify(execFile);

export async function killTree(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    if (process.platform === "win32") {
      await exec("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    if (!pidAlive(pid)) return;
    throw new Error(`could not stop process ${pid}`);
  }
}

export function spawnAgent(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string },
): { pid: number; exited: Promise<number> } {
  const [bin, ...args] = command;
  if (!bin) throw new Error("agent command is empty");
  fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
  const logFd = fs.openSync(options.logPath, "a");
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    shell: false,
  });
  fs.closeSync(logFd);
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (!child.pid) throw new Error(`failed to spawn ${bin}`);
  return { pid: child.pid, exited };
}

/** Prefer a real executable. Node throws EINVAL when it spawns a Windows `.cmd` without a shell. */
export function resolveExe(name: string): string {
  const override = process.env[`DIBS_${name.toUpperCase()}_BIN`];
  if (override) return override;
  if (process.platform !== "win32") return name;
  try {
    const out = execFileSync("where.exe", [name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      lines.find((line) => line.toLowerCase().endsWith(".exe")) ??
      lines[0] ??
      `${name}.exe`
    );
  } catch {
    return `${name}.exe`;
  }
}
