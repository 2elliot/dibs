# Project API extension (`real_exp`)

This additive extension is authorized by the `real_exp` implementation request.
The benchmark API in `docs/API.md` remains supported. Existing public tables and
rows are unchanged; generated clients add the reducers below. Project state is
identified by a private `project_room` entry and public `lobby.buildHash` equal to
`project-v1`. That marker is protocol metadata, not a membership credential.

## Private state

- `project_room`: lobby ID, unique 192-bit client-generated capability, owner
  identity, canonical creation payload for identity-bound retries.
- `project_member`: permanent `(lobby, provider)` seat, unique identity and
  participant ID. One Claude and one Codex seat per room.
- `project_settings`: operator enable switch, active/daily creation limits,
  daily lease budget and current counters. Absent/disabled means no onboarding.

Capabilities never enter public events, request payloads, or client subscriptions.
Existing public plans/messages/contracts remain demo-trust public data.

## Reducers

| Reducer                                                                     | Authorization and behavior                                                                                                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configure_projects(enabled,maxActiveRooms,maxRoomsPerDay,maxLeasesPerDay)` | Admin only; changes bounded aggregate budgets while retaining today's counters.                                                                                                                     |
| `create_project(code,provider,brief,vocabularyJson,protocol)`               | New identity; atomically creates a running 24-hour room and binds the first seat. Identical semantic input by the same identity recovers the existing result without another room or budget charge. |
| `join_project(code,provider,protocol)`                                      | Valid capability, supported protocol and available provider seat; repeating with the same identity recovers its seat.                                                                               |
| `resume_project(lobbyId,protocol)`                                          | Existing identity-bound member only; no capability replay, no legacy join fallback.                                                                                                                 |
| `leave_project(lobbyId)`                                                    | Existing member detaches; the seat remains permanently reserved to its identity.                                                                                                                    |
| `close_project(lobbyId)`                                                    | Creator only; stops the room and rejects subsequent coordination writes/analysis.                                                                                                                   |

`join_lobby` rejects both project-room targets and project identities. This keeps
anonymous project onboarding from bypassing the benchmark's invite boundary.
Expiry is checked directly on agent and worker writes, as well as scheduled stop.
The bridge observes local detachment and stops reconnecting that attachment.

Project rooms use the existing negotiation/worker jobs. The room cap is 30 leases;
the server also enforces its global daily lease budget. Refused project leases
commit a failed job plus explicit unavailable notices rather than leaving a job
queued forever. The worker checks that it actually received the lease before
calling a model. Failed leases have retry cooldowns, and concurrency is bounded.

The CLI's per-project/provider mutation lock, saved pre-reducer identity token,
semantic create idempotence, and write-ahead configuration journal cover recovery
after ambiguous calls or interrupted local setup. No Git changes are required.
Native trust remains a user decision. Hook delivery and Stop behavior are tested
separately from real native-agent discovery and code-compliance evidence.
