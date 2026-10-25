# Deploying the worker + dashboard (Azure Container Apps)

One Container App runs the analysis worker, serves the dashboard static files, `/config.json`, and
the health endpoints. **These are human steps** (Azure login, the Anthropic key, the worker token).
Write/run them yourself; the agent does not run them.

Plan references: `docs/plan.md` §8. Image must be **linux/amd64**. Secret names ≤ 20 chars. Point at
the **dev** DB until the 16:00 cutover, then flip `SPACETIME_DB`.

The app now exists. To ship a new build without ACR Tasks or Docker, use the crane-based scripts in
`infra/azure/` as described in `AGENT_HANDOFF.md` ("Updating the deployed image").

## 0. Build the image

```bash
# From the repo root. BuildKit also applies infra/Dockerfile.dockerignore.
DOCKER_BUILDKIT=1 docker build -f infra/Dockerfile --platform linux/amd64 -t dibs:local .
# Smoke test locally (worker serves health + config; loop stays idle without a token):
docker run --rm -p 4130:8080 -e PORT=8080 dibs:local
curl -s localhost:4130/health/live && curl -s localhost:4130/config.json
```

## 1. First deploy (dev DB)

```bash
az extension add -n containerapp --upgrade
az provider register -n Microsoft.App
az provider register -n Microsoft.OperationalInsights
az group create -n dibs-rg -l westus2
# Build this exact Dockerfile from the repository root, then deploy the image.
# `az containerapp up --source .` would search for a root Dockerfile, not infra/Dockerfile.
az acr create -n <acr> -g dibs-rg --sku Basic --admin-enabled true
az acr build -r <acr> -f infra/Dockerfile --platform linux/amd64 -t dibs:<sha> .
az acr credential show -n <acr>
az containerapp up -n dibs -g dibs-rg -l westus2 --environment dibs-env \
  --image <acr>.azurecr.io/dibs:<sha> --registry-server <acr>.azurecr.io \
  --registry-username <user> --registry-password <pass> --ingress external --target-port 8080
```

If ACR cloud builds are blocked (`TasksOperationsNotAllowed` on trial/student credits), build locally
and push to a registry instead:

```bash
az acr create -n <acr> -g dibs-rg --sku Basic --admin-enabled true && az acr login -n <acr>
docker buildx build -f infra/Dockerfile --platform linux/amd64 -t <acr>.azurecr.io/dibs:<sha> --push .
az acr credential show -n <acr>        # username + password for the next command
az containerapp up -n dibs -g dibs-rg --environment dibs-env \
  --image <acr>.azurecr.io/dibs:<sha> --registry-server <acr>.azurecr.io \
  --registry-username <user> --registry-password <pass> --ingress external --target-port 8080
```

## 2. Secrets + env (and the scale fix)

```bash
az containerapp secret set -n dibs -g dibs-rg --secrets anthropic-key=<key> stdb-token=<token>
# `up` leaves scale-to-zero on, which would stop the worker. Pin one replica:
az containerapp update -n dibs -g dibs-rg --min-replicas 1 --max-replicas 1 \
  --set-env-vars ANTHROPIC_API_KEY=secretref:anthropic-key SPACETIME_TOKEN=secretref:stdb-token \
  SPACETIME_URI=https://maincloud.spacetimedb.com SPACETIME_DB=dibs-ch13-dev ANTHROPIC_MODEL=<id>
```

For a default live lobby, also set `DIBS_LOBBY_ID=<id>`; otherwise open the dashboard with
`?lobby=<id>`. `/config.json` supplies both protocol and dashboard field names.

Changing a secret needs a revision restart. Always pass the same `--environment`.

## 3. Logs / health

```bash
az containerapp logs show -n dibs -g dibs-rg --follow     # add --type system for crashes
```

- Probe target is `/health/live` only (default TCP probe is fine).
- `/health/status` is diagnostics (DB connection, queue age, last latency, Anthropic errors), NOT a
  probe — with one replica a Maincloud blip would otherwise 503 the dashboard.

## 4. 16:00 cutover

Flip the DB without a rebuild:

```bash
az containerapp update -n dibs -g dibs-rg --set-env-vars SPACETIME_DB=dibs-ch13-demo
```

## Fallback

If Azure is down: `npm run start -w @dibs/worker` on a laptop with the same env vars. Agents and the
dashboard talk to SpacetimeDB directly, so only hosting moves.

## Env vars (reference)

| Var                 | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `PORT`              | HTTP port (container 8080; local 4130).                                     |
| `SPACETIME_URI`     | `https://maincloud.spacetimedb.com` in prod; `http://127.0.0.1:3000` local. |
| `SPACETIME_DB`      | `dibs-ch13-dev` then `dibs-ch13-demo`.                                      |
| `SPACETIME_TOKEN`   | Worker identity token (secret). Loop stays idle if unset.                   |
| `ANTHROPIC_API_KEY` | Secret. Without it the loop can only run the deterministic/fake path.       |
| `ANTHROPIC_MODEL`   | Model id confirmed at 08:45.                                                |
