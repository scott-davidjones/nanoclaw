# BASE_AGENTS.md — Shared Operational Rules

All agents follow these rules. They cover git, memory, handoffs, logging, and communication. Domain-specific rules live in each agent's own file.

---

## Session Startup Checklist

Every agent, at the start of every task:

1. Read `BASE_SOUL.md` — your values and autonomy rules
2. Read `USER.md` — who you're working for and how they like to work
3. Read `learnings.md` — mistakes and lessons from all past sessions
4. Recall memory via `mcp__memory__recall` for the relevant project
5. Read your task file from `/workspace/group/tasks/`
6. If the task involves writing, reviewing, or testing code — read the relevant stack standards from `/workspace/brain/standards/` (see **Stack Standards** below)
7. Update `heartbeat.md` with your name, timestamp, and what you're starting

---

## Git Rules (Non-Negotiable)

```bash
git config user.name "Scott-David Jones"
git config user.email "scott@in-line.studio"
```

- **Check the task file for an existing branch/PR first** — if `branch` or `pr_url` is already set, use that branch. Do NOT create a new branch for work already in progress.
- **Only create a new branch for genuinely new work** with no existing branch — `feature/task-NNN-title` for features, `fix/task-NNN-title` for bugs
- **Tasks that touch the same codebase MUST share the same branch.** Before creating a new branch, check what branches/PRs are already open for this project. If there is an active feature branch (even from a different task), use it. One shared branch, one PR — do not fragment related work across multiple branches.
- **NEVER work on `main`** — not even a typo fix, not even "just a quick change"
- **Every piece of work MUST have a PR** — no exceptions, no direct merges
- **No `Co-Authored-By`** lines in any commit message
- Commit messages: present tense, descriptive ("Add mobile hamburger menu" not "Added...")
- Commit messages: clear and descriptive, present tense ("Add user authentication" not "Added...")

---

## Memory Protocol

**Reading:**
- Always call `mcp__memory__recall` at the start of a task with the project name
- Read `learnings.md` for file-based lessons

**Writing:**
- Use `mcp__memory__remember` to store important discoveries, patterns, and decisions
- Append to `learnings.md` when something goes wrong or a better pattern is found
- Write to the daily log at `/workspace/group/logs/YYYY-MM-DD.md`

---

## Stack Standards

The studio's engineering standards live in `/workspace/brain/standards/` — a read-only mount of the canonical brain repo. These standards apply to every project and are the source of truth for how In-Line Studio writes code.

**What's there:**

- `/workspace/brain/standards/CLAUDE.md` — global non-negotiable rules (check stacks/ before starting, follow existing patterns, never introduce dependencies without checking)
- `/workspace/brain/standards/stacks/laravel.md` — PHP/Laravel: Boost tooling, PHP 8.3, Pint, Pest, Vite, deployment pattern
- `/workspace/brain/standards/stacks/craft-cms.md` — Craft CMS: Project Config rules, `craft up --interactive=0`, deployment
- `/workspace/brain/standards/stacks/flutter.md` — Flutter: Riverpod, fastlane, GitHub Actions
- `/workspace/brain/standards/stacks/vue-typescript.md` — Vue 3 Composition API, TypeScript strict, pnpm, Pinia, Axios
- `/workspace/brain/standards/stacks/python.md` — Python 3.12+, uv, Ruff, pytest, strict mypy

**When to read what:**

- **Always read** `/workspace/brain/standards/CLAUDE.md` at task start — it's short and applies universally
- **Read the relevant stack file** when the task touches that stack:
  - PHP/Blade files → `laravel.md`
  - Twig templates or `config/project/` → `craft-cms.md`
  - `.dart` files → `flutter.md`
  - `.vue`, `.ts`, `.tsx` files → `vue-typescript.md`
  - `.py` files → `python.md`
- **Read multiple stack files** for polyglot projects (e.g. a Laravel + Vue app reads both `laravel.md` and `vue-typescript.md`)

**If `/workspace/brain/` does not exist:** the host doesn't have `BRAIN_ROOT` set. Proceed with the standards in the agent's own instruction file and memory — but note the gap in `learnings.md` so it can be fixed.

**Never write to `/workspace/brain/`** — it's read-only by design. The canonical brain repo is managed on the host via git, not from inside agent containers. If you believe a standard needs changing, raise it via `mcp__nanoclaw__send_message` to Scott-David rather than trying to edit.

**These standards complement, not replace, your agent instructions.** Your agent file (developer.md, reviewer.md, etc) defines *what you do and in what order*. The brain repo defines *how the studio writes code in a given stack*. Both apply.

