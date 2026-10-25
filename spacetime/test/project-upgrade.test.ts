import { afterAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { fresh, prepare, uri, type Harness } from "./harness.ts";
import { spacetime } from "../../packages/cli/src/commands/local.ts";
import { waitFor } from "../../packages/cli/src/commands/common.ts";
let h: Harness | undefined;
afterAll(() => h?.close());
test("populated legacy c5f895f schema upgrades additively and retains benchmark operations", async () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const baseline = "c5f895fc569acfa4b1bcb9e72f911eb78602f205";
  const legacy = path.join(repo, "spacetime/.project-legacy-module");
  fs.mkdirSync(path.join(legacy, "src"), { recursive: true });
  const names = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baseline, "spacetime/src"],
    { cwd: repo, encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/);
  for (const name of names) {
    const file = path.join(legacy, name.replace(/^spacetime\//, ""));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      execFileSync("git", ["show", `${baseline}:${name}`], { cwd: repo }),
    );
  }
  fs.writeFileSync(
    path.join(legacy, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { spacetimedb: "^2.13.0" },
    }),
  );
  fs.writeFileSync(
    path.join(legacy, "tsconfig.json"),
    JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }),
  );
  const updated = await prepare();
  h = await fresh(legacy);
  const lobbyId = await h.lobby();
  const requestId = await h.plan("claude");
  const original = [...h.admin.db.plan.iter()].find(
    (p) => p.requestId === requestId,
  )!;
  const identities = [...h.admin.db.participant.iter()]
    .map((p) => p.identity.toHexString())
    .sort();
  spacetime([
    "publish",
    "--server",
    uri,
    "--module-path",
    updated,
    "--delete-data=never",
    "--yes",
    h.dbName,
  ]);
  expect(
    [...h.admin.db.participant.iter()]
      .map((p) => p.identity.toHexString())
      .sort(),
  ).toEqual(identities);
  expect(h.admin.db.plan.id.find(original.id)?.requestId).toBe(requestId);
  expect(h.admin.db.lobby.id.find(lobbyId)?.state).toBe("running");
  await h.plan("codex");
  await h.admin.reducers.configureProjects({
    enabled: true,
    maxActiveRooms: 10,
    maxRoomsPerDay: 20,
    maxLeasesPerDay: 100,
  });
  const peer = await h.stranger();
  await peer.reducers.createProject({
    code: randomBytes(24).toString("hex"),
    provider: "claude",
    brief: "After upgrade",
    vocabularyJson: '[{"key":"project.interface","description":"API"}]',
    protocol: "project-v1",
  });
  await waitFor(() =>
    [...h!.admin.db.lobby.iter()].find((l) => l.scenario === "project"),
  );
}, 120000);
