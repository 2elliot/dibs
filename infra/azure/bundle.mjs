// Assembles the app root for the Azure image: the worker bundled into one ESM file, plus the
// built dashboard. Run from a checkout with `npm ci` done and `npm run build -w @dibs/dashboard`.
// usage: node infra/azure/bundle.mjs <checkout> <imageRoot> <realSha>
// The image runs `node /app/apps/worker/src/index.mjs` (see push-image.ps1).
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const [checkout, imageRoot, realSha] = process.argv.slice(2);
if (!checkout || !imageRoot || !/^[0-9a-f]{40}$/.test(realSha ?? "")) {
  console.error(
    "usage: node bundle.mjs <checkout> <imageRoot> <full real commit sha>",
  );
  process.exit(2);
}
const { build } = createRequire(path.join(checkout, "package.json"))("esbuild");
const output = path.join(imageRoot, "app");
await rm(imageRoot, { recursive: true, force: true });
await mkdir(path.join(output, "apps/worker/src"), { recursive: true });
await build({
  entryPoints: [path.join(checkout, "apps/worker/src/index.ts")],
  outfile: path.join(output, "apps/worker/src/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
await cp(
  path.join(checkout, "apps/dashboard/dist"),
  path.join(output, "apps/dashboard/dist"),
  { recursive: true },
);
const buildId = `real-${realSha.slice(0, 12)}`;
await writeFile(
  path.join(output, "deployment-source.json"),
  JSON.stringify({ buildId, sources: { real: realSha } }, null, 2) + "\n",
);
console.log(buildId);
