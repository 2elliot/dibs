import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// In production the worker (issue 3) serves /config.json. In dev and preview we serve it from
// env vars so live mode can be tried locally; with no env vars it 404s and the app falls back
// to replay, which is also what the offline laptop copy does.
function devConfigJson(): Plugin {
  const handler = (
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader(k: string, v: string): void;
      end(b?: string): void;
    },
    next: () => void,
  ) => {
    if (!req.url || !req.url.startsWith("/config.json")) return next();
    const dbName = process.env.DIBS_DB_NAME;
    if (!dbName) {
      res.statusCode = 404;
      res.end("no DIBS_DB_NAME set");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        dbUri: process.env.DIBS_DB_URI ?? "http://127.0.0.1:3000",
        dbName,
        ...(process.env.DIBS_LOBBY
          ? { lobbyId: Number(process.env.DIBS_LOBBY) }
          : {}),
      }),
    );
  };
  return {
    name: "dibs-dev-config-json",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), devConfigJson()],
  build: { outDir: "dist", emptyOutDir: true },
});
