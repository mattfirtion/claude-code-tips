---
name: e2e-auto
description: Unattended E2E sweep. Detects stack (flutter|web), boots app, plans flows, dispatches per-flow runners in parallel, auto-triages + auto-patches failures, advisor + report. Push-notifies start/escalate/finish. Walk away after launch.
argument-hint: "[full|diff|<path>] [--screenshots all] [--parallel N]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task, AskUserQuestion, PushNotification, TaskStop, Monitor, advisor, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__index_repository, mcp__codebase-memory-mcp__detect_changes, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__search_code, mcp__codebase-memory-mcp__trace_path, mcp__codebase-memory-mcp__query_graph, mcp__codebase-memory-mcp__get_code_snippet, mcp__plugin_context-mode_context-mode__ctx_batch_execute, mcp__plugin_context-mode_context-mode__ctx_execute, mcp__plugin_context-mode_context-mode__ctx_search, mcp__dart__analyze_files, mcp__flutter-driver__list_devices, mcp__flutter-driver__start_app, mcp__flutter-driver__stop_app, mcp__flutter-driver__pilot_hot_restart, mcp__flutter-driver__start_recording, mcp__flutter-driver__stop_recording, mcp__flutter-driver__read_logs
---

E2E auto sweep target: $ARGUMENTS  Mode: **auto** (no prompts, push-notifies).

⚠️ Auto mode patch regression no ask. Verify lint+typecheck+tests before tick `resolved`. `retry_count>3` → mark escalated + push-notify + skip flow + continue.

Command = **orchestrator, run main conversation** (main-only, avoid runaway nesting). Plan flows here, spawn per-flow runner agents parallel via Agent tool.

Load `e2e-protocol` skill for shared rules, plan template, issue format, report template.

## Args

- `full` | `diff` | `<path>` — scope. No arg → auto-detect: `git diff HEAD --name-only` non-empty → `diff`, else `full`.
- `--screenshots all` (default `fail`)
- `--parallel N` (default 3, cap 3 per Anthropic chained-spawn guidance)

## Phase 0 — Index + stack detect

1. `mcp__codebase-memory-mcp__index_status(project:<cwd-name>)`. Unindexed:
   - Call `mcp__codebase-memory-mcp__index_repository(repo_path:<cwd>, mode:"full")`.
   - Poll `index_status` every 5s until indexed (or `Monitor` with `until` check on status field). No proceed before indexed — flow discovery depend on it.
2. Stack via `mcp__plugin_context-mode_context-mode__ctx_batch_execute`:
   - `pubspec.yaml` only → `stack=flutter`
   - `package.json` only → `stack=web`
   - both → infer from `$ARGUMENTS` path. Still ambiguous → abort + push-notify.
   - neither → abort.

## Phase 1 — Tool gate (NEVER skip — anti-fraud per e2e-protocol)

**flutter**: try `mcp__flutter-driver__list_devices`. Fail / not callable → write `docs/e2e/<RUN_ID>/report.md` status `ABORTED — flutter-driver-mcp not available. Install: claude mcp add --transport stdio flutter-driver -- npx flutter-driver-mcp` + PushNotification + exit. **NO `flutter test` fallback.**

(dart-mcp `analyze_files` also Phase 3 compile check; dart-mcp missing → Phase 3 fall back `Bash("flutter analyze")` — substitution OK because pre-flight compile gate, not UI-drive step.)

**web**: `Bash("command -v agent-browser && agent-browser --version")`. Exit non-zero → write `docs/e2e/<RUN_ID>/report.md` status `ABORTED — agent-browser not available. Install: npm install -g agent-browser` + PushNotification + exit. **NO `curl` fallback.**

## Phase 2 — Setup

Run via `Bash`:

```sh
RUN_ID="${CLAUDE_SESSION_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
ARTIFACTS="docs/e2e/$RUN_ID"
mkdir -p "$ARTIFACTS/screenshots" "$ARTIFACTS/plans"
echo "$RUN_ID" "$ARTIFACTS"
```

`${CLAUDE_SESSION_ID}` so artifact dir correlate Claude Code session log; fall back UTC timestamp if env var unset (older harness).

Write initial `$ARTIFACTS/state.json` per `e2e-protocol` schema. PushNotification: `"E2E auto run <RUN_ID> started"`.

## Phase 3 — Boot

**flutter**:
1. `mcp__flutter-driver__list_devices` → pick iOS sim (or asked device class). None → PushNotification + abort.
2. Compile gate: `mcp__dart__analyze_files` (or fallback `Bash("flutter analyze")`). Red errors → abort (no "test green parts").
3. `mcp__flutter-driver__start_app(projectPath:<cwd>, deviceId:<id>)`. Inject harness, run `flutter run`, connect WebSocket. Surface real build errors. Wait ready. Save `device_id` → state.json.
4. Optional: `mcp__flutter-driver__start_recording` for full-session video (auto-stop after 5 min or on `stop_app`). Save `recording_path` → state.json.

**web**:
1. Read `package.json scripts.dev`, parse port. Default `http://localhost:3000`.
2. `curl -sf <url>` → 200 = skip. Else → spawn `npm/yarn/pnpm/bun run dev` via `Bash(run_in_background:true)`. **Capture returned `task_id` (background shell id) into `state.json.bg_shell_id` so Phase 9 cleanup `TaskStop` it.** Poll `until curl -sf <url>; do sleep 1; done` via `ctx_execute`, cap 60s.
3. `agent-browser --session e2e-<run-id> --headed open <url>`. Save `dev_url` + `session_name` → state.json.

Boot fail → PushNotification + ABORTED report + exit (still attempt cleanup if `bg_shell_id` set).

