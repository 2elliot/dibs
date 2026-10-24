// Frozen: nobody edits this file. It wires the three areas together.
import express from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import authRoutes from "./auth/routes.js";
import eventRoutes from "./events/routes.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use(authRoutes);
  app.use(eventRoutes);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () =>
    console.log(`Listening on http://localhost:${port}`),
  );
}
