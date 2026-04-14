---
name: tpp
description: Run TPP management commands (response, connect, check, message) on a remote server via SSH. Triggers on phrases like "run the <command> command on <server>", "can you run <command> on <server>", or "<command> on <server>" where <command> is one of response/connect/check/message. Resolves the server from a cached registry or via DigitalOcean lookup, picks a working SSH key, runs the command, and reports success or failure (non-zero exit or Python traceback).
---

# TPP Server Commands

Run TPP management commands on a remote server via SSH, stream the output, and report back on success or failure.

## When to trigger

Trigger on phrases like:

- "run the `<command>` command on `<server>`"
- "can you run `<command>` on `<server>`"
- "`<command>` on `<server>`"

where `<command>` is one of `response`, `connect`, `check`, or `message`, and `<server>` is a short name like `martis`.

## Available commands

| Name       | Invocation (run inside `/home/deploy/tpp/current`) |
|------------|----------------------------------------------------|
| `response` | `poetry run python -m tpp.main response`           |
| `connect`  | `poetry run python -m tpp.main connect`            |
| `check`    | `poetry run python -m tpp.main check`              |
| `message`  | `poetry run python -m tpp.main message`            |

All four run to completion — they log output to stdout and exit. None stream indefinitely.

## Server registry

Known servers live in `/workspace/extra/persist/servers.json`. Schema:

```json
{
  "servers": [
    {
      "name": "martis",
      "host": "203.0.113.5",
      "port": 22,
      "user": "artemis",
      "identityFile": "/workspace/extra/persist/.ssh/artemis_ed25519"
    }
  ]
}
```

- `name` — short name the user refers to (e.g. `martis`)
- `host` — IP or hostname
- `port` — SSH port (default `22`)
- `user` — SSH user (default `artemis`)
- `identityFile` — absolute path to the working private key for this server

If the file doesn't exist, create it with `{"servers": []}` before your first write.

## Resolving a server name

When asked to run a command on `<server>`, find its details in this order:

### 1. Check `servers.json` first

```bash
jq --arg name "<server>" '.servers[] | select(.name == $name)' /workspace/extra/persist/servers.json
```

If present, use those details directly — skip to **Running the command**.

### 2. Query DigitalOcean if not cached

Use the DigitalOcean API (handled automatically by the OneCLI gateway — see the `digitalocean-api` skill):

```bash
curl -s https://api.digitalocean.com/v2/droplets \
  | jq --arg name "<server>" '
      .droplets[]
      | select(.name | test($name; "i"))
      | {name, ip: (.networks.v4[] | select(.type=="public") | .ip_address)}
    '
```

If exactly one droplet matches, use its public IPv4. If multiple match, list them to the user and ask which one.

### 3. Ask the user if still unresolved

If the server isn't in `servers.json` and isn't a DigitalOcean droplet, ask for the host/IP explicitly. Default `user` to `artemis` and `port` to `22` unless told otherwise.

### 4. Find a working SSH key

If the server has no cached `identityFile` yet, try each private key under `/workspace/extra/persist/.ssh/` until one authenticates:

```bash
for key in /workspace/extra/persist/.ssh/*; do
  [[ "$key" == *.pub ]] && continue
  [ -f "$key" ] || continue
  ssh -i "$key" \
      -o BatchMode=yes \
      -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=accept-new \
      -p <port> <user>@<host> exit 2>/dev/null \
    && { echo "WORKS: $key"; break; }
done
```

The first key that connects wins.

### 5. Persist the result

After a successful connection, write the full record back to `servers.json` so next time is a cache hit. Preserve existing entries — use `jq` to merge:

```bash
jq --arg name "<server>" \
   --arg host "<host>" \
   --argjson port <port> \
   --arg user "<user>" \
   --arg key "<identityFile>" \
   '.servers |= (map(select(.name != $name)) + [{name:$name, host:$host, port:$port, user:$user, identityFile:$key}])' \
   /workspace/extra/persist/servers.json > /tmp/servers.json.new \
 && mv /tmp/servers.json.new /workspace/extra/persist/servers.json
```

