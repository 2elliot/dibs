// The oracle at rest: the plaintext folder (oracle.test.mjs + references) as one canonical JSON
// bundle, gzipped and encrypted with AES-256-GCM. `oracleHash` is the SHA-256 of the plaintext
// bundle, so anyone can check the plaintext oracle published at 22:45 against it.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { dibsHome } from "./paths.ts";

const FORMAT = "dibs-oracle-v1";

export interface SealedOracle {
  format: typeof FORMAT;
  cipher: "aes-256-gcm";
  oracleHash: string;
  iv: string;
  tag: string;
  data: string;
}

export const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export const defaultKeyFile = () => join(dibsHome(), "oracle.key");

function parseKey(hex: string, from: string): Buffer {
  const trimmed = hex.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error(`The oracle key in ${from} must be 64 hex characters`);
  }
  return Buffer.from(trimmed, "hex");
}

/** DIBS_ORACLE_KEY (64 hex), else DIBS_ORACLE_KEY_FILE, else <DIBS_HOME>/oracle.key. */
export function loadKey(): Buffer {
  if (process.env.DIBS_ORACLE_KEY) {
    return parseKey(process.env.DIBS_ORACLE_KEY, "DIBS_ORACLE_KEY");
  }
  const file = process.env.DIBS_ORACLE_KEY_FILE ?? defaultKeyFile();
  if (!existsSync(file)) {
    throw new Error(
      `No oracle key: set DIBS_ORACLE_KEY or put it in ${file} (only M3 has it)`,
    );
  }
  return parseKey(readFileSync(file, "utf8"), file);
}

/** For packing: the existing key, or a new one written to <DIBS_HOME>/oracle.key (mode 600). */
export function loadOrCreateKey(): { key: Buffer; created?: string } {
  try {
    return { key: loadKey() };
  } catch (error) {
    if (process.env.DIBS_ORACLE_KEY || process.env.DIBS_ORACLE_KEY_FILE) {
      throw error;
    }
    const file = defaultKeyFile();
    if (existsSync(file)) throw error;
    const hex = randomBytes(32).toString("hex");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${hex}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows: mode bits don't apply.
    }
    return { key: Buffer.from(hex, "hex"), created: file };
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** The plaintext folder as canonical bytes: sorted forward-slash paths, base64 contents. */
export function bundle(dir: string): Buffer {
  const files = Object.fromEntries(
    listFiles(dir)
      .map(
        (path) =>
          [
            relative(dir, path).split("\\").join("/"),
            readFileSync(path).toString("base64"),
          ] as const,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  if (!files["oracle.test.mjs"]) {
    throw new Error(`${dir} has no oracle.test.mjs`);
  }
  return Buffer.from(JSON.stringify({ format: FORMAT, files }));
}

export function seal(plain: Buffer, key: Buffer): SealedOracle {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return {
    format: FORMAT,
    cipher: "aes-256-gcm",
    oracleHash: sha256(plain),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Encrypts `dir` into `encPath` (+ `<encPath without .enc>.hash`). Returns the oracle hash. */
export function pack(dir: string, encPath: string, key: Buffer): string {
  const sealed = seal(bundle(dir), key);
  writeFileSync(encPath, `${JSON.stringify(sealed)}\n`);
  writeFileSync(encPath.replace(/\.enc$/, ".hash"), `${sealed.oracleHash}\n`);
  return sealed.oracleHash;
}

export function readSealedHash(encPath: string): string {
  return (JSON.parse(readFileSync(encPath, "utf8")) as SealedOracle).oracleHash;
}

/** Decrypts `encPath`, checks the hash, writes the plaintext files into `outDir`. Returns the hash. */
export function unpack(
  encPath: string,
  outDir: string,
  key: Buffer,
  expectedHash?: string,
): string {
  const sealed = JSON.parse(readFileSync(encPath, "utf8")) as SealedOracle;
  if (sealed.format !== FORMAT) {
    throw new Error(`Unknown oracle format ${String(sealed.format)}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  let plain: Buffer;
  try {
    plain = gunzipSync(
      Buffer.concat([
        decipher.update(Buffer.from(sealed.data, "base64")),
        decipher.final(),
      ]),
    );
  } catch {
    throw new Error(
      "Couldn't decrypt the oracle: wrong key, or oracle.enc was changed",
    );
  }
  const hash = sha256(plain);
  if (hash !== sealed.oracleHash) {
    throw new Error("Oracle hash mismatch after decryption");
  }
  if (expectedHash && hash !== expectedHash) {
    throw new Error(`Oracle hash ${hash} isn't the expected ${expectedHash}`);
  }
  const { files } = JSON.parse(plain.toString()) as {
    files: Record<string, string>;
  };
  for (const [path, content] of Object.entries(files)) {
    if (path.includes("..")) throw new Error(`Bad path in oracle: ${path}`);
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(content, "base64"));
  }
  return hash;
}
