// Writing verification and review rows. The reducer arguments are always written next to the
// report (bench/results/<lobbyId>/verification.json, review-row.json). When this machine has
// joined the database as the verifier (`dibs join --participant verifier ...`), they are also
// sent with `record_verification` / `record_review`, and `mark_verified` follows a verification.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssembledFrom, ReviewKind } from "@dibs/protocol";
import {
  call,
  connect,
  subscribeLobby,
  toJson,
  type DbConnection,
} from "@dibs/client";
import { readConfig, readToken, saveToken } from "@dibs/client/node";

/** Arguments of the `record_verification` reducer (docs/API.md). */
export interface VerificationRow {
  lobbyId: number;
  assembledFrom: string; // JSON AssembledFrom
  treeHash: string;
  mergeTreeClean: boolean;
  oracleHash: string;
  exitCode: number;
  passed: number;
  total: number;
  reportHash: string;
}

/** Arguments of the `record_review` reducer (docs/API.md). */
export interface ReviewRow {
  lobbyId: number;
  verificationId: number;
  kind: ReviewKind;
  summary: string;
  findingsJson: string; // JSON ReviewFindings
  model: string;
  sessionId: string;
}

/** One delivery's target provider, kind and stage times (µs since the epoch; 0 = not reached). */
export interface DeliveryTimes {
  provider: string;
  kind: string;
  queuedAtUs: number;
  receivedAtUs: number;
  shownAtUs: number;
}

export interface Recorder {
  /** Returns the new verification id, or null when only written locally. */
  recordVerification(row: VerificationRow): Promise<number | null>;
  recordReview(row: ReviewRow): Promise<void>;
  markVerified(lobbyId: number): Promise<void>;
  /** The lobby's baseSha from the database, when connected. */
  lobbyBaseSha(lobbyId: number): Promise<string | undefined>;
  /** The newest verification id for a lobby, when connected. */
  latestVerificationId(lobbyId: number): Promise<number | undefined>;
  /** The lobby's current contracts (agreed or aligned), when connected. */
  currentContracts(
    lobbyId: number,
  ): Promise<
    { key: string; text: string; source: "agreed" | "aligned" }[] | undefined
  >;
  /** The lobby's deliveries with their target's provider, when connected. */
  deliveries(lobbyId: number): Promise<DeliveryTimes[] | undefined>;
  /** Every row of the lobby, table by table, as plain JSON, when connected. */
  dumpLobby(lobbyId: number): Promise<Record<string, unknown[]> | undefined>;
  close(): void;
  readonly description: string;
}

/** Writes the reducer arguments next to the report; nothing reaches the database. */
export class LocalRecorder implements Recorder {
  readonly description: string;
  constructor(
    private readonly dir: string,
    why = "no verifier token on this machine",
  ) {
    this.description = `local only (${why})`;
  }

  async recordVerification(row: VerificationRow) {
    writeFileSync(
      join(this.dir, "verification.json"),
      `${JSON.stringify(row, null, 2)}\n`,
    );
    return null;
  }

  async recordReview(row: ReviewRow) {
    writeFileSync(
      join(this.dir, "review-row.json"),
      `${JSON.stringify(row, null, 2)}\n`,
    );
  }

  async markVerified() {}
  async lobbyBaseSha() {
    return undefined;
  }
  async latestVerificationId() {
    return undefined;
  }
  async currentContracts() {
    return undefined;
  }
  async deliveries() {
    return undefined;
  }
  async dumpLobby() {
    return undefined;
  }
  close() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The database, as the verifier participant, plus the local copy. */
export class DbRecorder implements Recorder {
  readonly description: string;
  private readonly local: LocalRecorder;
  private subscribed = new Set<number>();

  private constructor(
    private readonly conn: DbConnection,
    dir: string,
    participant: string,
    dbName: string,
  ) {
    this.local = new LocalRecorder(dir);
    this.description = `database ${dbName} as ${participant}`;
  }

  static async open(dir: string, participant: string): Promise<DbRecorder> {
    const config = await readConfig();
    const token = await readToken(participant);
    if (!token) throw new Error(`no saved token for ${participant}`);
    const { conn, token: issued } = await connect({
      uri: config.dbUri,
      dbName: config.dbName,
      token,
    });
    await saveToken(participant, issued);
    return new DbRecorder(conn, dir, participant, config.dbName);
  }

  private async watch(lobbyId: number) {
    if (this.subscribed.has(lobbyId)) return;
    await subscribeLobby(this.conn, lobbyId, [
      "lobby",
      "contract",
      "verification",
      "review",
      "participant",
      "delivery",
    ]);
    this.subscribed.add(lobbyId);
  }

