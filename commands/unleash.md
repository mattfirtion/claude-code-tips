---
name: unleash
description: Spawn full agent swarm (12 specialists) in parallel to review target code. Use /unleash [path|feature|branch] or /unleash for current changes.
argument-hint: "[path|feature|branch] (omit = uncommitted changes)"
allowed-tools: [Bash, Read, Glob, Grep, Agent, Task, mcp__codebase-memory-mcp__index_repository, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__detect_changes, mcp__plugin_context-mode_context-mode__ctx_batch_execute]
---

Unleash agent swarm on: $ARGUMENTS

No target = review all uncommitted changes (`git diff --name-only`).

## Pre-flight

Before spawn agents, index repo via CBM:
```
mcp__codebase-memory-mcp__index_repository(repo_path: <cwd>, mode: "full")
```
Wait index done before spawn agent.

### Stack detection

Detect stack pick conditional agents. Scope detection to files in $ARGUMENTS (or changed files). Use `ctx_batch_execute` check:
- `flutter` → any `*.dart` OR `pubspec.yaml` present
- `react` → any `*.tsx`/`*.jsx` OR `"react"`/`"next"` in `package.json` deps OR `next.config.*`
- `typescript` → any `*.ts`/`*.tsx` OR `tsconfig.json`
- `backend-data` → backend SDK deps/imports, schema files, migrations, API routes, or cloud functions
- `web-ui` → any `*.html`/`*.tsx`/`*.jsx`/`*.vue`/`*.svelte`

Record matched set. None matched = skip stack-specific agents. If a named local subagent type is missing, skip it and record the gap.

## Execute

Spawn agent team. Core 12 always spawn:

1. `ux-reviewer` — UI/UX, a11y, interaction patterns
2. `naive-tester` — "Can my mom use this?" Simplicity, confusion, ease
3. `user-flow-auditor` — E2E journeys, routes, transitions, guards, edge paths, flow docs
4. `qa-engineer` — Test gaps, edge cases, write failing tests (TDD)
5. `staff-engineer` — Architecture, quality, abstractions, debt
6. `security-reviewer` — Auth, data exposure, injection, permissions
7. `perf-engineer` — Renders, memory, jank, async, network
8. `api-designer` — Schema, queries, data layer, API design
9. `devops-engineer` — CI/CD, builds, deploy configs, infra
10. `junior-dev` — Readability, findability, clarity. Flags cleverness + tribal knowledge
11. `reuse-auditor` — DRY/SSOT, design-system adherence, dup/near-dup widgets. Recommends reuse-existing vs extract-shared w/ exact paths.
12. `edge-case-hunter` — Paranoid edge-case + ripple/connection + future-proof. Enumerates empty/null/boundary/concurrency/tz/unicode/overflow/permission/network cases, traces every caller via CBM, flags silent-fail + future-break assumptions.

Each agent:
- Work independent parallel
- Target files/feature from $ARGUMENTS
- Report defined output format
- TDD mandate: every issue include test strategy

### Conditional stack agents

Spawn ONLY when stack detected. Parallel w/ core 12. Skip unmatched.

- **flutter** (`*.dart` / `pubspec.yaml`) → `flutter-auditor`
- **react/next OR typescript** (`*.tsx`/`*.ts`/react-or-next dep) → `react-ts-auditor`
- **web-ui** (`*.html`/`*.tsx`/`*.jsx`/`*.vue`/`*.svelte`) → `web-ui-auditor`
- **backend-data** (SDK deps/imports, schema, routes, migrations, or cloud functions) → matching local backend/data auditor

Pure Dart repo → `flutter-auditor` only.
Pure Next.js repo → `react-ts-auditor` + `web-ui-auditor`.
Mobile app + backend/data service → `flutter-auditor` + matching local backend/data auditor.
Nothing detected → core 12 only.

## Synthesize

After 12 report, merge single prioritized list:

```
## 🔴 Must fix before merge
## 🟡 Should fix (ticket-worthy)
## 🟢 Future improvements
## ✅ Passing (no issues found)
```

Worktree isolation for write-capable agents (qa-engineer). Read-only agents share context.
