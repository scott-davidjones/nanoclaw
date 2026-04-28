---
name: digitalocean-api
description: Interact with DigitalOcean — droplets, DNS, databases, Kubernetes, apps, account, balance. Prefer the `doctl` CLI; fall back to `curl https://api.digitalocean.com/v2/...` on any failure. Authentication is handled by the OneCLI gateway; no tokens to manage. Use whenever the user asks about DO resources or wants to list, create, update, or delete them.
---

# DigitalOcean

Two authenticated paths are available:

1. **Preferred — `doctl` CLI** for everything. Cleaner output, less ceremony.
2. **Fallback — `curl https://api.digitalocean.com/v2/...`** when `doctl` errors, lacks a subcommand, or you need a raw response.

Authentication is injected by the OneCLI gateway via `HTTPS_PROXY` — you never pass tokens. `DIGITALOCEAN_ACCESS_TOKEN` is set to a placeholder so `doctl` will run; OneCLI rewrites the auth header on the way out.

## Try-then-fall-back pattern

```bash
doctl compute droplet list --format ID,Name,Status,Region,PublicIPv4 --no-header 2>/tmp/doctl.err \
  || { echo "doctl failed: $(cat /tmp/doctl.err)"; \
       curl -sSf https://api.digitalocean.com/v2/droplets \
         | jq '.droplets[] | {id, name, status, region: .region.slug, ip: .networks.v4[0].ip_address}'; }
```

If `doctl` returns non-zero, retry once via `curl` before reporting failure to the user.

## Common operations — doctl-first

```bash
# Droplets
doctl compute droplet list
doctl compute droplet get <id>
doctl compute droplet create <name> --region lon1 --size s-1vcpu-1gb --image ubuntu-24-04-x64 --ssh-keys <key-id>
doctl compute droplet delete <id> --force
doctl compute droplet-action power-off <id>
doctl compute droplet-action reboot <id>

# DNS / Domains
doctl compute domain list
doctl compute domain records list <domain>
doctl compute domain records create <domain> --record-type A --record-name sub --record-data 1.2.3.4 --record-ttl 300
doctl compute domain records update <domain> --record-id <id> --record-data 5.6.7.8
doctl compute domain records delete <domain> <record-id> --force

# Databases
doctl databases list
doctl databases get <id>
doctl databases connection <id>

# Kubernetes
doctl kubernetes cluster list
doctl kubernetes cluster get <id>
doctl kubernetes cluster kubeconfig save <id>     # writes ~/.kube/config

# Apps
doctl apps list
doctl apps get <id>
doctl apps create-deployment <id>

# Account
doctl account get
doctl balance get

# SSH keys
doctl compute ssh-key list
```

## Curl fallback reference

Base URL: `https://api.digitalocean.com/v2`. Auth injected by OneCLI; do not add `-H 'Authorization: ...'`.

```bash
# Droplets
curl -sSf https://api.digitalocean.com/v2/droplets \
  | jq '.droplets[] | {id, name, status, region: .region.slug, ip: .networks.v4[0].ip_address}'

curl -sSf -X POST https://api.digitalocean.com/v2/droplets \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-droplet","region":"lon1","size":"s-1vcpu-1gb","image":"ubuntu-24-04-x64"}'

curl -sSf -X DELETE https://api.digitalocean.com/v2/droplets/<id>

# Droplet actions
curl -sSf -X POST https://api.digitalocean.com/v2/droplets/<id>/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"power_off"}'

# DNS
curl -sSf https://api.digitalocean.com/v2/domains | jq '.domains[] | {name, ttl}'
curl -sSf https://api.digitalocean.com/v2/domains/<domain>/records \
  | jq '.domain_records[] | {id, type, name, data}'
curl -sSf -X POST https://api.digitalocean.com/v2/domains/<domain>/records \
  -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"sub","data":"1.2.3.4","ttl":300}'

# Databases
curl -sSf https://api.digitalocean.com/v2/databases \
  | jq '.databases[] | {id, name, engine, status, region: .region}'
curl -sSf https://api.digitalocean.com/v2/databases/<id> | jq '.database.connection'

# Kubernetes
curl -sSf https://api.digitalocean.com/v2/kubernetes/clusters \
  | jq '.kubernetes_clusters[] | {id, name, region, status: .status.state}'

# Apps
curl -sSf https://api.digitalocean.com/v2/apps | jq '.apps[] | {id, spec: .spec.name, live_url: .live_url}'

# Account
curl -sSf https://api.digitalocean.com/v2/account | jq .account
curl -sSf https://api.digitalocean.com/v2/customers/my/balance | jq .
```

Pagination: `?page=N&per_page=100`. Full reference: https://docs.digitalocean.com/reference/api/api-reference/
