-- dibs schema v0. Mirrors the row types in packages/shared/src/index.ts; change both together.
-- Apply by pasting into the Supabase SQL editor, or with `npx supabase db push` once linked.

create extension if not exists vector;

create table agents (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,          -- Claude Code session id
  name text not null,                       -- whose agent this is, e.g. "elliot"
  repo text,                                -- repo the agent is working in
  status text not null default 'active' check (status in ('active', 'idle', 'gone')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table intents (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (id) on delete cascade,
  title text not null,
  description text not null,
  interfaces jsonb not null default '[]',
  files text[] not null default '{}',
  -- No fixed dimension until the core lane picks an embedding model. Fine without an
  -- index at hackathon scale (tens of rows).
  embedding vector,
  status text not null default 'active'
    check (status in ('active', 'blocked', 'delivered', 'abandoned')),
  overlaps_intent_id uuid references intents (id),
  verdict text check (verdict in ('duplicate', 'partial', 'independent')),
  created_at timestamptz not null default now()
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  owner_intent_id uuid not null references intents (id) on delete cascade,
  consumer_intent_id uuid not null references intents (id) on delete cascade,
  interface text not null default '',
  requirements jsonb not null default '[]',
  stub_path text,
  test_path text,
  status text not null default 'proposed'
    check (status in ('proposed', 'agreed', 'delivered', 'verified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  from_agent_id uuid references agents (id) on delete cascade,
  to_agent_id uuid not null references agents (id) on delete cascade,
  contract_id uuid references contracts (id) on delete cascade,
  kind text not null
    check (kind in ('overlap', 'request', 'proposal', 'accept', 'delivered', 'info')),
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index messages_inbox on messages (to_agent_id) where read_at is null;

-- Nearest active intents from other agents, for the semantic overlap check.
create function match_intents(
  query_embedding vector,
  exclude_agent_id uuid,
  match_threshold float default 0.75,
  match_count int default 5
)
returns table (id uuid, agent_id uuid, title text, description text, similarity float)
language sql stable
as $$
  select i.id, i.agent_id, i.title, i.description,
         1 - (i.embedding <=> query_embedding) as similarity
  from intents i
  where i.status = 'active'
    and i.embedding is not null
    and i.agent_id <> exclude_agent_id
    and 1 - (i.embedding <=> query_embedding) > match_threshold
  order by i.embedding <=> query_embedding
  limit match_count;
$$;

-- The dashboard and the agents' inboxes subscribe to changes on every table.
alter publication supabase_realtime add table agents, intents, contracts, messages;

-- No auth for the hackathon (see docs/decisions/2026-10-23-backend-access.md), so RLS stays
-- off and the publishable key can read and write everything. Don't reuse this project for
-- anything real.
