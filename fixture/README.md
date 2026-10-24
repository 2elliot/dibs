# Study group kickoff

A small Node + Express app: log in, then register for the kickoff event. Plain ESM JavaScript, no build step.

```bash
npm install
npm start          # http://127.0.0.1:4000 (set PORT to change it; PORT=0 picks a free port)
npm test           # node:test, finds test/**/*.js
```

## Layout

| Path                | What                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `src/server.js`     | Starts the app, parses JSON bodies and cookies, mounts the routers at `/api`    |
| `src/data.js`       | Seed users and event, plus the in-memory store                                  |
| `src/auth/`         | Login, the current user, and the helper other routes use (`src/auth/index.js`)  |
| `src/events/`       | Event registration routes                                                       |
| `public/index.html` | The page: Email and Password fields, Log in and Register buttons, a status line |
| `public/app.js`     | The page's logic                                                                |
| `dibs.json`         | Shared interface keys, who owns which files, and the files nobody edits         |

`src/server.js`, `src/data.js`, `public/index.html`, `package.json` and `package-lock.json` are frozen. Dependencies are fixed: `express` and `cookie-parser`.

Seed users: `alice@example.com` / `alice-pass` and `bob@example.com` / `bob-pass`. Seed event: `evt-1`.
