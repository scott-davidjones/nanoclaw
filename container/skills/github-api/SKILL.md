---
name: github-api
description: Call the GitHub API via curl — repos, pull requests, issues, Actions workflows, releases, users, orgs, and code search. Authentication is handled by the OneCLI gateway; no tokens needed. Use whenever the user asks about GitHub resources or wants to create, comment on, review, merge, or close any of them.
---

# GitHub API

Access the GitHub API via `curl`. Authentication is handled automatically by the OneCLI gateway — no tokens needed.

Base URL: `https://api.github.com`

## Repositories

```bash
# List user's repos
curl -s https://api.github.com/user/repos?sort=updated | jq '.[] | {full_name, private, language, updated_at}'

# Get repo details
curl -s https://api.github.com/repos/owner/repo | jq '{full_name, description, default_branch, stargazers_count}'

# List branches
curl -s https://api.github.com/repos/owner/repo/branches | jq '.[].name'

# Get file contents
curl -s https://api.github.com/repos/owner/repo/contents/path/to/file | jq -r '.content' | base64 -d

# Create a repo
curl -s -X POST https://api.github.com/user/repos \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-repo","private":true}'
```

## Pull Requests

```bash
# List open PRs
curl -s https://api.github.com/repos/owner/repo/pulls | jq '.[] | {number, title, user: .user.login, state}'

# Get PR details
curl -s https://api.github.com/repos/owner/repo/pulls/123 | jq '{title, body, state, mergeable, changed_files}'

# List PR files
curl -s https://api.github.com/repos/owner/repo/pulls/123/files | jq '.[] | {filename, status, additions, deletions}'

# Create a PR
curl -s -X POST https://api.github.com/repos/owner/repo/pulls \
  -H 'Content-Type: application/json' \
  -d '{"title":"My PR","body":"Description","head":"feature-branch","base":"main"}'

# Merge a PR
curl -s -X PUT https://api.github.com/repos/owner/repo/pulls/123/merge \
  -H 'Content-Type: application/json' \
  -d '{"merge_method":"squash"}'

# List PR reviews
curl -s https://api.github.com/repos/owner/repo/pulls/123/reviews | jq '.[] | {user: .user.login, state, body}'

# Add PR comment
curl -s -X POST https://api.github.com/repos/owner/repo/issues/123/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Comment text"}'
```

## Issues

```bash
# List open issues
curl -s https://api.github.com/repos/owner/repo/issues?state=open | jq '.[] | {number, title, user: .user.login, labels: [.labels[].name]}'

# Get issue details
curl -s https://api.github.com/repos/owner/repo/issues/456 | jq '{title, body, state, labels: [.labels[].name], assignees: [.assignees[].login]}'

# Create an issue
curl -s -X POST https://api.github.com/repos/owner/repo/issues \
  -H 'Content-Type: application/json' \
  -d '{"title":"Bug report","body":"Description","labels":["bug"]}'

# Close an issue
curl -s -X PATCH https://api.github.com/repos/owner/repo/issues/456 \
  -H 'Content-Type: application/json' \
  -d '{"state":"closed"}'

# Add a comment
curl -s -X POST https://api.github.com/repos/owner/repo/issues/456/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Comment text"}'
```

## Actions / Workflows

```bash
# List workflow runs
curl -s https://api.github.com/repos/owner/repo/actions/runs?per_page=5 | jq '.workflow_runs[] | {id, name, status, conclusion, created_at}'

# Get run details
curl -s https://api.github.com/repos/owner/repo/actions/runs/789 | jq '{name, status, conclusion, html_url}'

# List workflows
curl -s https://api.github.com/repos/owner/repo/actions/workflows | jq '.workflows[] | {id, name, state}'

# Trigger a workflow
curl -s -X POST https://api.github.com/repos/owner/repo/actions/workflows/deploy.yml/dispatches \
  -H 'Content-Type: application/json' \
  -d '{"ref":"main"}'

# Download run logs
curl -sL https://api.github.com/repos/owner/repo/actions/runs/789/logs -o /tmp/logs.zip
```

## Releases

```bash
# List releases
curl -s https://api.github.com/repos/owner/repo/releases | jq '.[] | {tag_name, name, published_at, draft, prerelease}'

# Get latest release
curl -s https://api.github.com/repos/owner/repo/releases/latest | jq '{tag_name, name, body}'

# Create a release
curl -s -X POST https://api.github.com/repos/owner/repo/releases \
  -H 'Content-Type: application/json' \
  -d '{"tag_name":"v1.0.0","name":"v1.0.0","body":"Release notes","draft":false}'
```

## Users & Orgs

```bash
# Authenticated user info
curl -s https://api.github.com/user | jq '{login, name, email, public_repos}'

# List orgs
curl -s https://api.github.com/user/orgs | jq '.[].login'

# List org repos
curl -s https://api.github.com/orgs/orgname/repos?sort=updated | jq '.[] | {name, private, language}'
```

## Search

```bash
# Search repos
curl -s 'https://api.github.com/search/repositories?q=nanoclaw+language:typescript' | jq '.items[] | {full_name, description, stargazers_count}'

# Search code
curl -s 'https://api.github.com/search/code?q=filename:CLAUDE.md+repo:owner/repo' | jq '.items[] | {path, repository: .repository.full_name}'

# Search issues
curl -s 'https://api.github.com/search/issues?q=repo:owner/repo+is:open+label:bug' | jq '.items[] | {number, title}'
```

## Pagination

Most list endpoints support `page` and `per_page` params (max 100):
```bash
curl -s 'https://api.github.com/repos/owner/repo/issues?page=2&per_page=50' | jq .
```

## Full API reference

For endpoints not listed here, see https://docs.github.com/en/rest
