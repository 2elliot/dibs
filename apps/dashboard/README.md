# dibs dashboard

Big screen view for a single dibs lobby. The dashboard reads exported protocol tables through one `LobbySource`; replay and live mode feed the same panels. Live mode subscribes anonymously and read-only and never invokes reducers.

## Replay

From the repository root, run `npm run dev -w @dibs/dashboard`. Vite serves the app at `http://localhost:4150`. The default is the bundled `s2-dibs` replay. Load another export with `?replay=/fixtures/s2-none.json`; any URL returning a valid `EventsExport` JSON can be used. Replay playback, stepping, scrubbing, and speed controls update all panels at the selected event time. Every replay carries a visible REPLAY label.

The Contracts tab is the default demo view. Select **Handoff + Scorecard** to fit the assembled heads, merge tree, oracle, review, and run scorecard together on a projector.

## Live

Serve the static `dist` build alongside a runtime `/config.json` containing:

```json
{ "uri": "http://127.0.0.1:3000", "db": "dibs-i5-sim", "lobby": 1 }
```

The connection is anonymous and read-only. For local development, values can be overridden with `?uri=ws%3A%2F%2F127.0.0.1%3A3000&db=dibs-i5-sim&lobby=1`. With no connection details, the bundled replay remains available; a connection failure displays a clear status message and leaves the UI running.

Build static files with `npm run build -w @dibs/dashboard`; output is `apps/dashboard/dist`. The worker or another static host can serve that directory and provide `/config.json` at runtime.

## Checks

`npm run typecheck -w @dibs/dashboard` typechecks the app and fixture exports. `npm run test -w @dibs/dashboard` runs the Playwright replay checks and writes 1920×1080 screenshots to `apps/dashboard/screenshots/`.
