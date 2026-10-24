// Writing verification and review rows. Until issue 1's [module-ready] milestone there is no
// @dibs/client to call `record_verification` / `record_review` with, so the reducer arguments
// are written to bench/results/<lobbyId>/ instead and replayed into the DB after the merge.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssembledFrom, ReviewKind } from "@dibs/protocol";

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

export interface Recorder {
  /** Returns the new verification id, or null when only written locally. */
  recordVerification(row: VerificationRow): Promise<number | null>;
  recordReview(row: ReviewRow): Promise<void>;
  markVerified(lobbyId: number): Promise<void>;
  readonly description: string;
}

/** Writes the reducer arguments next to the report; nothing reaches the database. */
export class LocalRecorder implements Recorder {
  readonly description =
    "local only (record_verification/record_review wait for issue 1's [module-ready])";
  constructor(private readonly dir: string) {}

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
}

export function verificationRow(
  lobbyId: number,
  assembledFrom: AssembledFrom,
  fields: Omit<VerificationRow, "lobbyId" | "assembledFrom">,
): VerificationRow {
  return { lobbyId, assembledFrom: JSON.stringify(assembledFrom), ...fields };
}

/**
 * The recorder `dibs verify` / `dibs review` use. Phase B (after [module-ready]) adds a
 * DbRecorder here that connects with the verifier's token through @dibs/client.
 */
export async function createRecorder(resultsDir: string): Promise<Recorder> {
  return new LocalRecorder(resultsDir);
}
