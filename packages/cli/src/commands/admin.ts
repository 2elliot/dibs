import { randomBytes } from "node:crypto";
import { options, asParticipant } from "./common.ts";
export async function main(args: string[]) {
  const { values, positionals } = options(args, ["uri", "db", "participant"]);
  const [command, name, provider, role] = positionals;
  if (
    command !== "invite" ||
    !name ||
    !provider ||
    !role ||
    positionals.length !== 4
  )
    throw new Error(
      "usage: dibs admin invite <name> <provider> <role> [--participant admin]",
    );
  const { conn } = await asParticipant(values);
  try {
    const code = randomBytes(24).toString("hex");
    await conn.reducers.createInvite({ name, provider, role, code });
    console.log(code);
  } finally {
    conn.disconnect();
  }
}
