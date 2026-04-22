---
name: web-search
description: Search the web with Brave Search. Use whenever the user asks for current information, recent events, news, or any fact you are not confident about. Returns numbered results with title, URL, and snippet. Do not fabricate results — if the script errors or returns no results, say so plainly.
---

# Web Search (Brave)

Client-side web search via the Brave Search API. Credentials are injected by the OneCLI gateway at the `api.search.brave.com` host pattern — this script forwards no API key and reads no env var.

Use this **instead of** the built-in `WebSearch` tool. The built-in `WebSearch` is an Anthropic server-side feature that does not work through LiteLLM routing; this skill is the working replacement.

## Usage

```bash
python3 /home/node/.claude/skills/web-search/search.py "<query>" [count]
```

- `query` (required) — the search query. Quote it.
- `count` (optional) — number of results, default 5, max 20.

## Example

```bash
python3 /home/node/.claude/skills/web-search/search.py "claude opus 4.7 release notes" 10
```

Output: a numbered list, each entry with title, URL, and description on three lines.

## When to use

- User asks about current events, news, or anything time-sensitive.
- User asks for a fact that might be outside your training or your memory.
- User explicitly asks you to search the web.
- You need to verify a claim before stating it as fact.

Default to searching rather than guessing when the question touches anything current.

## Error handling — IMPORTANT

The script emits lines starting with `ERROR:` on failure. On any `ERROR:` line, you **must**:

1. Not fabricate results. Do not pretend the search succeeded.
2. Notify the user via the main channel using `mcp__nanoclaw__send_message` — the user is paying for this API and needs to know when it's broken.
3. Tell the user what the error was in plain language (auth, rate limit, server-side, network).

Error categories the script produces:

| Error | Meaning | Action |
|---|---|---|
| `HTTP 401`/`403` | OneCLI secret missing or misconfigured | Notify user: Brave credential needs fixing in OneCLI. |
| `HTTP 429` | Rate limit exceeded (50 req/s shared across keys) | Notify user: too much concurrent searching. Back off. |
| `HTTP 5xx` | Brave-side problem | Notify user, safe to retry once. |
| Network error | OneCLI gateway unreachable or DNS failing | Notify user: infrastructure issue. |
| Invalid JSON | Brave returned malformed response | Notify user: unexpected; worth investigating. |

If the script prints exactly `No results found for: <query>`, that is not an error — the API worked, there were just no hits. Tell the user the query returned no results; do not notify as a failure.

## Host setup (one-time, done by operator — not by you)

The operator registers the Brave Search API key in the OneCLI vault on the host:

```bash
onecli secrets create \
  --name BraveSearch \
  --type generic \
  --value <BRAVE_API_KEY> \
  --host-pattern api.search.brave.com \
  --header-name X-Subscription-Token
```

Get a key from https://api-dashboard.search.brave.com/. Current plan: 50 requests/second, unlimited monthly. Multiple keys share the same rate limit.

Verify the secret is registered:

```bash
onecli secrets list
```

After registering the secret, no restart is needed — the next search request picks it up automatically.
