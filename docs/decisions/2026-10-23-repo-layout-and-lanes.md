# Monorepo, three lanes, one shared contract

Lane: all · Date: 2026-10-23

One npm-workspaces monorepo, TypeScript only: `packages/shared`, `packages/core`, `plugin/`, `dashboard/`, plus `supabase/` and `demo/`. Each teammate owns a lane (plugin, core, demo) and only edits that lane's files, so parallel work can't conflict.

`packages/shared` holds the row types and operation types all lanes build against. Lanes code against it instead of waiting on each other, which is dibs's own idea applied to us.

Workspace packages export TypeScript source with no build step. The plugin bundles itself with esbuild into `plugin/dist/*.mjs`, so the installed plugin runs on plain `node` with no `node_modules`. The dashboard compiles `@dibs/shared` through `transpilePackages`.

Each lane's likely dependencies were installed up front so `package-lock.json` rarely changes.
