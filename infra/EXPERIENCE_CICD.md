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

> [!WARNING]
> **Every push to `real_exp` wipes the experiment database.** Each deploy
> deletes all data in `dibs-ch13-exp` (rooms, join codes, plans, contracts)
> and recreates it with the new schema. Anyone testing at the time loses their
> room and has to run `dibs leave --local`, then `dibs create` or `dibs join`
> again. Avoid pushing during a test session, or pause deploys with
> `DIBS_EXP_AUTO_DEPLOY=false`. To keep data, set the `real-exp` environment
> variable `SPACETIME_DELETE_DATA` to `on-conflict` (wipe only on breaking
> schema changes) or `never`.

## Isolation from the shared project

The experiment is a separate Azure project. It shares nothing with the existing
deployment in `infra/AGENT_HANDOFF.md` (`dibs-rg`, `dibs-env`, registry
`dibs2836579d9887`, app `dibs`, databases `dibs-ch13-dev`/`dibs-ch13-demo`):

| Layer             | Experiment                                  | Guard                                                                |
| ----------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Git               | only `real_exp` deploys                     | job `if:` on the ref, plus the environment's branch policy           |
| GitHub            | environment `real-exp` holds every secret   | other branches' jobs can't read environment secrets                  |
| Azure login       | its own managed identity                    | federated subject `repo:2elliot/dibs:environment:real-exp`           |
| Azure permissions | `Contributor` on `dibs-exp-rg` only         | the identity can't see or change `dibs-rg`                           |
| Azure resources   | own resource group, registry, env and app   | `deploy-preflight.mjs` refuses shared names and requires `exp` names |
| SpacetimeDB       | own `dibs-ch13-exp` database and identities | preflight requires `-exp`; only this database is ever wiped          |

## One-time setup (account owner's laptop)

Run this once, top to bottom, on the laptop of the person who owns the GitHub
repository and the Azure subscription. It takes about 20 minutes. Commands are
bash: macOS/Linux terminal, or **Git Bash** on Windows. Every value you need
later is kept in shell variables, so run all the steps in one terminal window.

**The owner** signs into GitHub, Azure and SpacetimeDB; their SpacetimeDB
account owns the new experiment database. Whoever provides the Anthropic API key
in step 5 pays for the worker's model usage.

### 0. Prerequisites

