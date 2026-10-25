// Ephemeral local-test signing keys, never deployment/user credentials.
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw new Error("Pass the isolated CI data directory.");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const pair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
fs.writeFileSync(path.join(directory, "test-jwt-public.pem"), pair.publicKey);
fs.writeFileSync(
  path.join(directory, "test-jwt-private.pem"),
  pair.privateKey,
  { mode: 0o600 },
);
