#!/usr/bin/env -S npx tsx
// The `dibs` command. Each subcommand lives with the issue that owns it, and exports
// `main(args: string[]): Promise<void>`. Run with `npm run dibs -- <command> [args]`.
//
//   join, lobby, admin, sim, export  → packages/cli/src/commands/   (issue 1)
//   session                          → packages/bridge/src/session.ts (issue 2)
//   verify, review                   → packages/verifier/src/        (issue 4)
//
// Paths are resolved at runtime so this file typechecks before the other packages exist.

const COMMANDS: Record<string, string> = {
  join: "./commands/join.ts",
  lobby: "./commands/lobby.ts",
  admin: "./commands/admin.ts",
  sim: "./commands/sim.ts",
  export: "./commands/export.ts",
  session: "../../bridge/src/session.ts",
  verify: "../../verifier/src/verify.ts",
  review: "../../verifier/src/review.ts",
  create: "../../experience/src/main.ts",
  status: "../../experience/src/main.ts",
  doctor: "../../experience/src/main.ts",
  leave: "../../experience/src/main.ts",
  close: "../../experience/src/main.ts",
  decide: "../../experience/src/main.ts",
};

const [name, ...args] = process.argv.slice(2);
const projectCommand =
  ["create", "status", "doctor", "leave", "close", "decide"].includes(
    name ?? "",
  ) ||
  (name === "join" && args[0]?.startsWith("dibs1_"));
const target = projectCommand
  ? "../../experience/src/main.ts"
  : name
    ? COMMANDS[name]
    : undefined;

if (!target) {
  console.error(`usage: dibs <${Object.keys(COMMANDS).join("|")}> [args]`);
  process.exit(name ? 2 : 0);
}

let command: { main?: (args: string[]) => Promise<void> };
try {
  command = await import(new URL(target, import.meta.url).href);
} catch (error) {
  console.error(`dibs ${name}: not built yet (${target})`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
if (typeof command.main !== "function") {
  console.error(`dibs ${name}: ${target} doesn't export main(args)`);
  process.exit(1);
}
try {
  await command.main(projectCommand ? [name!, ...args] : args);
} catch (error) {
  console.error(
    `dibs ${name}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