## Running the command (detached)

TPP commands can take **longer than the 30-minute container timeout**, so you must **never** run them synchronously over SSH. Instead:

1. Kick the command off **detached** on the remote (`setsid`, log to file, capture PID, return immediately).
2. Record the job in a local registry file.
3. Schedule a one-off check via `schedule_task` a few minutes out.
4. Let the container exit normally.
5. The scheduled check task spawns a fresh container later to inspect the job and either report the result or reschedule.

This keeps every container invocation short and decouples the remote job from the nanoclaw container lifetime.

### 1. Kick off the job on the remote

Generate a job ID first (use `date +%s` for the timestamp). Then run:

```bash
JOB_ID="tpp-<command>-$(date +%s)"

ssh -i <identityFile> -p <port> \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    <user>@<host> \
    "JOB_ID='$JOB_ID'; \
     LOG=\"/tmp/\${JOB_ID}.log\"; \
     EXITF=\"/tmp/\${JOB_ID}.exit\"; \
     PIDF=\"/tmp/\${JOB_ID}.pid\"; \
     setsid bash -l -c \"cd /home/deploy/tpp/current && poetry run python -m tpp.main <command>; echo \\\$? > \$EXITF\" \
       > \$LOG 2>&1 < /dev/null & \
     echo \$! > \$PIDF; \
     echo \"JOB_ID=\$JOB_ID PID=\$(cat \$PIDF) LOG=\$LOG\""
```

Notes:

- **Login shell (`bash -l -c`)** is required so `poetry` resolves on `PATH`. If that still fails with `poetry: command not found`, fall back to `/home/deploy/.local/bin/poetry run python -m tpp.main <command>`.
- **The three redirects `> $LOG 2>&1 < /dev/null`** are all required. Without closing stdin from `/dev/null`, SSH will hang waiting for the backgrounded child to close its stdio streams — the disown doesn't help there.
- **Cross-user directory access.** The working directory `/home/deploy/tpp/current` lives under the `deploy` user's home, but you're connecting as `artemis`. If you see `Permission denied` when entering the directory, stop immediately and report it to the user — do **not** try to `sudo` or escalate.
- SSH returns immediately with `JOB_ID=… PID=… LOG=…`. Parse those for the next step.

### 2. Record the job

Append an entry to `/workspace/extra/persist/tpp-jobs.json`. Schema:

```json
{
  "jobs": [
    {
      "jobId": "tpp-message-1712345678",
      "server": "martis",
      "command": "message",
      "pid": 12345,
      "logFile": "/tmp/tpp-message-1712345678.log",
      "exitFile": "/tmp/tpp-message-1712345678.exit",
      "pidFile": "/tmp/tpp-message-1712345678.pid",
      "startedAt": "2026-04-14T17:00:00",
      "chatJid": "<current chat jid>",
      "checkCount": 0
    }
  ]
}
```

If the file doesn't exist, create it with `{"jobs": []}` first. Use `jq` to append safely.

### 3. Schedule the first status check

Use the `schedule_task` MCP tool with:

- `prompt`: `"Check TPP job <jobId>. Use the tpp skill's 'Checking job status' flow — read /workspace/extra/persist/tpp-jobs.json, SSH to the server, and report or reschedule."`
- `schedule_type`: `"once"`
- `schedule_value`: local timestamp 5 minutes from now, format `YYYY-MM-DDTHH:MM:SS` (no timezone suffix)
- `context_mode`: `"isolated"` — the check is self-contained, the job ID in the prompt is enough

### 4. Reply to the user immediately

Something short, e.g.:

> Started `<command>` on `<server>` (job `tpp-message-1712345678`, PID 12345). I'll check back in 5 minutes and report when it's done.

Then let the container exit. The scheduled task picks up from here.

## Checking job status

When a scheduled check task runs (or the user asks "how's that job going?"), read `/workspace/extra/persist/tpp-jobs.json`, find the job by `jobId`, look up the server in `servers.json`, and inspect it:

