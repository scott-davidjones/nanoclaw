<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

# NanoClaw DigitalOcean API Skill

A [NanoClaw](https://github.com/qwibitai/nanoclaw) feature skill that gives container agents access to the DigitalOcean REST API.

## The Problem

NanoClaw agents run inside isolated containers. They have no access to external service credentials by design. When an agent needs to manage infrastructure on DigitalOcean — listing droplets, updating DNS records, checking databases — there's no built-in way to authenticate.

CLI tools like `doctl` require an access token to be present in the container, either as an environment variable or config file. This exposes the token to the agent process and increases the container image size with a tool that's just a wrapper around a REST API.

## The Solution

This skill skips the CLI entirely: **agents use `curl` against the DigitalOcean REST API, and the [OneCLI](https://onecli.sh) gateway handles authentication transparently**.

OneCLI runs as an HTTPS proxy between the container and the internet. When a request to `api.digitalocean.com` passes through the gateway, OneCLI injects the `Authorization` header automatically. The agent never sees the token — it just makes unauthenticated `curl` calls and they work.

This means:
- **No tokens in containers** — the agent can't leak what it doesn't have
- **No CLI tools to install** — no `doctl`, no bloated container image
- **No Dockerfile changes** — `curl` and `jq` are already available in the base image
- **No source code changes** — the skill is purely a container skill document and host skill definitions
- **Easy to add and remove** — merge to install, run `/remove-digitalocean-api` to uninstall

## What's Included

| File | Purpose |
|------|---------|
| `container/skills/digitalocean-api/SKILL.md` | Comprehensive REST API reference loaded into agents at runtime |
| `.claude/skills/add-digitalocean-api/SKILL.md` | Installation skill — sets up the OneCLI secret and merges the repo |
| `.claude/skills/remove-digitalocean-api/SKILL.md` | Removal skill — cleans up the secret, skill files, and remote |

## Installation

```bash
# From your NanoClaw directory
git remote add digitalocean-api https://github.com/scott-davidjones/nanoclaw-digitalocean-api.git
git fetch digitalocean-api main
git merge digitalocean-api/main
```

Then run `/add-digitalocean-api` in Claude Code to complete setup (creates the OneCLI secret).

Or if you already have the skill merged, just run `/add-digitalocean-api`.

## How Agents Use It

Agents make standard `curl` calls — the container skill provides a reference of common endpoints:

```bash
# List droplets
curl -s https://api.digitalocean.com/v2/droplets | jq '.droplets[] | {id, name, status, ip: .networks.v4[0].ip_address}'

# Update a DNS record
curl -s -X PUT https://api.digitalocean.com/v2/domains/example.com/records/12345 \
  -H 'Content-Type: application/json' \
  -d '{"data":"5.6.7.8"}'

# Check account balance
curl -s https://api.digitalocean.com/v2/customers/my/balance | jq .
```

The OneCLI gateway adds the `Authorization: Bearer <token>` header to every request hitting `api.digitalocean.com`. The agent doesn't need to know about authentication at all.

## Requirements

- [NanoClaw](https://github.com/qwibitai/nanoclaw)
- [OneCLI](https://onecli.sh) (for credential management)
- A DigitalOcean API token

## Removal

Run `/remove-digitalocean-api` in Claude Code, or manually:

1. `rm -rf container/skills/digitalocean-api .claude/skills/add-digitalocean-api .claude/skills/remove-digitalocean-api`
2. `onecli secrets delete --id <digitalocean-secret-id>`
3. `git remote remove digitalocean-api`
4. `./container/build.sh && systemctl --user restart nanoclaw`
