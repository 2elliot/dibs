import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});
await build({
  absWorkingDir: root,
  entryPoints: ["../bridge/src/main.ts"],
  outfile: "dist/bridge.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
fs.copyFileSync(
  path.join(root, "../bridge/hook/dibs-hook.mjs"),
  path.join(dist, "dibs-hook.mjs"),
);
fs.writeFileSync(
  path.join(dist, "service.json"),
  JSON.stringify({ server: process.env.DIBS_DEFAULT_SERVER || null }) + "\n",
);
// Runtime needs only these files; no workspace imports, tsx, or source checkout.
