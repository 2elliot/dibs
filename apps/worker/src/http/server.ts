// The one HTTP surface of the Azure Container App: liveness, status, runtime config, and the
// dashboard static files. /health/live is the only probe target (a bare process check), so a
// Maincloud blip can't 503 the whole app. The SPA fallback never masks /health/* or /config.json.
import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Express, Request, Response } from "express";
import type { DibsConfig } from "@dibs/protocol";
import type { HealthState } from "./health.ts";

export interface ServerOptions {
  publicConfig: DibsConfig;
  health: HealthState;
  /** apps/dashboard/dist, if it was built into the image. Optional in dev. */
  staticDir?: string;
}

export function createServer(opts: ServerOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // Liveness: always 200 while the process is up. This is the probe target.
  app.get("/health/live", (_req: Request, res: Response) => {
    res.json({ status: "live", uptimeSec: opts.health.report().uptimeSec });
  });

  // Rich status: diagnostics, NOT a probe (so one replica + a DB blip won't fail the probe).
  app.get("/health/status", (_req: Request, res: Response) => {
    res.json(opts.health.report());
  });

  // Runtime config for the dashboard (Vite bakes env at build time, so it fetches this).
  app.get("/config.json", (_req: Request, res: Response) => {
    res.json(opts.publicConfig);
  });

  const indexHtml =
    opts.staticDir && existsSync(join(opts.staticDir, "index.html"))
      ? join(opts.staticDir, "index.html")
      : undefined;

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
  }

  // SPA fallback: GET requests that aren't an API/health route and didn't match a static file get
  // index.html, so client-side routes work on refresh. Never touches /health/* or /config.json.
  if (indexHtml) {
    app.use((req: Request, res: Response, next) => {
      if (req.method !== "GET") return next();
      if (req.path.startsWith("/health/") || req.path === "/config.json")
        return next();
      res.sendFile(indexHtml);
    });
  }

  return app;
}

export function startServer(
  app: Express,
  port: number,
): Promise<import("node:http").Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}
