import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "../src/http/server.ts";
import { HealthState } from "../src/http/health.ts";

const publicConfig = { dbUri: "http://127.0.0.1:3000", dbName: "dibs-i3-test" };

let server: Server | undefined;
afterEach(() => server?.close());

function listen(staticDir?: string): Promise<string> {
  const health = new HealthState();
  health.setDb("connected");
  const app = createServer({ publicConfig, health, staticDir });
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("http server", () => {
  it("serves liveness, status, and runtime config", async () => {
    const base = await listen();

    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(((await live.json()) as { status: string }).status).toBe("live");

    const status = await fetch(`${base}/health/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body.db).toBe("connected");
    expect(body).toHaveProperty("queueAgeSec");
    expect(body).toHaveProperty("anthropicErrors");

    const config = await fetch(`${base}/config.json`);
    expect(await config.json()).toEqual(publicConfig);
  });

  it("falls back to index.html for SPA routes but never for /health or /config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dibs-dash-"));
    writeFileSync(
      join(dir, "index.html"),
      "<!doctype html><title>dibs</title>",
    );
    const base = await listen(dir);

    const spa = await fetch(`${base}/lobby/42`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("<title>dibs</title>");

    // /config.json must still be JSON, not the SPA shell.
    const config = await fetch(`${base}/config.json`);
    expect(config.headers.get("content-type")).toMatch(/application\/json/);
    expect(await config.json()).toEqual(publicConfig);
  });
});
