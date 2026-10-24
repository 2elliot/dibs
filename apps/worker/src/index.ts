// Entry point for the Azure Container App. Always starts the HTTP server (liveness, status, config,
// dashboard). The analysis loop runs only once a real DibsDb over @dibs/client exists (Phase B,
// after issue 1's [module-ready]); until then the server runs and reports db:"unknown" so the
// container is healthy and the dashboard can be served. Logging goes to stderr.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, publicConfig } from "./config.ts";
import { HealthState } from "./http/health.ts";
import { createServer, startServer } from "./http/server.ts";

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
      "[worker] SPACETIME_TOKEN not set: analysis loop disabled (Phase B wires @dibs/client once issue 1 ships [module-ready]).",
    );
    return;
  }
  // Phase B: construct the real DibsDb over @dibs/client and the model client, then:
  //   const model = config.anthropicApiKey
  //     ? new AnthropicModelClient({ apiKey: config.anthropicApiKey, model: config.anthropicModel })
  //     : <fake/deterministic>;
  //   new WorkerLoop({ db, model, health }).start();
  console.error(
    "[worker] SPACETIME_TOKEN set but the real DB client is not wired yet (Phase B).",
  );
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
