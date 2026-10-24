"use client";

import { useEffect, useState } from "react";
import { TABLES, type Agent, type Intent } from "@dibs/shared";
import { supabase } from "@/lib/supabase";

// TODO(demo lane): overlap alerts, negotiation threads, contract status. This only proves
// the realtime wiring end to end.
export function LiveBoard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [intents, setIntents] = useState<Intent[]>([]);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    async function load() {
      const [a, i] = await Promise.all([
        client.from(TABLES.agents).select("*").order("created_at"),
        client.from(TABLES.intents).select("*").order("created_at"),
      ]);
      if (a.data) setAgents(a.data as Agent[]);
      if (i.data) setIntents(i.data as Intent[]);
    }

    load();
    const channel = client
      .channel("dashboard")
      .on("postgres_changes", { event: "*", schema: "public" }, () => load())
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, []);

  if (!supabase) {
    return (
      <p>Not connected: copy dashboard/.env.example to dashboard/.env.local and fill it in.</p>
    );
  }

  return (
    <section>
      <h2>Agents</h2>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id}>
            {agent.name} ({agent.status})
          </li>
        ))}
      </ul>
      <h2>Intents</h2>
      <ul>
        {intents.map((intent) => (
          <li key={intent.id}>
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
