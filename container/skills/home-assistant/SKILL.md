---
name: home-assistant
description: Control Home Assistant — query entity states (temperature, locks, motion, climate), call services (lights, scenes, switches, thermostats), render Jinja templates, read history, and route natural-language commands through HA's Conversation API. Authentication is handled by the OneCLI gateway; no tokens to manage. Use whenever the user asks about the house, a room, lights, climate, sensors, or says aliases like "good night" or "go dark".
---

# Home Assistant

Base URL: `https://ha.in-line.studio`. Authentication is injected by the OneCLI gateway at the `ha.in-line.studio` host pattern — this skill forwards no token. `HA_TOKEN` is set to a placeholder so curl invocations are well-formed; OneCLI rewrites the `Authorization` header on the way out (same pattern as `GH_TOKEN` / `DIGITALOCEAN_ACCESS_TOKEN`).

## Conversation-first pattern

For anything imperative ("good night", "turn off the kitchen lights", "set the thermostat to 19", "is the back door locked?"), forward the user's request verbatim and let HA's Assist agent resolve it:

```bash
curl -sSf -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg t "$USER_REQUEST" '{text:$t,language:"en"}')" \
  https://ha.in-line.studio/api/conversation/process
```

Inspect `.response.response_type`. If it equals `"error"`, or the `.response.speech.plain.speech` text says HA didn't understand, fall back to the REST API.

## REST API (precise queries / fallback)

### Discover entities

```bash
# All entities
curl -sSf -H "Authorization: Bearer $HA_TOKEN" \
  https://ha.in-line.studio/api/states | jq -r '.[].entity_id'

# Filter by domain
curl -sSf -H "Authorization: Bearer $HA_TOKEN" \
  https://ha.in-line.studio/api/states \
  | jq -r '.[] | select(.entity_id | startswith("sensor.")) | .entity_id'

# Search by friendly name
curl -sSf -H "Authorization: Bearer $HA_TOKEN" \
  https://ha.in-line.studio/api/states \
  | jq -r '.[] | select(.attributes.friendly_name // "" | test("living room"; "i")) | .entity_id'
```

### Read one entity

```bash
curl -sSf -H "Authorization: Bearer $HA_TOKEN" \
  https://ha.in-line.studio/api/states/<entity_id>
```

### Call a service

```bash
curl -sSf -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"<entity_id>"}' \
  https://ha.in-line.studio/api/services/<domain>/<service>
```

Common service shapes:

```bash
# Turn a light/switch/scene on or off
... -d '{"entity_id":"light.kitchen"}' \
  https://ha.in-line.studio/api/services/light/turn_off

# Activate a scene
... -d '{"entity_id":"scene.good_night"}' \
  https://ha.in-line.studio/api/services/scene/turn_on

# Set climate target
... -d '{"entity_id":"climate.living_room","temperature":19}' \
  https://ha.in-line.studio/api/services/climate/set_temperature

# Trigger an automation
... -d '{"entity_id":"automation.morning_routine"}' \
  https://ha.in-line.studio/api/services/automation/trigger
```

### List services per domain

```bash
curl -sSf -H "Authorization: Bearer $HA_TOKEN" \
  https://ha.in-line.studio/api/services \
  | jq '.[] | {domain, services: (.services|keys)}'
```

### Render a Jinja template (compound queries)

```bash
curl -sSf -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template":"{{ states(\"sensor.living_room_temperature\") }}°C, home: {{ states(\"binary_sensor.someone_home\") }}"}' \
  https://ha.in-line.studio/api/template
```

### History (last 24h)

```bash
curl -sSf -H "Authorization: Bearer $HA_TOKEN" \
  "https://ha.in-line.studio/api/history/period/$(date -u -Iseconds -d '24 hours ago')?filter_entity_id=<entity_id>"
```

### Fire an event

```bash
curl -sSf -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" -d '{}' \
  https://ha.in-line.studio/api/events/<event_type>
```

## Try-then-fall-back pattern

Mirror the `github-api` / `digitalocean-api` skills: try the Conversation API first, fall back to direct REST on error.

```bash
RESP=$(curl -sSf -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg t "$USER_REQUEST" '{text:$t,language:"en"}')" \
  https://ha.in-line.studio/api/conversation/process 2>/tmp/ha.err)

if [ -z "$RESP" ] || [ "$(echo "$RESP" | jq -r '.response.response_type')" = "error" ]; then
  echo "conversation failed: $(cat /tmp/ha.err 2>/dev/null) $(echo "$RESP" | jq -r '.response.speech.plain.speech // empty')"
  # Fall back: discover the relevant entity_id, then call the right service directly.
fi
```

## Caching learned entities and aliases

The first time you discover an entity_id or resolve an alias to a service call, **append it to `groups/<group>/CLAUDE.md`** under a "Home Assistant — known entities" section so the next session doesn't re-discover. Don't grow this skill file with per-user state — that's group memory's job.

Example block to append:

```markdown
## Home Assistant — known entities

- Living room temperature: `sensor.living_room_temperature`
- "good night" → `POST scene/turn_on scene.good_night`
- "go dark" → `POST light/turn_off` with no `entity_id` (turns off all lights)
```

## Reference

- REST API: https://developers.home-assistant.io/docs/api/rest/
- Conversation API: https://developers.home-assistant.io/docs/api/rest/#post-apiconversationprocess
