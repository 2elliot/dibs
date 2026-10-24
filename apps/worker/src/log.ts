// Structured logs, one JSON object per line, always on stderr. Never log prompts, plan text,
// reducer arguments, tokens or keys: callers pass only ids, counts, timings and error codes.

export type LogFields = Record<string, string | number | boolean | null | undefined | string[] | number[]>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

function write(level: string, msg: string, fields?: LogFields): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(line + "\n");
}

export const stderrLogger: Logger = {
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Collects log lines in memory; tests assert on them (and that no prompt text leaks into them). */
export class MemoryLogger implements Logger {
  readonly lines: { level: string; msg: string; fields: LogFields }[] = [];
  info(msg: string, fields: LogFields = {}): void {
    this.lines.push({ level: "info", msg, fields });
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.lines.push({ level: "warn", msg, fields });
  }
  error(msg: string, fields: LogFields = {}): void {
    this.lines.push({ level: "error", msg, fields });
  }
  find(msg: string) {
    return this.lines.filter((line) => line.msg === msg);
  }
}

/** Short, single-line error text for logs and `fail_job`. Never includes request bodies. */
export function errorText(error: unknown, max = 200): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, max);
}