Install `git`, Node 24, the [GitHub CLI](https://cli.github.com), the
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and the
[SpacetimeDB CLI](https://spacetimedb.com/install). Then:

```sh
# Windows Git Bash only: stop MSYS rewriting /subscriptions/... scopes into file paths.
export MSYS_NO_PATHCONV=1

spacetime version install 2.13.0 && spacetime version use 2.13.0
spacetime --version            # must report 2.13.x

gh auth login                  # as the repository owner
gh api repos/2elliot/dibs --jq .permissions.admin   # must print true

az login
az account list -o table       # pick the subscription for the experiment
az account set --subscription <subscription-id>

git clone https://github.com/2elliot/dibs.git dibs-exp-setup   # or reuse a checkout
cd dibs-exp-setup
git switch real_exp && git pull --ff-only
npm ci
```

A separate subscription is the strongest isolation. The same subscription is
also fine: everything below lives in its own resource group, and the deploy
identity has no access outside it.

### 1. Names

```sh
REPO=2elliot/dibs
LOCATION=westus2
RG=dibs-exp-rg
ENV_NAME=dibs-exp-env
APP=dibs-exp
ACR=dibsexp$(openssl rand -hex 4)       # globally unique, alphanumeric only
IDENTITY=dibs-exp-github
DB=dibs-ch13-exp
STDB=https://maincloud.spacetimedb.com
SETUP=$HOME/.dibs-exp-setup             # private scratch folder; deleted in step 7
mkdir -p "$SETUP" && chmod 700 "$SETUP"
echo "registry: $ACR"
```

Keep the `-exp`/`exp` parts of these names; the deploy preflight refuses anything
else.

### 2. Azure resources

```sh
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az provider register --namespace Microsoft.ContainerRegistry --wait

az group create --name $RG --location $LOCATION
az acr create --name $ACR --resource-group $RG --sku Basic --admin-enabled false
az containerapp env create --name $ENV_NAME --resource-group $RG --location $LOCATION

# The workflow only updates an existing app, so create it with a placeholder image.
az containerapp create --name $APP --resource-group $RG --environment $ENV_NAME \
  --image mcr.microsoft.com/k8se/quickstart:latest \
  --ingress external --target-port 80 --min-replicas 1 --max-replicas 1 \
  --system-assigned

# Let the app pull from the experiment registry with its own identity.
ACR_ID=$(az acr show --name $ACR --query id -o tsv)
APP_PRINCIPAL=$(az containerapp show --name $APP --resource-group $RG --query identity.principalId -o tsv)
az role assignment create --assignee-object-id $APP_PRINCIPAL \
  --assignee-principal-type ServicePrincipal --role AcrPull --scope $ACR_ID
az containerapp registry set --name $APP --resource-group $RG \
  --server $ACR.azurecr.io --identity system

# The dibs image listens on 8080. The placeholder is unhealthy from here until
# the first deployment replaces it; that's expected.
az containerapp ingress update --name $APP --resource-group $RG --target-port 8080
```

If the subscription refuses the role assignment, the account lacks `Owner` or
`User Access Administrator` on it; sign in with an account that has it.

### 3. Azure login for GitHub Actions

A user-assigned managed identity with a federated credential. No password or
client secret exists anywhere, and only the `real-exp` environment can use it.

```sh
az identity create --name $IDENTITY --resource-group $RG --location $LOCATION
az identity federated-credential create --name github-real-exp \
  --identity-name $IDENTITY --resource-group $RG \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:$REPO:environment:real-exp \
  --audiences api://AzureADTokenExchange

CLIENT_ID=$(az identity show --name $IDENTITY --resource-group $RG --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show --name $IDENTITY --resource-group $RG --query principalId -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
RG_ID=$(az group show --name $RG --query id -o tsv)

# Contributor on the experiment resource group only: update the app, set its
# secrets, push to its registry. Nothing outside dibs-exp-rg.
az role assignment create --assignee-object-id $PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal --role Contributor --scope $RG_ID
```

### 4. SpacetimeDB experiment database

The owner signs in with their own SpacetimeDB account. This creates a brand-new
database; it doesn't touch `dibs-ch13-dev`, and collaborator access on that
database doesn't carry over to this one. A separate CLI config keeps the token
in one known file without disturbing the laptop's normal `spacetime` login, and
`DIBS_HOME` keeps the participant tokens out of `~/.dibs`.

```sh
STCFG=$SETUP/spacetime.toml
export DIBS_HOME=$SETUP/dibs-home

spacetime --config-path $STCFG login          # browser sign-in, owner's account
spacetime --config-path $STCFG publish --server $STDB --module-path spacetime \
  --delete-data=never --yes=remote $DB

# Publishing creates one unused admin invite. Claim it, then issue and claim the worker's.
ADMIN_CODE=$(spacetime --config-path $STCFG sql --server $STDB --format json $DB \
  "SELECT code FROM invite WHERE name = 'admin' AND used = false" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0].rows[0][0]))')
npm run --silent dibs -- join --uri $STDB --db $DB --participant admin --code "$ADMIN_CODE"

WORKER_CODE=$(npm run --silent dibs -- admin invite worker claude worker | tail -n 1)
npm run --silent dibs -- join --uri $STDB --db $DB --participant worker --code "$WORKER_CODE"

ls "$DIBS_HOME/admin/token" "$DIBS_HOME/worker/token"   # both must exist
```

`admin invite` prints only the new code. Don't print the tokens.

### 5. GitHub environment, secrets and variables

```sh
# Environment that only the real_exp branch can deploy from.
gh api -X PUT repos/$REPO/environments/real-exp \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/$REPO/environments/real-exp/deployment-branch-policies \
  -f name=real_exp -f type=branch

# Secrets go in from variables or files, so nothing is echoed.
gh secret set AZURE_CLIENT_ID       --env real-exp --repo $REPO --body "$CLIENT_ID"
gh secret set AZURE_TENANT_ID       --env real-exp --repo $REPO --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --env real-exp --repo $REPO --body "$SUBSCRIPTION_ID"
grep '^spacetimedb_token' $STCFG | sed -E 's/^[^"]*"([^"]*)".*/\1/' \
  | gh secret set SPACETIME_PUBLISH_TOKEN --env real-exp --repo $REPO
gh secret set SPACETIME_ADMIN_TOKEN  --env real-exp --repo $REPO < "$DIBS_HOME/admin/token"
gh secret set SPACETIME_WORKER_TOKEN --env real-exp --repo $REPO < "$DIBS_HOME/worker/token"

gh variable set SPACETIME_URI        --env real-exp --repo $REPO --body "$STDB"
gh variable set SPACETIME_DB         --env real-exp --repo $REPO --body "$DB"
gh variable set AZURE_RESOURCE_GROUP --env real-exp --repo $REPO --body "$RG"
gh variable set AZURE_CONTAINER_APP  --env real-exp --repo $REPO --body "$APP"
gh variable set AZURE_ACR_NAME       --env real-exp --repo $REPO --body "$ACR"

gh secret list   --env real-exp --repo $REPO   # 6 names so far
gh variable list --env real-exp --repo $REPO   # 5 names
```

The publishing token is the owner's CLI login from step 4. It must stay the
identity that owns `dibs-ch13-exp`; future schema publishes use it.

**Add the Anthropic API key in the GitHub web UI:** repository **Settings →
Environments → `real-exp` → Environment secrets → Add environment secret**, name
`ANTHROPIC_API_KEY`. It must be an environment secret, not a repository secret.
Afterwards `gh secret list --env real-exp --repo $REPO` shows 7 names. Do step 6
only once it's there; otherwise the deploy job stops at its preflight with
`Missing names: ANTHROPIC_API_KEY`.

### 6. Turn on deployment and run it

`DIBS_EXP_AUTO_DEPLOY` is a **repository** variable because the deploy job reads
it before entering the environment. It only has an effect on `real_exp` pushes.

```sh
gh variable set DIBS_EXP_AUTO_DEPLOY --repo $REPO --body true
git commit --allow-empty -m "Trigger the first experiment deployment"
git push origin real_exp
gh run watch --repo $REPO $(gh run list --repo $REPO --branch real_exp --event push --limit 1 --json databaseId --jq '.[0].databaseId')
```

Pushing needs write access, which the owner has. `workflow_dispatch` (Run
workflow → deploy=true) only appears once this workflow is also on the default
branch.

The run succeeds only after `Deploy experiment` finishes its hosted smoke test:
a real model proposal, accepted by two scripted clients. Then:

```sh
az containerapp show --name $APP --resource-group $RG --query properties.configuration.ingress.fqdn -o tsv
# Installable CLI whose default server is that verified URL:
gh run download --repo $REPO --name dibs-experience-$(git rev-parse HEAD) --dir dibs-release
```

Hand `dibs-release/dibs-experience-*.tgz` to the testers; see
`packages/experience/README.md`.

### 7. Clean up the laptop

Every credential now lives in GitHub secrets and Azure. Remove the local copies.

```sh
rm -rf "$SETUP"
unset DIBS_HOME ADMIN_CODE WORKER_CODE
```

Later deployments need no laptop: every push to `real_exp` deploys. To pause
them, set `DIBS_EXP_AUTO_DEPLOY` to `false`.

**Each deploy wipes the experiment database** and recreates it with the new
schema, so schema changes never block a deploy. Open rooms and their join codes
end with it; testers create a new room afterwards (`dibs leave --local`, then
`dibs create`/`dibs join`). The admin and worker identities are re-registered
automatically, so the stored secrets keep working. To keep data across deploys
instead, set the environment variable `SPACETIME_DELETE_DATA` to `on-conflict`
(wipe only when the schema change is breaking) or `never` (additive changes only;
a breaking change fails the deploy). To remove the whole experiment,
run `az group delete --name dibs-exp-rg` and delete the `real-exp` environment;
the shared project is untouched.

## What a deployment does

1. Checks required credential names/configuration and rejects targets without
   `exp` names, as well as any of the shared project's resource names. It never
   silently falls back to the shared database.
2. Logs into Azure with OIDC. Installs the pinned SpacetimeDB CLI, logs in using
   the publishing secret, then publishes with **`--delete-data=always`** by
   default (`SPACETIME_DELETE_DATA` overrides it), which wipes the experiment
   database and applies the new schema. `infra/ci/bootstrap-participants.ps1`
   then re-registers the admin and worker under their existing identities from
   the stored tokens; it does nothing when they survived the publish.
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

A failed schema publish stops before updating Azure. If a later step fails, the
workflow fails and retains its logs; it does not pretend schema and application
changes are transactional. To roll back, push a revert to `real_exp`: the next
deploy wipes the database again and publishes the reverted schema and image
together. Disable project onboarding through `configure_projects` if rolling
back support for it.

The wipe policy only applies to this experiment database. The additive upgrade
from the real `c5f895f` baseline is still exercised in CI (published, seeded,
then updated without deleting data), so the same schema can later be published
to a database whose data matters, using `--delete-data=never`.

References: [Azure OIDC](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect),
[Container Apps GitHub Actions](https://learn.microsoft.com/en-us/azure/container-apps/github-actions),
[SpacetimeDB CLI](https://spacetimedb.com/docs/cli-reference/),
[Codex hooks and native trust](https://learn.chatgpt.com/docs/hooks).
