#!/usr/bin/env python3
"""Brave Search via OneCLI-injected credentials.

Usage: search.py <query> [count]

The X-Subscription-Token header is injected by the OneCLI gateway
at host-pattern api.search.brave.com. This script does not read
or forward any API key from the environment.
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
DEFAULT_COUNT = 5
MAX_COUNT = 20
TIMEOUT_SECONDS = 20


def out(msg: str) -> None:
    print(msg)


def fail(msg: str, code: int = 1) -> None:
    out(msg)
    sys.exit(code)


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        fail("ERROR: Usage: search.py <query> [count]", code=2)

    query = sys.argv[1]
    try:
        count = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_COUNT
    except ValueError:
        fail(f"ERROR: count must be an integer (got {sys.argv[2]!r})", code=2)

    count = max(1, min(MAX_COUNT, count))

    url = (
        f"{BRAVE_ENDPOINT}?"
        f"{urllib.parse.urlencode({'q': query, 'count': count})}"
    )
    req = urllib.request.Request(url, headers={"Accept": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body_preview = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            body_preview = ""

        if status in (401, 403):
            fail(
                f"ERROR: Brave Search API rejected the request (HTTP {status}). "
                f"The BraveSearch secret is missing or misconfigured in OneCLI. "
                f"Notify the user. Expected setup: "
                f"onecli secrets create --name BraveSearch --type generic "
                f"--value <KEY> --host-pattern api.search.brave.com "
                f"--header-name X-Subscription-Token"
            )
        if status == 429:
            fail(
                "ERROR: Brave Search API rate limit exceeded (HTTP 429). "
                "Current plan allows 50 requests/second, unlimited monthly — "
                "hitting 429 means concurrency across keys is too high. "
                "Notify the user and do not retry in a tight loop."
            )
        if status >= 500:
            fail(
                f"ERROR: Brave Search API server error (HTTP {status}). "
                f"Transient — safe to retry once. Body: {body_preview}"
            )
        fail(f"ERROR: Brave Search API returned HTTP {status}: {body_preview}")
    except urllib.error.URLError as e:
        fail(
            f"ERROR: Could not reach Brave Search API: {e.reason}. "
            f"OneCLI gateway may be unreachable or DNS is failing."
        )
    except json.JSONDecodeError as e:
        fail(f"ERROR: Brave Search API returned invalid JSON: {e}")

    results = (data.get("web") or {}).get("results") or []
    if not results:
        out(f"No results found for: {query}")
        return

    out(f"Brave Search results for: {query}")
    out("")
    for i, r in enumerate(results, start=1):
        title = (r.get("title") or "(no title)").strip()
        link = (r.get("url") or "").strip()
        snippet = (r.get("description") or "").strip()
        out(f"{i}. {title}")
        out(f"   {link}")
        if snippet:
            out(f"   {snippet}")
        out("")


if __name__ == "__main__":
    main()
