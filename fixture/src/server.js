// Frozen: nobody edits this file.
//
// Starts the app on 127.0.0.1:$PORT (default 4000; PORT=0 picks a free port).
// JSON bodies and cookies are parsed for every route. The auth and events routers are
// mounted at /api, and everything in public/ is served as static files.

import express from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import authRoutes from "./auth/routes.js";
import eventRoutes from "./events/routes.js";

export const app = express();

app.use(express.json());
app.use(cookieParser());
app.use("/api", authRoutes);
app.use("/api", eventRoutes);
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

const port = Number(process.env.PORT ?? 4000);

export const server = app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`listening on http://127.0.0.1:${actual}`);
});
