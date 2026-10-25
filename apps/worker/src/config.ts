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
  lobbyId?: number;
  buildSha?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const portRaw = env.PORT ?? "8080";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }
  const lobbyId = env.DIBS_LOBBY_ID ? Number(env.DIBS_LOBBY_ID) : undefined;
  if (lobbyId !== undefined && (!Number.isSafeInteger(lobbyId) || lobbyId <= 0))
    throw new Error("DIBS_LOBBY_ID must be a positive integer");
  return {
    port,
    dbUri: env.SPACETIME_URI ?? "http://127.0.0.1:3000",
    dbName: env.SPACETIME_DB ?? "dibs-i3-dev",
    spacetimeToken: env.SPACETIME_TOKEN || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    // Pin a model supporting forced strict tool use; deployments can override it explicitly.
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    lobbyId,
    buildSha: env.DIBS_BUILD_SHA || undefined,
  };
}

/** The subset served at /config.json; never includes tokens or keys. */
export interface DashboardConfig extends DibsConfig {
  projectProtocol: "project-v1";
  buildSha?: string;
  uri: string;
  db: string;
  lobby?: number;
}

export function publicConfig(c: WorkerConfig): DashboardConfig {
  return {
    projectProtocol: "project-v1",
    ...(c.buildSha ? { buildSha: c.buildSha } : {}),
    dbUri: c.dbUri,
    dbName: c.dbName,
    uri: c.dbUri,
    db: c.dbName,
    ...(c.lobbyId === undefined ? {} : { lobby: c.lobbyId }),
  };
}
