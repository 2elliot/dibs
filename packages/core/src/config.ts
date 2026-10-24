import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DibsConfig {
  supabaseUrl: string;
  supabaseKey: string;
  agentName: string;
  judgeModel: string;
}

// The plugin runs inside whatever repo the agent is working in (the demo repo, not this
// one), so config lives in one place per laptop instead of in a project .env file.
export const CONFIG_FILE = process.env.DIBS_ENV_FILE ?? join(homedir(), ".dibs", ".env");

let cached: DibsConfig | undefined;

export function loadConfig(): DibsConfig {
  if (cached) return cached;
  if (existsSync(CONFIG_FILE)) process.loadEnvFile(CONFIG_FILE);

  const missing = ["DIBS_SUPABASE_URL", "DIBS_SUPABASE_KEY", "DIBS_AGENT_NAME"].filter(
    (key) => !process.env[key],
  );
  if (missing.length > 0) {
    throw new Error(
      `dibs isn't configured: set ${missing.join(", ")} in ${CONFIG_FILE} (see .env.example).`,
    );
  }

  cached = {
    supabaseUrl: process.env.DIBS_SUPABASE_URL!,
    supabaseKey: process.env.DIBS_SUPABASE_KEY!,
    agentName: process.env.DIBS_AGENT_NAME!,
    judgeModel: process.env.DIBS_JUDGE_MODEL ?? "claude-opus-5-5",
  };
  return cached;
}
