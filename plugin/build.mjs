// Bundles the MCP server and each hook into a self-contained .mjs under dist/, so the
// plugin runs with plain `node` and needs no node_modules wherever it's installed.
import { build, context } from "esbuild";

const options = {
  entryPoints: {
    server: "src/server.ts",
    "hooks/session-start": "src/hooks/session-start.ts",
    "hooks/pre-tool-use": "src/hooks/pre-tool-use.ts",
    "hooks/post-tool-use": "src/hooks/post-tool-use.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
