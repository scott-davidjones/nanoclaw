# Remove GitHub API

Remove the GitHub API integration from NanoClaw.

## Steps

### 1. Remove container skill

```bash
rm -rf container/skills/github-api
```

### 2. Remove OneCLI secret

```bash
onecli secrets list
```

Find the GitHub secret ID, then:

```bash
onecli secrets delete --id <id>
```

### 3. Remove git remote

```bash
git remote remove github-api
```

### 4. Remove skill definitions

```bash
rm -rf .claude/skills/add-github-api
rm -rf .claude/skills/remove-github-api
```

### 5. Rebuild container and restart

```bash
./container/build.sh
# Linux:
systemctl --user restart nanoclaw
# macOS:
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 6. Confirm

Tell the user the GitHub API integration has been removed. The agent will no longer have the API reference skill loaded, and OneCLI will no longer inject auth for `api.github.com`.
