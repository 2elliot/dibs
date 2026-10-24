// Worker configuration, read once from the environment. The dashboard fetches the public subset
// from /config.json at runtime (Vite bakes env at build time, so the DB coordinates can't be baked).
import type { DibsConfig } from "@dibs/protocol";

export interface WorkerConfig {
  /** HTTP port. Container default 8080; locally use 4130 (issue 3 range 4130-4139). */
  port: number;
  dbUri: string;
  dbName: string;
  /** The worker's SpacetimeDB token. Absent on this dev machine; the loop stays idle without it. */
  spacetimeToken: string | undefined;
  /** Absent on this dev machine; the real model client is only built when it is set. */
  anthropicApiKey: string | undefined;
  anthropicModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const portRaw = env.PORT ?? "8080";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }
  return {
    port,
    dbUri: env.SPACETIME_URI ?? "http://127.0.0.1:3000",
    dbName: env.SPACETIME_DB ?? "dibs-i3-dev",
    spacetimeToken: env.SPACETIME_TOKEN || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    // Confirmed at 08:45 in the plan; overridable so tuning never needs a code change.
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-3-7-sonnet-latest",
  };
}

/** The subset served at /config.json; never includes tokens or keys. */
export function publicConfig(c: WorkerConfig): DibsConfig {
  return { dbUri: c.dbUri, dbName: c.dbName };
}
