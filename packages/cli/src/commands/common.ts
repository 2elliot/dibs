import { parseArgs } from "node:util";
import { connect, type DbConnection } from "@dibs/client";
import { readConfig, readToken, saveToken } from "@dibs/client/node";
import { setGlobalLogLevel } from "spacetimedb";
setGlobalLogLevel("error");

export function options(args: string[], keys: readonly string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(
      keys.map((key) => [key, { type: "string" as const }]),
    ),
  });
}
export function required(
  values: Record<string, string | boolean | undefined>,
  key: string,
): string {
  const value = values[key];
  if (typeof value !== "string" || !value)
    throw new Error(`--${key} is required`);
  return value;
}
export function id(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 0xffffffff)
    throw new Error("a positive u32 lobby id is required");
  return Number(value);
}
export async function configured(
  values: Record<string, string | boolean | undefined>,
) {
  let config: { dbUri: string; dbName: string } | undefined;
  try {
    config = await readConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const uri =
    typeof values.uri === "string"
      ? values.uri
      : (config?.dbUri ?? "http://127.0.0.1:3000");
  const dbName = typeof values.db === "string" ? values.db : config?.dbName;
  if (!dbName) throw new Error("set --db or run dibs join first");
  return { uri, dbName };
}
export async function asParticipant(
  values: Record<string, string | boolean | undefined>,
  fallback = "admin",
) {
  const name =
    typeof values.participant === "string" ? values.participant : fallback;
  const config = await configured(values);
  const token = await readToken(name);
  if (!token) throw new Error(`no saved token for ${name}; run dibs join`);
  const connection = await connect({ ...config, token });
  await saveToken(name, connection.token);
  return connection;
}
export async function waitFor<T>(
  read: () => T | undefined | false | null,
  timeoutMs = 10000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  do {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < end);
  throw new Error("timed out waiting for committed rows");
}
export async function all(conn: DbConnection) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("subscription timed out")),
      10000,
    );
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve();
      })
      .onError((ctx) => {
        clearTimeout(timer);
        reject(ctx.event);
      })
      .subscribeToAllTables();
  });
}
