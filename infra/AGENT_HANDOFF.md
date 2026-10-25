# Dibs deployment handoff

Last updated: October 24, 2026, 5:40 PM Pacific, after redeploying the worker from `real`. Azure is
deployed and healthy.

## Current result

Dashboard: https://dibs.grayriver-bbcb643c.westus2.azurecontainerapps.io

Azure subscription: 2836579d-9887-4417-b38e-3413cc055517
Tenant: 0d5d4a8a-e234-4943-a608-5577907502a8
Resource group: dibs-rg
Region: westus2
Container Apps environment: dibs-env
Container App: dibs (single-revision mode)
Ready revision: dibs--0000001
Registry: dibs2836579d9887.azurecr.io
Image: dibs:real-e7806ad8f05c
Image digest: sha256:0ea9d63ca41a4f517b59926a1debf0bd61ee4ad6d2b4e963d910920999f916c1
Source: `real` at e7806ad8f05cdb337bbb4d5dc10c7c5bafe011f8 (all five issues merged, through PR #20)
Replica limits: min 1 / max 1; 0.25 CPU, 0.5 GiB.
Database: Maincloud dibs-ch13-dev
Worker participant name and role: worker / worker
Model: claude-sonnet-4-6

Rollback target: image dibs:dev-cc5b29745f76151b (sha256:811aa562e78444d2d62bd9fb2719ac5e13c6ebdd8544bf76de8c9056682d94fd),
the previous revision dibs--wqnc6fp, still in ACR. Roll back with the same `containerapp update --image` as below.

Verified after the update (00:39 UTC): the new revision is Healthy with 100% of traffic; /health/live
returns live; /health/status reports the database connected and zero Anthropic errors; /config.json
points to dibs-ch13-dev; the dashboard and its JavaScript asset return 200 from the new build; the
worker participant is online and its service heartbeat is current. See azure-verification.json.

This image adds lease-on-sight (a queued job is leased from the row update instead of the 15 s
rescan) and citation repair (invalid citations are removed and valid findings submitted; unusable
output no longer counts as an Anthropic error). No real analysis job has run on it yet. The previous
image ran real analyses for lobbies 1 and 3 (see LOBBY3_REPORT.md).

## Next work

1. Lobby 4, the next two-machine attempt (E2E_RUNBOOK.md). It waits on Ren Jie's Stop hook change
   (keep agents running until every peer has a plan) and a tested Codex launch path. During it,
   confirm the new worker leases within a second of `job_queued`.
2. Demo cutover, when issue 1 publishes `dibs-ch13-demo`: claim a worker invite on it with the
   worker's existing token, then `containerapp update --set-env-vars SPACETIME_DB=dibs-ch13-demo`
   (deploy.md §4).
3. The dashboard's "Analysis online" badge reads a `service` row named `analysis`; the worker can
   only write `worker`. That needs a dashboard change (issue 5).

The user owns the Azure subscription and is a collaborator on the Maincloud database. The worker's
invite was redeemed; no new worker invite is needed for dibs-ch13-dev.

## Workspace and tools

Workspace: C:\Users\lib_laptop\Documents\Codex\2026-10-24\github-plugin-github-openai-curated-remote
Use work/azure-deploy/az.ps1 for Azure CLI commands; it keeps the isolated signed-in profile in
work/azure-deploy/azure-config. No system Azure installation is needed. It sets `Stop`, so an `az`
warning on stderr makes it exit 1 even when the command succeeded: read the JSON result.
crane: work/azure-tools/crane/crane.exe (Google crane 0.22.1, checked against release checksums).
Node: C:\Users\lib_laptop\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
(no npm next to it; npm 12 lives under work/issue3-review/tooling).
Python: C:\Users\lib_laptop\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
Spacetime CLI: C:\Users\lib_laptop\AppData\Local\SpacetimeDB\spacetime.exe. Its login is not a Dibs
admin. This laptop holds the `admin` and `claude` participants in ~/.dibs (dibs CLI tokens).

## Updating the deployed image

The subscription blocks ACR Tasks (TasksOperationsNotAllowed) and Docker/WSL aren't installed, so
images are assembled with crane: the base `dibs-base:node24-slim` (imported once into ACR with
`az acr import`) plus one app layer. The scripts are in `infra/azure/`:

1. In a checkout of the `real` commit: `npm ci`, then `npm run build -w @dibs/dashboard`.
2. `node infra/azure/bundle.mjs <checkout> <imageRoot> <full sha>` bundles the worker into
   `app/apps/worker/src/index.mjs` and copies the dashboard build. It prints the tag
   (`real-<sha12>`).
3. `python -I infra/azure/make_layer.py <imageRoot> <app-layer.tar.gz>` packs the layer.
4. Optional local smoke: run `node apps/worker/src/index.mjs` in `<imageRoot>/app` with `PORT` set and
   `SPACETIME_URI` pointing at an unused local port, then check /health/live, / and /config.json.
5. `.\infra\azure\push-image.ps1 -Layer <app-layer.tar.gz> -Tag real-<sha12> -Work <workspace>\work`
   pushes the image and prints its digest, OS, arch, command and user.
6. `az.ps1 containerapp update -n dibs -g dibs-rg --image dibs2836579d9887.azurecr.io/dibs:real-<sha12>`.
   Only the image changes; secrets, env vars, scale and registry settings stay. Wait for the new
   revision to be Healthy at 100% traffic, then run the checks above.

Windows PowerShell 5.1 corrupts a password written to a native program's stdin: a pipe appends CRLF,
and `Process` stdin adds a UTF-8 BOM from the console input encoding. Either makes crane store a wrong
password, and ACR then answers "UNAUTHORIZED: authentication required". push-image.ps1 writes it
without either.

outputs/deploy-dibs-azure.ps1 records the original first deployment. It creates a new app and refuses
to overwrite an existing one, so don't use it for updates.

## Credentials and browser limitations

Credentials are outside source/build archives in work/azure-deploy/private. AnthropicKey.protected and
WorkerInvite.protected use Windows DPAPI for this Windows account. worker.token is the claimed worker
identity token in the access-restricted folder. Never print these or put them into chat, source
control, reports, or images. Azure runtime uses secrets and secret references. Registry credentials
reach crane only over stdin, and crane logs out after each push. Invite codes for teammates are kept
in ~/.dibs/handoff and sent privately, never through GitHub.

Local HTTP preview processes may still be running on ports 4130 and 4131; cloud hosting does not
depend on them. The shared local SpacetimeDB on port 3000 went down under memory pressure on this
laptop; it isn't needed for the Azure deployment.

The in-app browser loses its GitHub sign-in between sessions; Firefox Computer Use was blocked by
browser URL policy. CLI/API checks work.

## Related artifacts

In the workspace's outputs folder:

- azure-deployment.json: current image, digest, revision and rollback target, no credentials
- azure-deployment.previous.json: the previous deployment record
- azure-setup-status.md, azure-heartbeat-verification.txt: the first deployment's reports
- issue-3-verification-report.md: earlier worker review/fix report

In this folder: azure-verification.json (latest cloud checks), E2E_RUNBOOK.md (two-machine lobby),
LOBBY3_REPORT.md (first shared-DB lobby), deploy.md (first-time deployment and cutover).
