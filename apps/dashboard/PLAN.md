# Dashboard plan

1. Use one `LobbySource` interface for snapshots and row-change subscriptions; implement replay and anonymous read-only SpacetimeDB sources.
2. Treat `docs/plan.md` as authoritative and use protocol-owned export and enum types throughout.
3. Build two typed S2 JSON exports with realistic event times and validate their table envelope against `EventsExport`.
4. Replay snapshots by event timestamp so every panel reflects the selected point in the run.
5. Build the header, timeline, contracts hero, handoff, and scorecard before polishing replay controls.
6. Keep the contracts readable at projector sizes and support light and dark themes without layout shifts.
7. Expose runtime `/config.json`, query overrides, and a clear disconnected state; never call reducers.
8. Validate fixture replay, handshake, oracle, review, build, typecheck, and screenshots with Playwright.
9. Ambiguity: exports contain table snapshots but no guaranteed cross-table history; replay events will reveal rows by their `…AtUs` timestamps and events by `atUs`.
10. After `[sim-ready]`, attempt the local simulator only against the issue 5 database; if the CLI guard rejects that namespace, record the exact failure and stop without using another issue's database.
11. For the projector, keep Contracts as the default §12 view and add a one-click Handoff + Scorecard view so both are visible at 1920×1080 without scrolling.
12. The simulator guard may still reject `dibs-i5-sim`; follow CLAUDE.md's issue database namespace and report the exact guard error rather than use another issue's database.
