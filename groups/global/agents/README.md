# Agent Roster (Global)

These agents are channel-agnostic and shared across all groups. They communicate via `mcp__nanoclaw__send_message` which routes to the originating channel automatically.

## Active Agents

| Agent       | File           | Speciality                                                                           | Skills                     |
| ----------- | -------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| Cypher ⚒️   | `developer.md` | Laravel, Vue 3, InertiaJS, dark mode, accessibility, responsive design, test seeders | github-api, bash, file R/W |
| Vector 🧪   | `tester.md`    | Pest, PHPUnit, Vitest, PHPStan, TypeScript, ESLint (static analysis owner)           | bash, github-api (read)    |
| Prism 👁️    | `ui-tester.md` | Responsive UI (mobile/tablet/desktop), dark mode visual checks, browser testing      | agent-browser, bash        |
| Triage 🔀   | `triage.md`    | Failure classification, targeted fix routing, retry escalation                       | read, nanoclaw-schedule    |
| Sentinel 🛡️ | `reviewer.md`  | Code quality, security, architecture, correctness                                    | github-api, read           |

## Planned / Future Agents

| Agent              | Status  | Notes                                 |
| ------------------ | ------- | ------------------------------------- |
| Marketing Agent    | Planned | Content strategy, copy writing        |
| Social Media Agent | Planned | Scheduling posts, engagement          |
| DevOps Agent       | Planned | DigitalOcean, deployments, monitoring |

## Shared Files

| File             | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `BASE_SOUL.md`   | Core values and autonomy tiers (all agents)                         |
| `BASE_AGENTS.md` | Git, memory, handoff, logging, and communication rules (all agents) |

Per-group files (`USER.md`, `learnings.md`, `heartbeat.md`, `tasks/`) remain in each group's own folder.

## Adding a New Agent

1. Create `agents/[name].md` following the template structure
2. Add to this README
3. Update the orchestration logic to route tasks to the new agent
4. Add any new task types to `tasks/README.md`
