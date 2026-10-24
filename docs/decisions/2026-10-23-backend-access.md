# Supabase with no auth, config in ~/.dibs/.env

Lane: core · Date: 2026-10-23

The backend is one Supabase project for the team, holding the data, realtime and pgvector. Auth is on the cut list, so RLS is off and every client uses the publishable key. Don't reuse the project for anything real.

The plugin runs inside whatever repo the agent works in (the demo repo), so it reads config from `~/.dibs/.env` on each laptop (override with `DIBS_ENV_FILE`), not from a project `.env`. Keys: `DIBS_SUPABASE_URL`, `DIBS_SUPABASE_KEY`, `DIBS_AGENT_NAME`, `ANTHROPIC_API_KEY`, and optionally `DIBS_JUDGE_MODEL`.

The overlap judge defaults to `claude-opus-5-5`. If latency matters during the demo, try `claude-haiku-5-5` and compare the verdicts first.
