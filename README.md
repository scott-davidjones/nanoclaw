<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

# NanoClaw GitHub API Skill

A [NanoClaw](https://github.com/qwibitai/nanoclaw) feature skill that gives container agents access to the GitHub REST API.

## The Problem

NanoClaw agents run inside isolated containers. They have no access to external service credentials by design. When an agent needs to interact with GitHub — listing PRs, creating issues, checking workflow runs — there's no built-in way to authenticate.

The naive approach is to pass a GitHub Personal Access Token as an environment variable into the container. This works, but exposes the token to the agent process. A compromised or misbehaving agent could exfiltrate the token, and it sits in the container's environment for the entire session.

## The Solution

This skill takes a different approach: **agents use `curl` against the GitHub REST API, and the [OneCLI](https://onecli.sh) gateway handles authentication transparently**.

OneCLI runs as an HTTPS proxy between the container and the internet. When a request to `api.github.com` passes through the gateway, OneCLI injects the `Authorization` header automatically. The agent never sees the token — it just makes unauthenticated `curl` calls and they work.

This means:
- **No tokens in containers** — the agent can't leak what it doesn't have
- **No Dockerfile changes** — `curl` and `jq` are already available in the base image
- **No source code changes** — the skill is purely a container skill document and host skill definitions
- **Easy to add and remove** — merge to install, run `/remove-github-api` to uninstall

## What's Included

| File | Purpose |
|------|---------|
| `container/skills/github-api/SKILL.md` | Comprehensive REST API reference loaded into agents at runtime |
| `.claude/skills/add-github-api/SKILL.md` | Installation skill — sets up the OneCLI secret and merges the repo |
| `.claude/skills/remove-github-api/SKILL.md` | Removal skill — cleans up the secret, skill files, and remote |

## Installation

```bash
# From your NanoClaw directory
git remote add github-api https://github.com/scott-davidjones/nanoclaw-github-api.git
git fetch github-api main
git merge github-api/main
```

Then run `/add-github-api` in Claude Code to complete setup (creates the OneCLI secret).

Or if you already have the skill merged, just run `/add-github-api`.

## How Agents Use It

Agents make standard `curl` calls — the container skill provides a reference of common endpoints:

```bash
# List open PRs
curl -s https://api.github.com/repos/owner/repo/pulls | jq '.[] | {number, title, state}'

# Create an issue
curl -s -X POST https://api.github.com/repos/owner/repo/issues \
  -H 'Content-Type: application/json' \
  -d '{"title":"Bug report","body":"Description","labels":["bug"]}'

# Check workflow status
curl -s https://api.github.com/repos/owner/repo/actions/runs?per_page=5 | jq '.workflow_runs[] | {name, status, conclusion}'
```

The OneCLI gateway adds the `Authorization: Bearer <token>` header to every request hitting `api.github.com`. The agent doesn't need to know about authentication at all.

## Requirements

- [NanoClaw](https://github.com/qwibitai/nanoclaw)
- [OneCLI](https://onecli.sh) (for credential management)
- A GitHub Personal Access Token with appropriate scopes

## Removal

Run `/remove-github-api` in Claude Code, or manually:

1. `rm -rf container/skills/github-api .claude/skills/add-github-api .claude/skills/remove-github-api`
2. `onecli secrets delete --id <github-secret-id>`
3. `git remote remove github-api`
4. `./container/build.sh && systemctl --user restart nanoclaw`
