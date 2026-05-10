# MCP server configuration

NanoClaw resolves the MCP servers exposed to its agent containers from a layered
set of locations on the host. This lets you (and skills) add servers without
editing `container/agent-runner/src/index.ts`.

## Search order

Resolved at container spawn time. Later layers overlay earlier on name conflict.

| # | Layer | Path |
|---|-------|------|
| 1 | User  | `~/.config/nanoclaw/mcp.json` |
| 2 | User  | `~/.config/nanoclaw/mcp.d/*.json` (lex order) |
| 3 | Repo  | `<repo>/.mcp.json` |
| 4 | Repo  | `<repo>/.mcp.d/*.json` (lex order) |
| 5 | Env   | each path in `NANOCLAW_MCP_CONFIG_PATH` (`:`-separated; file or dir) |

After loading, three built-ins are merged in this order *inside the container*:

1. Env-conditional `memory` (from `MCP_MEMORY_URL` env var) — if you put `memory`
   in any layer above, it wins.
2. Static `qmd` at `http://host.docker.internal:8182/mcp`.
3. Your loaded extras.
4. Runtime-bound `nanoclaw` stdio server — **always last, never overrideable**
   (its env vars are bound to this container's chatJid / groupFolder / isMain).

## File shape

Each file is a partial Claude Code-style MCP config:

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://host.docker.internal:3456/mcp"
    },
    "git": {
      "command": "git-mcp",
      "args": ["--read-only"]
    }
  }
}
```

Multiple servers per file are allowed. A file with no `mcpServers` key
contributes nothing (so an empty `{}` is fine). Malformed JSON is logged and
skipped — a single bad file won't take nanoclaw down.

## Container vs host URLs

These config files are read on the host but the URLs resolve **inside the
container**. Use:

- `http://host.docker.internal:<port>/...` — reaches host services from inside
  the container (cross-platform, works on macOS/Linux with the host gateway
  arg nanoclaw passes by default).
- `http://<container-name>.<network>:<port>/...` — for sibling containers on
  the same docker network.
- `http://127.0.0.1:<port>` — only reaches *the container itself*, not the host.

If you also want host-side Claude Code (the CLI you run from your terminal) to
see the same server, register it separately in `~/.claude.json` or `<repo>/.mcp.json`
under Claude Code's `mcpServers` key — Claude Code resolves URLs from the host
network, so it will use `127.0.0.1` rather than `host.docker.internal`.

## Symlinks from a shared source

Symlinks resolve transparently. Drop a canonical file in a shared location
(e.g. the brain repo) and link it into a layer:

```bash
ln -s /home/scott/artemis/brain/mcp.d/memory.json \
      ~/.config/nanoclaw/mcp.d/memory.json
```

Or point `NANOCLAW_MCP_CONFIG_PATH` at the directory directly:

```bash
# in your nanoclaw service unit / .env
NANOCLAW_MCP_CONFIG_PATH=/home/scott/artemis/brain/mcp.d
```

## Examples

**Add mcp-memory at the user level** (so every nanoclaw install on this box
picks it up):

```bash
mkdir -p ~/.config/nanoclaw/mcp.d
cat > ~/.config/nanoclaw/mcp.d/memory.json <<'JSON'
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://host.docker.internal:3456/mcp"
    }
  }
}
JSON
```

**Add a server only for this nanoclaw checkout** (committed to the repo):

```bash
mkdir -p .mcp.d
cat > .mcp.d/qmd.json <<'JSON'
{
  "mcpServers": {
    "qmd": {
      "type": "http",
      "url": "http://host.docker.internal:8182/mcp"
    }
  }
}
JSON
```

**Override a server for a specific deployment via env**:

```bash
NANOCLAW_MCP_CONFIG_PATH=/etc/nanoclaw/site-overrides.d \
  systemctl --user start nanoclaw
```

## Verifying

After editing or adding a config file, restart nanoclaw and watch the log:

```bash
systemctl --user restart nanoclaw
journalctl --user -u nanoclaw -n 50 -f | grep 'extra MCP servers'
```

You should see one line per spawn with the resolved server names + their
provenance, e.g.:

```
Loaded extra MCP servers from layered config { servers: ['memory','qmd'],
  sources: ['memory@user-dir', 'qmd@repo-dir'] }
```
