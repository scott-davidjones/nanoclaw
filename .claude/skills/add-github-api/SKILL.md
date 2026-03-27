# Add GitHub API

This skill adds GitHub API access to NanoClaw container agents. Agents use `curl` against the GitHub REST API — authentication is handled transparently by the OneCLI gateway. No tokens are exposed to containers.

## Phase 1: Pre-flight

Check if `container/skills/github-api/SKILL.md` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure remote

```bash
git remote -v
```

If `github-api` remote is missing, add it:

```bash
git remote add github-api https://github.com/scott-davidjones/nanoclaw-github-api.git
```

### Merge the skill branch

```bash
git fetch github-api main
git merge github-api/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

### Validate

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Store GitHub token in OneCLI

AskUserQuestion: Do you have a GitHub Personal Access Token? If not, create one at https://github.com/settings/tokens with `repo` scope.

Store the token in OneCLI (never in `.env`):

```bash
onecli secrets create --name GitHub --type generic --value YOUR_TOKEN --host-pattern api.github.com --header-name Authorization --value-format 'Bearer {value}'
```

Verify: `onecli secrets list` should show the GitHub secret.

### Rebuild container and restart

```bash
./container/build.sh
# Linux:
systemctl --user restart nanoclaw
# macOS:
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Tell the user to send a message to their bot asking it to check their GitHub account:

```
curl -s https://api.github.com/user | jq '{login, name}'
```

## Removal

Run `/remove-github-api` to uninstall.
