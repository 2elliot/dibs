import { afterAll, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { prepare, fresh, type Harness } from "./harness.ts";
import { waitFor } from "../../packages/cli/src/commands/common.ts";
let h: Harness | undefined;
afterAll(() => h?.close());
test("project TTL rejects agent/lease/analysis writes even if scheduled stop is delayed", async () => {
  const source = await prepare();
  const module = path.join(path.dirname(source), ".project-expiry-module");
  fs.mkdirSync(module, { recursive: true });
  fs.cpSync(path.join(source, "src"), path.join(module, "src"), {
    recursive: true,
  });
  for (const name of ["package.json", "tsconfig.json"])
    fs.copyFileSync(path.join(source, name), path.join(module, name));
  const projectFile = path.join(module, "src/projects.ts");
  const original = fs.readFileSync(projectFile, "utf8");
  const shortened = original
    .replace(/endsAtUs:\s*at \+ DAY_US/, "endsAtUs: at + 2_000_000n")
    .replace(
      "ScheduleAt.time(l.endsAtUs)",
      "ScheduleAt.time(l.endsAtUs + 60_000_000n)",
    );
  expect(shortened).not.toBe(original);
  fs.writeFileSync(projectFile, shortened);
  const timing = path.join(module, "src/timing.ts");
  fs.writeFileSync(
    timing,
    fs.readFileSync(timing, "utf8").replace('"leaseSec":1', '"leaseSec":10'),
  );
  h = await fresh(module);
  await h.admin.reducers.configureProjects({
    enabled: true,
    maxActiveRooms: 10,
    maxRoomsPerDay: 20,
    maxLeasesPerDay: 100,
  });
  const rooms = [];
  for (let i = 0; i < 2; i++) {
    const owner = await h.stranger();
    await owner.reducers.createProject({
      code: randomBytes(24).toString("hex"),
      provider: "claude",
      brief: `Expiry ${i}`,
      vocabularyJson: '[{"key":"project.interface","description":"API"}]',
      protocol: "project-v1",
    });
    const lobby = await waitFor(() =>
      [...h!.admin.db.lobby.iter()].find((l) => l.charter === `Expiry ${i}`),
    );
    await owner.reducers.publishPlan({
      requestId: randomUUID(),
      goal: "API",
      produces: [{ key: "project.interface", text: "GET /hello" }],
      requires: [],
      notes: "",
    });
    const job = await waitFor(() =>
      [...h!.admin.db.job.iter()].find(
        (j) => j.lobbyId === lobby.id && j.state === "queued",
      ),
    );
    rooms.push({ owner, lobby, job });
  }
  const first = rooms[0]!,
    second = rooms[1]!;
  const leaseToken = randomUUID();
  await h.peer.worker.reducers.leaseJob({ jobId: first.job.id, leaseToken });
  const leased = await waitFor(() =>
    h!.admin.db.job.id.find(first.job.id)?.state === "leased"
      ? h!.admin.db.job.id.find(first.job.id)!
      : undefined,
  );
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Number(second.lobby.endsAtUs) / 1000 - Date.now() + 50),
    ),
  );
  expect(h.admin.db.lobby.id.find(first.lobby.id)?.state).toBe("running");
  await expect(
    first.owner.reducers.publishPlan({
      requestId: randomUUID(),
      goal: "late",
      produces: [],
      requires: [],
      notes: "",
    }),
  ).rejects.toThrow("closed or expired");
  await expect(
    h.peer.worker.reducers.leaseJob({
      jobId: second.job.id,
      leaseToken: randomUUID(),
    }),
  ).rejects.toThrow("closed or expired");
  await expect(
    h.peer.worker.reducers.submitAnalysis({
      jobId: first.job.id,
      leaseToken,
      inputKey: leased.inputKey,
      findingsJson: '{"findings":[]}',
    }),
  ).rejects.toThrow("closed or expired");
}, 120000);