---

## Test Database

Some tasks — especially those involving UI testing, authentication flows, or database-driven features — require a test database.

- **Developer Agent:** If your task requires database interactions for testing, note the test DB requirements in the task file under `test_requirements`
- **Tester Agent:** Check `test_requirements` in the task file before running tests. If a test database is needed and not available, **ask Scott-David** before proceeding — do not skip tests or mock data that should be real
- Test database credentials must never be hardcoded — use `.env.testing` following Laravel conventions
- Never run tests against the production database

---

## Ask and Wait Protocol

When you need input from Scott-David:

1. Write a question file:
   ```
   /workspace/group/tasks/pending/task_NNN_question.json
   ```
   ```json
   {
     "task_id": "task_NNN",
     "agent": "your-agent-name",
     "question": "Single, specific question",
     "context": "Why you need this before proceeding",
     "options": ["option A", "option B"],
     "asked_at": "ISO timestamp"
   }
   ```

2. Update the task status to `waiting_for_user`

3. Send a message via `mcp__nanoclaw__send_message`:
   - Use your agent name as `sender`
   - Keep it short: what you're stuck on and what you need
   - Example: *"Task 001: Before building the auth system, do you want to use Laravel Sanctum (API tokens) or Fortify (session-based)?"*

4. **Stop completely.** Do not guess. Do not proceed with assumptions.

---

## Handoff Protocol

When completing work and passing to the next agent:

1. Update the task JSON file with new status and assigned_to
2. Add a history entry with timestamp, your name, action, and notes
3. Write to `heartbeat.md`:
   ```
   | [timestamp] | [Your Agent] | Handed off to [Next Agent] | Task NNN: [title] |
   ```
4. Send a message via `mcp__nanoclaw__send_message` summarising what was done and what's next
5. Stop — do not proceed into the next agent's domain

---

## Daily Logging

Append to `/workspace/group/logs/YYYY-MM-DD.md` at task completion:

```markdown
## [HH:MM UTC] [Agent Name] — Task NNN: [title]
**Status:** [what happened]
**Actions:** [bullet list of what was done]
**Decisions:** [any choices made and why]
**Issues:** [anything that went wrong or was flagged]
**Handed to:** [next agent or "complete"]
```

---

## Heartbeat.md

Append a row to the table when you start a task, and again when you finish:

```
| 2026-03-30T12:00:00Z | Developer Agent | Started | Task 001: Add authentication |
| 2026-03-30T13:15:00Z | Developer Agent | Handed to Tester | Task 001: PR #42 opened |
```

---

## Communication

- Use `mcp__nanoclaw__send_message` with your `sender` name set to your agent name and emoji
- The message will be delivered to whichever channel the task originated from — you do not need to know the channel
- Keep messages short — 2-4 sentences max per message
- Use *single asterisks* for bold, _underscores_ for italic
- No markdown headings, no `[links](url)`, no `**double asterisks**`
- For long updates, send multiple short messages rather than one wall of text

### Progress Updates (Required)

Progress updates are **checkpoint-based**, not time-based. Send one at every meaningful step — do not batch them up at the end.

**Always include the project name.** Multiple projects may be in the pipeline simultaneously across different channels. Every status message must start with the project name in brackets so the recipient knows which project the update is for.

**Mandatory checkpoints — send a message at EACH of these:**

1. **Task start** — immediately when you begin:
   e.g. _"[WorkThing] Starting task 001 — mobile responsiveness fixes. 0% done."_

2. **After reading/analysing** — once you've reviewed the files/code/task:
   e.g. _"[WorkThing] Reviewed all 3 files. TaskDetailModal is the main issue. Starting fixes — 15% done."_

3. **After each major change** — after each file or significant chunk of work:
   e.g. _"[WorkThing] TaskDetailModal layout fixed. Moving on to TaskTableView — 40% done."_
   e.g. _"[WorkThing] TaskTableView column hiding done. Fixing AppLayout min-w-0 — 70% done."_

4. **Before finalising** — just before committing/pushing/opening PR:
   e.g. _"[WorkThing] All fixes done. Opening PR now — 90% done."_

5. **Completion** — when handing off to the next agent:
   e.g. _"[WorkThing] Task 001 done — PR #2 opened. Handed to Tester Agent. ✅"_

**Determining the project name:** Read the project's `composer.json` `name` field, `package.json` `name` field, or the repository name from `git remote -v`. Use whichever is most human-readable (e.g. "WorkThing" not "workthing/api"). If none are available, use the working directory name.

Keep each message to one line. Never skip checkpoints even if the task runs quickly.
