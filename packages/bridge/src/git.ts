import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "dibs",
    GIT_AUTHOR_EMAIL: "dibs@localhost",
    GIT_COMMITTER_NAME: "dibs",
    GIT_COMMITTER_EMAIL: "dibs@localhost",
  };
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const failed = error as { stderr?: string; message?: string };
    const detail =
      failed.stderr?.trim() || failed.message || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
}