```bash
ssh -i <identityFile> -p <port> <user>@<host> "
  EXITF='<exitFile>'
  LOG='<logFile>'
  PIDF='<pidFile>'
  PID=\$(cat \$PIDF 2>/dev/null)
  if [ -f \"\$EXITF\" ]; then
    echo STATE=DONE
    echo EXIT=\$(cat \$EXITF)
    echo --- TAIL ---
    tail -40 \$LOG
  elif [ -n \"\$PID\" ] && kill -0 \$PID 2>/dev/null; then
    echo STATE=RUNNING
    echo --- TAIL ---
    tail -20 \$LOG
  else
    echo STATE=DEAD_NO_EXIT
    echo --- TAIL ---
    tail -40 \$LOG
  fi
"
```

Three outcomes:

### `STATE=DONE`

The job finished. Determine success:

- **Success**: `EXIT=0` and output contains no `Traceback (most recent call last):` line.
- **Failure**: non-zero exit, or traceback present.

Remove the job from `tpp-jobs.json` (using `jq`), then `send_message` to the original `chatJid`:

- **Success**: "Finished `<command>` on `<server>`. Completed cleanly." + one-line tail summary if meaningful.
- **Failure**: server + command + exit code + trimmed traceback (final frame + exception line) + last ~20 lines of context preceding the traceback.

### `STATE=RUNNING`

Still going. Increment `checkCount` in the job entry and reschedule another check:

- First 6 checks (≤30 minutes total): every 5 minutes
- Next 6 checks (≤90 minutes total): every 10 minutes
- After that: every 30 minutes

If `checkCount` reaches 20 (~6 hours), stop rescheduling and `send_message` a warning: "Job `<jobId>` has been running for 6 hours. I've stopped auto-checking. Ask me to check again if you want to continue monitoring."

### `STATE=DEAD_NO_EXIT`

The process died but never wrote an exit code file — likely killed by the OS, OOM, SSH hang, or crash before the `echo $? > …` executed. Remove the job from the registry and report as a failure with the log tail.

## Clean-up

Remote log/pid/exit files live in `/tmp/` on the server and are cleared on reboot. No proactive clean-up needed. If a user explicitly asks to stop a job, `kill` the PID over SSH, then remove it from `tpp-jobs.json`.

## Worked example

User: "can you run the message command on martis"

1. Read `/workspace/extra/persist/servers.json` — martis not present.
2. `curl https://api.digitalocean.com/v2/droplets | jq …` finds a droplet named `martis` at `203.0.113.5`.
3. Try each key in `/workspace/extra/persist/.ssh/`. `artemis_ed25519` authenticates.
4. Write the martis entry into `servers.json`.
5. Kick off detached: `ssh artemis@203.0.113.5 "JOB_ID='tpp-message-1712345678'; setsid bash -l -c 'cd /home/deploy/tpp/current && poetry run python -m tpp.main message; echo \$? > /tmp/\${JOB_ID}.exit' > /tmp/\${JOB_ID}.log 2>&1 < /dev/null & echo \$! > /tmp/\${JOB_ID}.pid; echo \"JOB_ID=\$JOB_ID PID=\$(cat /tmp/\${JOB_ID}.pid) LOG=/tmp/\${JOB_ID}.log\""`
6. Append the job to `tpp-jobs.json`.
7. `schedule_task` a "Check TPP job tpp-message-1712345678" task for `<now + 5m>`, isolated mode.
8. Reply: "Started `message` on martis (job `tpp-message-1712345678`, PID 12345). I'll check back in 5 minutes."
9. 5 minutes later, the scheduled check task runs: SSH, job state is `RUNNING`, `checkCount` → 1, reschedule another 5-minute check.
10. 10 minutes later, job state is `DONE`, `EXIT=0`, no traceback → `send_message` to the original chat: "Finished `message` on martis. Completed cleanly. `Processed 42 messages in 8m 23s.`" Remove from `tpp-jobs.json`.
