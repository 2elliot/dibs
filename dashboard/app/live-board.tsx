"use client";

import { useMemo } from "react";
import { SpacetimeDBProvider, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "@dibs/shared";

const uri = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "https://maincloud.spacetimedb.com";
const database = process.env.NEXT_PUBLIC_SPACETIME_DB;

export function LiveBoard() {
  const connectionBuilder = useMemo(
    () => (database ? DbConnection.builder().withUri(uri).withDatabaseName(database) : null),
    [],
  );

  if (!connectionBuilder) {
    return (
      <p>Not connected: copy dashboard/.env.example to dashboard/.env.local and fill it in.</p>
    );
  }

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <Board />
    </SpacetimeDBProvider>
  );
}

// TODO(demo lane): overlap alerts, negotiation threads, contract status. This only proves
// the realtime wiring end to end.
function Board() {
  const [agents] = useTable(tables.agent);
  const [intents] = useTable(tables.intent);

  return (
    <section>
      <h2>Agents</h2>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id.toString()}>
            {agent.name} · {agent.kind} ({agent.status})
          </li>
        ))}
      </ul>
      <h2>Intents</h2>
      <ul>
        {intents.map((intent) => (
          <li key={intent.id.toString()}>
            {intent.title}
            {intent.verdict && intent.verdict !== "independent"
              ? ` · overlap: ${intent.verdict}`
              : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
