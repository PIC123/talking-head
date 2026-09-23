# Relay on Azure Container Apps

The relay is one small container: `Dockerfile` at the repo root, listening on `PORT` (8787), health at `/healthz`, WebSocket plus `POST /turn` on the same port. Container Apps builds it in the cloud from the source tree, so no Docker on your machine.

All commands use the Azure CLI (`az`). Names below are suggestions; change them freely. Pick a region near the event.

## 1. One-time: sign in and pick a subscription

```bash
az login
az account show --query name -o tsv          # confirm it is your personal subscription
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
```

## 2. Create the app from source

`az containerapp up` creates the resource group, a container registry, the environment and the app, builds the image from the Dockerfile and deploys it, in one go.

```bash
cd talking-head            # repo root, on the branch that has server/
az containerapp up \
  --name talking-head-relay \
  --resource-group talking-head-rg \
  --location westus2 \
  --environment talking-head-env \
  --source . \
  --ingress external \
  --target-port 8787 \
  --env-vars PORT=8787
```

It prints the app's hostname at the end, something like `talking-head-relay.<random>.<region>.azurecontainerapps.io`. The relay will exit immediately at this point because it has no key yet; that is expected.

## 3. Secrets and settings

```bash
RG=talking-head-rg; APP=talking-head-relay
az containerapp secret set -n $APP -g $RG --secrets \
  meta-key='<META_API_KEY>' \
  el-key='<ELEVENLABS_API_KEY>' \
  relay-token="$(openssl rand -hex 16)"

az containerapp update -n $APP -g $RG \
  --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --set-env-vars PORT=8787 \
    META_API_KEY=secretref:meta-key \
    ELEVENLABS_API_KEY=secretref:el-key \
    ELEVENLABS_VOICE_ID='<voice id>' \
    RELAY_TOKEN=secretref:relay-token

az containerapp secret show -n $APP -g $RG --secret-name relay-token --query value -o tsv   # copy for the app
az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv   # the hostname
```

Check it: `curl https://<hostname>/healthz` should say `talking-head relay ok (live)`.

## 4. Point the app at it

Open the page once with the hostname and token; both are saved in that browser:

```
https://talking-head-kappa-ten.vercel.app/?muse&relay=wss://<hostname>&token=<relay token>
```

Push-to-talk works immediately. For open mic, set turnMode to "Open mic" in the Agent folder.

## Scale to zero and cold starts

With `--min-replicas 0` the container stops after a few minutes idle and costs nothing; the first connection afterwards takes 5 to 15 s to start it, and the app's reconnect handles that. For a demo, warm it by opening the page a minute early, or set `--min-replicas 1` for the day (roughly $0.50 a day at this size) and back to 0 after.

## Redeploying

From your machine: rerun the `az containerapp up` command from step 2; it rebuilds and rolls out. Secrets and settings persist.

From GitHub: the workflow `.github/workflows/deploy-relay-azure.yml` does the same on push to `main` (or on demand). It needs a service principal:

```bash
SUB=$(az account show --query id -o tsv)
az ad sp create-for-rbac --name talking-head-deployer --role contributor \
  --scopes /subscriptions/$SUB/resourceGroups/talking-head-rg --sdk-auth
```

Paste the JSON it prints as the repository secret `AZURE_CREDENTIALS`, and set repository variables `AZURE_RESOURCE_GROUP=talking-head-rg`, `AZURE_CONTAINERAPP=talking-head-relay`, and `AZURE_ACR` to the registry name that `az containerapp up` created (`az acr list -g talking-head-rg --query "[0].name" -o tsv`).

## Logs

```bash
az containerapp logs show -n talking-head-relay -g talking-head-rg --follow
```

Set the env var `DEBUG=1` (via `--set-env-vars`) to log every message.