## Phase 4 — Discover flows (CBM-first)

### `scope=full`
- `mcp__codebase-memory-mcp__get_architecture(aspects:['routes','features'])`
- flutter: `search_graph(label:'Route')`. Empty → `search_code(pattern:'GoRoute\\(', regex:true, file_pattern:'*.dart')`. Plus `search_graph(name_pattern:'.*(Screen|Page|View)$')`.
- web: Next → glob `app/**/page.{ts,tsx,js,jsx}` + `pages/**/*`. React Router → `search_code(pattern:'<Route\\s', regex:true)`. Svelte → `src/routes/**`. Vue → `src/views/**`.
- Critical journeys: auth (`login|signin|auth`), checkout (`cart|checkout|stripe`), settings (`settings|profile|account`).
- Flow list = top routes ∪ journeys.

### `scope=diff`
- `git diff HEAD --name-only` → files. Each changed symbol → `trace_path(mode:'calls', direction:'inbound', depth:4)` → impacted screens. Dedupe.

### `scope=<path>`
- Single flow rooted there. `trace_path` outbound for downstream.

## Phase 5 — Plan (per-flow files)

Per flow, write `$ARTIFACTS/plans/<slug>.md` use plan template from `e2e-protocol` skill.

Write `$ARTIFACTS/plans/INDEX.md`:
```markdown
# Flow index — <RUN_ID>
- [ ] <flow-a>  → plans/<flow-a>.md
- [ ] <flow-b>  → plans/<flow-b>.md
```

Update `state.json.flows`.

## Phase 6 — Dispatch runners (parallel, cap=`parallel`)

Spawn one Agent per flow via Agent tool, up to `parallel` concurrent in single message. Subagent type:
- flutter → `e2e-flutter-runner`
- web → `e2e-web-runner`

Self-contained spawn prompt template:

```
Run E2E flow <flow-slug>.
plan-file: <ARTIFACTS>/plans/<flow-slug>.md  (you OWN it)
issues-file: <ARTIFACTS>/issues.md  (append via tmp + ctx_execute cat >>)
screenshot-dir: <ARTIFACTS>/screenshots/<flow-slug>/
screenshot-policy: <fail|all>
run-id: <RUN_ID>
device-id: <from state.json>      # flutter only
dev-url: <from state.json>        # web only
session-name: e2e-<RUN_ID>        # web only

Follow procedure in your agent definition. Tick PASS, halt + log + return on first FAIL.
Return ≤150 words: status + counts + tool-call total + screenshot path.
```

After each batch return, update `state.json.flows[<slug>]` with status + `tool_calls` count from runner return.

## Phase 7 — Halt → triage → fix → resume

Per runner returning `HALT <flow>/<step>`:

1. Read `$ARTIFACTS/issues.md` → newest open `- [ ] resolved`.
2. **Auto-triage** per `e2e-protocol` skill triage table (regression / spec-gap / flake). Auto mode: classify direct from signals (no `AskUserQuestion`); spec-gap → mark plan line `[~] (spec: …)`, skip, log; flake → re-run step once, still fail → regression.
3. **Locate**: `search_graph` + `trace_path` on log symbols.
4. **Patch** direct via `Edit` (autofix=auto).
5. **Ripple** — `trace_path(mode:'calls', direction:'inbound')` on changed symbol. Update every caller.
6. **Verify** via `ctx_batch_execute`:
   - flutter: `dart analyze` + `dart format --set-exit-if-changed .` + `flutter test test/<related>`
   - web: `npm run lint` + `tsc --noEmit` + `npm test -- <related>`
   - All green → continue. Any fail → loop step 4 (max 3 retries `state.json.retry_count[<flow>/<step>]`).
7. **Tick** `[ ]` → `[x] resolved` in issues.md.
8. **Resume** same runner type, same flow, `resume-from: <step-slug>` (skip `[x]` lines above).
9. **Escalate** (`retry_count>3`):
   - Mark issue header `## ⚠️ ESCALATED <flow>/<step>`.
   - `PushNotification("E2E escalated: <flow>/<step>. Run <RUN_ID>.")`
   - Skip flow, continue next batch.

## Phase 8 — Advisor + report

All flows green / spec-gap / escalated:

1. `advisor()` — full transcript forwarded.
2. Apply recs OR document declined under `## Advisor notes`.
3. Write `$ARTIFACTS/report.md` per `e2e-protocol` template. Tool-call audit section MUST include per-flow count from `state.json.flows[<slug>].tool_calls`. Any flow 0 → status `ABORTED` regardless of pass count.
4. Print path + totals.
5. `PushNotification("E2E done. <Y>/<X> pass. <W> escalated. Run <RUN_ID>.")`

## Phase 9 — Cleanup (always, even on abort)

Read `state.json` first; clean up only what started.

- flutter (if `device_id` set): recording active → `mcp__flutter-driver__stop_recording` (also auto-called by stop_app), then `mcp__flutter-driver__stop_app`. Save final recording path to report.
- web (if `session_name` set): `agent-browser --session <session_name> close`.
- web (if `bg_shell_id` set, meaning we spawned dev server): `TaskStop({task_id: <bg_shell_id>})`. Skip if user already had server running.

## Rules — NEVER violate (extends e2e-protocol)

1. Skip Phase 1 tool gate — never. No degrade to unit tests.
2. Spawn >`parallel` runners — never.
3. Spawn wrong runner for stack — never.
4. Tick `[x] resolved` without lint+typecheck+tests green — never.
5. Edit without ripple check — never.
6. Mark report status `PASSED` if any in-scope flow has 0 tool calls — never. Status = `ABORTED`.
7. `PushNotification` on escalate — always.
8. `advisor()` before `report.md` — always.