---
name: e2e
description: Supervised E2E sweep. Args - full | diff | <route|path>. No arg = auto-detect (dirty=diff, clean=full). Asks before each patch. Stack-aware Flutter (dart-mcp) or web (agent-browser).
argument-hint: "[full|diff|<path>] [--screenshots all] [--parallel N]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task, AskUserQuestion, PushNotification, TaskStop, Monitor, advisor, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__index_repository, mcp__codebase-memory-mcp__detect_changes, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__search_code, mcp__codebase-memory-mcp__trace_path, mcp__codebase-memory-mcp__query_graph, mcp__codebase-memory-mcp__get_code_snippet, mcp__plugin_context-mode_context-mode__ctx_batch_execute, mcp__plugin_context-mode_context-mode__ctx_execute, mcp__plugin_context-mode_context-mode__ctx_search, mcp__dart__analyze_files, mcp__flutter-driver__list_devices, mcp__flutter-driver__start_app, mcp__flutter-driver__stop_app, mcp__flutter-driver__pilot_hot_restart, mcp__flutter-driver__start_recording, mcp__flutter-driver__stop_recording, mcp__flutter-driver__read_logs
---

E2E supervised sweep target: $ARGUMENTS  Mode: **supervised** (ask before each patch).

Same orchestration as `/e2e-auto` but interactive. Run in main conversation (main-only convention, avoid runaway nesting). Plan flows here, dispatch per-flow runners parallel via Agent tool.

Load `e2e-protocol` skill for shared rules, plan template, issue format, report template.

## Args

Same as `/e2e-auto`: `full` | `diff` | `<path>` | (auto-detect). Plus `--screenshots all` + `--parallel N`.

## Differences from `/e2e-auto`

| Phase | supervised (`/e2e`) | auto (`/e2e-auto`) |
|---|---|---|
| Stack ambiguous / boot fails | `AskUserQuestion` | PushNotification + abort |
| Triage on FAIL | `AskUserQuestion` regression / spec-gap / flake | auto-classify (logs touch recent file → regression; UI absent → spec-gap; else regression) |
| Patch approval | `AskUserQuestion` show diff (approve / reject / edit) | direct `Edit` |
| Escalate (>3 retries / reject) | `AskUserQuestion` continue / abort | `PushNotification` + skip flow, continue |
| Final | print report | `PushNotification` + print report |

## Procedure

Follow `/e2e-auto` Phases 0 → 9. Swap behaviors per table above.

Spawn runners via Agent tool, one per flow, up to `parallel` concurrent single message:
- flutter → `e2e-flutter-runner`
- web → `e2e-web-runner`

## Rules — NEVER violate

Inherit all rules `/e2e-auto` + `e2e-protocol` skill. Plus: supervised mode never apply patch without explicit user approval via `AskUserQuestion`.