import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(root, "dist"), { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/bridge.mjs",
  logLevel: "warning",
});

fs.copyFileSync(
  path.join(root, "hook", "dibs-hook.mjs"),
  path.join(root, "dist", "dibs-hook.mjs"),
);
