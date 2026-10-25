# Project-session CI/CD

`.github/workflows/experience.yml` validates every `real_exp` push and PR into
`real`/`real_exp`. Windows and Linux run workspace typechecks, tests, a pinned
SpacetimeDB 2.13 local server, committed-binding regeneration checks, a populated
legacy-to-new schema upgrade, browser checks, and a relocated installed-package
smoke. A Linux runner builds and smoke-tests the worker/dashboard container.
The isolated database and all its test/package consumers share one step lifetime
and use ephemeral signing keys plus a separate CLI identity configuration.

Deployment only runs for `real_exp`, after both OS checks and container validation
pass. It is opt-in through repository variable `DIBS_EXP_AUTO_DEPLOY=true`, or
**Run workflow → deploy=true**. It never deploys pull-request code. Deployments are
serialized and use the tested commit SHA.

## One-time account-owner setup

The current GitHub identity has repository push access, not admin access. At
implementation time no Actions secrets, variables, or environments were present.
Azure CLI/login is not available in this checkout. These are setup requirements,
not claims that a remote deployment has already happened.

1. Create the GitHub environment **`real-exp`**. Enable Actions for the repository
   if needed. Create a Microsoft Entra application/managed identity with a
   federated credential for issuer `https://token.actions.githubusercontent.com`,
   audience `api://AzureADTokenExchange`, and subject
   `repo:2elliot/dibs:environment:real-exp`.
2. Grant that identity permission to update the experiment Container App and
   push/pull its ACR images. Configure the Container App's pull identity with
   `AcrPull`. Use narrowly scoped resource permissions.
3. Provision a separate experiment app (for example **`dibs-exp`**) with external
   HTTPS ingress to port 8080 and min/max replicas 1/1. Reuse the existing Azure
   Container Apps environment/registry if desired. The workflow updates an
   existing app; it does not create or overwrite the shared `dibs` app.
4. Publish a separate **`dibs-ch13-exp`** database once using the authorized
   publishing identity. Keep that identity for subsequent schema publishing.
   Bootstrap an admin participant and a worker participant on that database using
   the existing `spacetime/README.md` bootstrap steps. Save their separate tokens
   as the environment secrets below. Never reuse a worker identity from another
   database without first claiming its experiment invite.
5. Add these environment secrets (names only; do not put values in source/docs):

   | Secret                    | Purpose                                                        |
   | ------------------------- | -------------------------------------------------------------- |
   | `AZURE_CLIENT_ID`         | Federated Azure deployment identity                            |
   | `AZURE_TENANT_ID`         | Azure directory                                                |
   | `AZURE_SUBSCRIPTION_ID`   | Azure subscription                                             |
   | `SPACETIME_PUBLISH_TOKEN` | CLI publishing identity authorized for the experiment database |
   | `SPACETIME_ADMIN_TOKEN`   | SDK token belonging to its admin participant                   |
   | `SPACETIME_WORKER_TOKEN`  | SDK token belonging to its worker participant                  |
   | `ANTHROPIC_API_KEY`       | Worker model access                                            |

6. Set environment variables:

   | Variable               | Example                                       |
   | ---------------------- | --------------------------------------------- |
   | `SPACETIME_URI`        | `https://maincloud.spacetimedb.com`           |
   | `SPACETIME_DB`         | `dibs-ch13-exp`                               |
   | `AZURE_RESOURCE_GROUP` | `dibs-rg`                                     |
   | `AZURE_CONTAINER_APP`  | `dibs-exp`                                    |
   | `AZURE_ACR_NAME`       | Existing registry name, without `.azurecr.io` |

7. For this unmerged branch, set the **repository** variable
   `DIBS_EXP_AUTO_DEPLOY=true` and push a new `real_exp` commit to trigger its
   validated deployment. Once the workflow also exists on the default branch,
   **Run workflow → real_exp → deploy=true** is available for manual rollout.
   GitHub requires a default-branch workflow for `workflow_dispatch`.
   Environment reviewers, if configured by the owner, still apply.

## What a deployment does

1. Checks required credential names/configuration and rejects targets without a
   separate `-exp` component. It never silently falls back to the shared database.
2. Logs into Azure with OIDC. Installs the pinned SpacetimeDB CLI, logs in using
   the publishing secret, then publishes with **`--delete-data=never`** and
   noninteractive remote/login confirmations only. Breaking migrations fail;
   the workflow never resets a database or automatically approves data loss.
3. Keeps project onboarding disabled during rollout. After the new worker is
   ready and is the only active revision, enables it through an admin-only reducer with ten active
   rooms, twenty creations/day, and one hundred analysis leases/day. Room limit
   is thirty leases and lifetime is 24 hours. The default worker processes at
   most two analyses concurrently. Onboarding remains off on other databases.
4. Builds/pushes the container on the GitHub runner, avoiding the subscription's
   blocked ACR Tasks route. Resolves the pushed **image digest** and deploys that
   immutable reference. Updates Azure secrets through secret references and
   sets the database and tested build SHA.
5. Waits for the deployed SHA/config, dashboard, worker connection and advancing
   heartbeat. Creates a temporary two-party room, publishes conflicting plans,
   waits for a real cloud model proposal, accepts it with scripted clients, and
   confirms the agreed contract. It closes the smoke room afterward. This spends
   a bounded analysis lease; it is explicitly not a native-agent benchmark.
6. Builds an installable tarball whose default endpoint is the **verified** app
   URL, smoke-tests it, and uploads it with `deployment.json` containing the SHA,
   image tag/digest, database, URL, and smoke provenance.

CI also uploads a development tarball. It has no default hosted endpoint; use
`--server` or `DIBS_SERVER`. This prevents an undeployed development build from
silently connecting users to the old shared app.

## Failures and rollback

Database updates are additive in this change: new private tables and reducers,
with existing public row shapes preserved. A failed schema publish stops before
updating Azure. If a later step fails, the workflow fails and retains its logs;
it does not pretend schema and application changes are transactional. Inspect the
last successful deployment manifest and restore its image digest if needed.
Keep additive tables in place; do not use database deletion as rollback. Disable
project onboarding through `configure_projects` if rolling back support for it.

The real `c5f895f` baseline module is published and seeded in the upgrade test,
then updated to this schema without deleting data. Existing identities, lobby,
plan, and benchmark operations are asserted after the upgrade.

References: [Azure OIDC](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect),
[Container Apps GitHub Actions](https://learn.microsoft.com/en-us/azure/container-apps/github-actions),
[SpacetimeDB CLI](https://spacetimedb.com/docs/cli-reference/),
[Codex hooks and native trust](https://learn.chatgpt.com/docs/hooks).
