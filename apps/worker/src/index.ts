// Entry point for the Azure Container App. Always starts the HTTP server (liveness, status, config,
// dashboard). The analysis loop starts when both SPACETIME_TOKEN and ANTHROPIC_API_KEY are set;
// otherwise it stays server-only (healthy container, dashboard served, db reported accordingly).
// Logging goes to stderr.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, publicConfig } from "./config.ts";
import { HealthState } from "./http/health.ts";
import { createServer, startServer } from "./http/server.ts";
import { AnthropicModelClient } from "./model/anthropic.ts";
import { SpacetimeDibsDb } from "./worker/spacetime-db.ts";
import { WorkerLoop } from "./worker/loop.ts";
import { connectWithRetry } from "./worker/connect.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const health = new HealthState();

  // apps/dashboard/dist is copied next to the worker in the image; absent in dev.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "dashboard", "dist"),
    join(here, "..", "public"),
  ];
  const staticDir = candidates.find((d) => existsSync(d));

  const app = createServer({
    publicConfig: publicConfig(config),
    health,
    staticDir,
  });
  await startServer(app, config.port);
  console.error(
    `[worker] http on :${config.port} (static: ${staticDir ?? "none"}; db ${config.dbName} @ ${config.dbUri})`,
  );

  if (!config.spacetimeToken) {
    console.error(
      "[worker] SPACETIME_TOKEN not set: analysis loop disabled (server-only mode).",
    );
    return;
  }
  if (!config.anthropicApiKey) {
    // The loop needs a model to produce findings; without a key we stay server-only rather than
    // leasing jobs we can't analyze.
    console.error(
      "[worker] ANTHROPIC_API_KEY not set: analysis loop disabled (server-only mode).",
    );
    return;
  }

  try {
    const connection = {
      uri: config.dbUri,
      dbName: config.dbName,
      token: config.spacetimeToken,
    };
    const db = await connectWithRetry(
      () => SpacetimeDibsDb.connect(connection),
      health,
    );
    health.setDb("connected");
    const model = new AnthropicModelClient({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
    });
    new WorkerLoop({ db, model, health }).start();
    console.error(
      `[worker] analysis loop started (model ${config.anthropicModel}).`,
    );
  } catch (e) {
    health.setDb("disconnected");
    console.error("[worker] failed to start analysis loop:", e);
  }
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
