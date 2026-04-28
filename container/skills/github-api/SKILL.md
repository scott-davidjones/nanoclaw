---
name: github-api
description: Interact with GitHub — repos, pull requests, issues, Actions, releases, users, orgs, code search. Prefer the `gh` CLI; fall back to `curl https://api.github.com` on any failure. Authentication is handled by the OneCLI gateway; no tokens to manage. Use whenever the user asks about GitHub resources or wants to create, comment on, review, merge, or close any of them. Also covers `git clone/push/pull` over SSH.
---

# GitHub

Two authenticated paths are available:

1. **Preferred — `gh` CLI** for everything API-related (repos, PRs, issues, releases, etc.). Cleaner output, less ceremony.
2. **Fallback — `curl https://api.github.com/...`** when `gh` errors, is missing a subcommand, or you need a raw response.

In both cases authentication is injected by the OneCLI gateway via `HTTPS_PROXY` — you never pass tokens. `GH_TOKEN` is set to a placeholder so `gh` will run; OneCLI rewrites the auth header on the way out.

## Try-then-fall-back pattern

```bash
gh repo view owner/repo --json name,visibility 2>/tmp/gh.err \
  || { echo "gh failed: $(cat /tmp/gh.err)"; \
       curl -sSf https://api.github.com/repos/owner/repo | jq '{name, private}'; }
```

If `gh` returns non-zero, retry once via `curl` before reporting failure to the user.

## Git operations (SSH)

`git clone/push/pull` go over SSH, not the OneCLI proxy. SSH keys live at `/workspace/extra/persist/.ssh/`. The working key for GitHub is **`id_ed25519`** (authenticates as `scott-davidjones`); ignore `artemis_ed25519` — GitHub denies it.

Run this once per session before any git remote operation:

```bash
mkdir -p ~/.ssh \
  && ln -sf /workspace/extra/persist/.ssh/id_ed25519 ~/.ssh/id_ed25519 \
  && ln -sf /workspace/extra/persist/.ssh/id_ed25519.pub ~/.ssh/id_ed25519.pub \
  && ln -sf /workspace/extra/persist/.ssh/known_hosts ~/.ssh/known_hosts \
  && chmod 700 ~/.ssh
```

For one-off commands without setting up `~/.ssh`:

```bash
GIT_SSH_COMMAND="ssh -i /workspace/extra/persist/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new" \
  git clone git@github.com:owner/repo.git
```

Always clone with `git@github.com:...` (SSH form), never `https://github.com/...` — HTTPS clone has no credentials in this container.

## Common operations — gh-first

```bash
# Repos
gh repo create owner/name --private --clone --description "..."
gh repo view owner/repo
gh repo list owner --limit 50

# PRs
gh pr create --title "..." --body "..." --base main --head feat/branch
gh pr list --repo owner/repo --state open
gh pr view 123 --repo owner/repo
gh pr merge 123 --squash --delete-branch
gh pr review 123 --approve --body "LGTM"
gh pr comment 123 --body "Question on line 42"

# Issues
gh issue create --title "..." --body "..." --label bug
gh issue list --state open --label bug
gh issue close 456 --comment "Fixed in #123"

# Actions
gh run list --workflow=ci.yml --limit 10
gh run view <run-id> --log

# Releases
gh release create v1.2.3 --title "v1.2.3" --notes "..."
gh release list

# Search
gh search repos --owner=owner --language=typescript
gh search code 'filename:CLAUDE.md repo:owner/repo'
```

## Curl fallback reference

Base URL: `https://api.github.com`. Auth injected by OneCLI; do not add `-H 'Authorization: ...'`.

```bash
# Authenticated user
curl -sSf https://api.github.com/user | jq '{login, name}'

# Create a repo (under your account)
curl -sSf -X POST https://api.github.com/user/repos \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-repo","private":true}'

# Create a repo under an org
curl -sSf -X POST https://api.github.com/orgs/<org>/repos \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-repo","private":true}'

# List repos
curl -sSf 'https://api.github.com/user/repos?sort=updated&per_page=50' \
  | jq '.[] | {full_name, private, language}'

# Create PR
curl -sSf -X POST https://api.github.com/repos/owner/repo/pulls \
  -H 'Content-Type: application/json' \
  -d '{"title":"...","body":"...","head":"feat/branch","base":"main"}'

# Merge PR
curl -sSf -X PUT https://api.github.com/repos/owner/repo/pulls/123/merge \
  -H 'Content-Type: application/json' \
  -d '{"merge_method":"squash"}'

# PR comment
curl -sSf -X POST https://api.github.com/repos/owner/repo/issues/123/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Comment text"}'

# Create issue
curl -sSf -X POST https://api.github.com/repos/owner/repo/issues \
  -H 'Content-Type: application/json' \
  -d '{"title":"...","body":"...","labels":["bug"]}'

# File contents
curl -sSf https://api.github.com/repos/owner/repo/contents/path/to/file \
  | jq -r '.content' | base64 -d
```

Pagination: `?page=N&per_page=100` (max 100). Full reference: https://docs.github.com/en/rest
