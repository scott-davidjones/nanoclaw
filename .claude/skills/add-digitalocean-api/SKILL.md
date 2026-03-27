# Add DigitalOcean API

This skill adds DigitalOcean API access to NanoClaw container agents. Agents use `curl` against the DO REST API — authentication is handled transparently by the OneCLI gateway. No tokens are exposed to containers.

## Phase 1: Pre-flight

Check if `container/skills/digitalocean-api/SKILL.md` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure remote

```bash
git remote -v
```

If `digitalocean-api` remote is missing, add it:

```bash
git remote add digitalocean-api https://github.com/scott-davidjones/nanoclaw-digitalocean-api.git
```

### Merge the skill branch

```bash
git fetch digitalocean-api main
git merge digitalocean-api/main || {
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

### Store DigitalOcean token in OneCLI

AskUserQuestion: Do you have a DigitalOcean API token? If not, create one at https://cloud.digitalocean.com/account/api/tokens

Store the token in OneCLI (never in `.env`):

```bash
onecli secrets create --name DigitalOcean --type generic --value YOUR_TOKEN --host-pattern api.digitalocean.com --header-name Authorization --value-format 'Bearer {value}'
```

Verify: `onecli secrets list` should show the DigitalOcean secret.

### Rebuild container and restart

```bash
./container/build.sh
# Linux:
systemctl --user restart nanoclaw
# macOS:
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Tell the user to send a message to their bot asking it to check their DigitalOcean account:

```
curl -s https://api.digitalocean.com/v2/account | jq .account
```

## Removal

1. Remove `container/skills/digitalocean-api/`
2. Remove OneCLI secret: `onecli secrets delete --id <id>`
3. `./container/build.sh && systemctl --user restart nanoclaw`