  private async must(
    reducer: Parameters<typeof call>[1],
    args: unknown,
  ): Promise<void> {
    const result = await call(this.conn, reducer, args as never, {
      timeoutMs: 10_000,
    });
    if (result.status !== "ok") {
      throw new Error(
        `${String(reducer)}: ${result.status} ${result.error ?? ""}`.trim(),
      );
    }
  }

  async recordVerification(row: VerificationRow) {
    await this.local.recordVerification(row);
    await this.watch(row.lobbyId);
    await this.must("recordVerification", row);
    for (let i = 0; i < 200; i++) {
      const found = [...this.conn.db.verification.iter()].find(
        (v) => v.lobbyId === row.lobbyId && v.reportHash === row.reportHash,
      );
      if (found) return found.id;
      await sleep(25);
    }
    throw new Error("record_verification committed but the row never arrived");
  }

  async recordReview(row: ReviewRow) {
    await this.local.recordReview(row);
    await this.watch(row.lobbyId);
    await this.must("recordReview", row);
  }

  async markVerified(lobbyId: number) {
    await this.must("markVerified", { lobbyId });
  }

  async lobbyBaseSha(lobbyId: number) {
    await this.watch(lobbyId);
    const lobby = [...this.conn.db.lobby.iter()].find((l) => l.id === lobbyId);
    return lobby?.baseSha || undefined;
  }

  async latestVerificationId(lobbyId: number) {
    await this.watch(lobbyId);
    const rows = [...this.conn.db.verification.iter()].filter(
      (v) => v.lobbyId === lobbyId,
    );
    return rows.length ? Math.max(...rows.map((v) => v.id)) : undefined;
  }

  async currentContracts(lobbyId: number) {
    await this.watch(lobbyId);
    return [...this.conn.db.contract.iter()]
      .filter((c) => c.lobbyId === lobbyId && c.current)
      .map((c) => ({
        key: c.key,
        text: c.text,
        source: (c.source === "agreed" ? "agreed" : "aligned") as
          "agreed" | "aligned",
      }));
  }

  async deliveries(lobbyId: number) {
    await this.watch(lobbyId);
    const provider = new Map(
      [...this.conn.db.participant.iter()].map((p) => [p.id, p.provider]),
    );
    return [...this.conn.db.delivery.iter()]
      .filter((d) => d.lobbyId === lobbyId)
      .map((d) => ({
        provider: provider.get(d.targetId) ?? "",
        kind: d.kind,
        queuedAtUs: Number(d.queuedAtUs),
        receivedAtUs: Number(d.receivedAtUs),
        shownAtUs: Number(d.shownAtUs),
      }));
  }

  async dumpLobby(lobbyId: number) {
    const tables = [
      "participant",
      "lobby",
      "plan",
      "planItem",
      "message",
      "job",
      "proposal",
      "response",
      "contract",
      "delivery",
      "event",
      "head",
      "verification",
      "review",
    ] as const;
    await subscribeLobby(this.conn, lobbyId, tables);
    const db = this.conn.db as unknown as Record<
      string,
      { iter(): Iterable<unknown> }
    >;
    return Object.fromEntries(
      tables.map((name) => [
        name,
        [...db[name]!.iter()]
          .map(toJson)
          .filter(
            (row: Record<string, unknown>) =>
              name === "participant" ||
              (name === "lobby" ? row.id : row.lobbyId) === lobbyId,
          ),
      ]),
    );
  }

  close() {
    this.conn.disconnect();
  }
}

export function verificationRow(
  lobbyId: number,
  assembledFrom: AssembledFrom,
  fields: Omit<VerificationRow, "lobbyId" | "assembledFrom">,
): VerificationRow {
  return { lobbyId, assembledFrom: JSON.stringify(assembledFrom), ...fields };
}

/** The verifier's participant name: DIBS_VERIFIER, default "verifier". */
export const verifierName = () => process.env.DIBS_VERIFIER ?? "verifier";

/**
 * The database recorder when this machine joined as the verifier, else local files only.
 * `--local` (or DIBS_RECORD=local) forces local files.
 */
export async function createRecorder(
  resultsDir: string,
  { local = process.env.DIBS_RECORD === "local" }: { local?: boolean } = {},
): Promise<Recorder> {
  if (local) return new LocalRecorder(resultsDir, "--local");
  const participant = verifierName();
  let token: string | undefined;
  try {
    token = await readToken(participant);
  } catch {
    token = undefined;
  }
  if (!token) {
    return new LocalRecorder(
      resultsDir,
      `no token for "${participant}": run dibs join --participant ${participant} ... first`,
    );
  }
  return DbRecorder.open(resultsDir, participant);
}
