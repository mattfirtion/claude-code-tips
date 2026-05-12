#!/usr/bin/env node
// sync-runner-tools.mjs — keep subagent `tools:` frontmatter in sync with live MCP servers.
//
// Why:
//   Subagent frontmatter wildcard `mcp__server__*` is broken (anthropics/claude-code#17928)
//   and Task-spawned subagents don't inherit MCP tools (#30280). So we must hand-list every
//   tool. This script regenerates the list automatically: it speaks MCP stdio JSONRPC to each
//   server, calls `tools/list`, and rewrites the `tools:` line in the target agent file.
//
// Usage:
//   node ~/.claude/bin/sync-runner-tools.mjs            # write
//   node ~/.claude/bin/sync-runner-tools.mjs --dry-run  # show diff, no write
//   node ~/.claude/bin/sync-runner-tools.mjs --check    # exit 1 if drift
//   node ~/.claude/bin/sync-runner-tools.mjs --only e2e-flutter-runner
//
// Pure Node ESM, no deps.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const repoAgentsDir = join(ROOT, 'agents');
const repoRunnerAgent = join(repoAgentsDir, 'e2e-flutter-runner.md');
const AGENTS_DIR = process.env.CLAUDE_AGENTS_DIR
  ? resolve(process.env.CLAUDE_AGENTS_DIR)
  : existsSync(repoRunnerAgent)
    ? repoAgentsDir
    : join(homedir(), '.claude', 'agents');

// Targets. Each entry = one agent file whose `tools:` line we own.
//   base        — non-MCP tools always included (order preserved).
//   cbmTools    — codebase-memory-mcp tools used by the agent.
//   ctxTools    — context-mode tools used by the agent.
//   mcpServers  — MCP servers to enumerate. `cmd` is spawn argv; `name` becomes
//                 the prefix in `mcp__<name>__<tool>`. `optional: true` = warn but
//                 don't fail if the server can't be probed (e.g. registry offline).
//                 `deny` strips specific tool names from the probe result — use for
//                 lifecycle tools the orchestrator owns (start_app, stop_app, etc.)
//                 so the runner can't accidentally call them.
const TARGETS = [
  {
    file: 'e2e-flutter-runner.md',
    base: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    cbmTools: ['search_graph', 'trace_path', 'get_code_snippet', 'search_code'],
    ctxTools: ['ctx_batch_execute', 'ctx_execute'],
    mcpServers: [
      {
        name: 'flutter-driver',
        cmd: ['npx', '-y', 'flutter-driver-mcp'],
        optional: false,
        // Orchestrator (/e2e + /e2e-auto) owns the app lifecycle; runner must not call these.
        deny: ['start_app', 'stop_app', 'start_recording', 'stop_recording'],
      },
    ],
  },
];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const VERBOSE = args.includes('-v') || args.includes('--verbose');

const log = (...a) => console.log('[sync-runner-tools]', ...a);
const warn = (...a) => console.warn('[sync-runner-tools] WARN', ...a);
const fail = (m) => { console.error('[sync-runner-tools] FAIL', m); process.exit(2); };
const dbg = (...a) => { if (VERBOSE) console.log('[sync-runner-tools] dbg', ...a); };

// ---- MCP stdio JSONRPC client (minimal) ----------------------------------------------------

async function listToolsViaStdio(serverName, argv, timeoutMs = 30000) {
  return new Promise((resolvePromise, rejectPromise) => {
    dbg(`spawning ${serverName}: ${argv.join(' ')}`);
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const tools = [];
    const deadline = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      rejectPromise(new Error(`${serverName}: tools/list timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      rejectPromise(new Error(`${serverName}: spawn failed — ${e.message}`));
    });

    child.stderr.on('data', (d) => dbg(`${serverName} stderr:`, d.toString().trim()));

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        dbg(`${serverName} <-`, JSON.stringify(msg).slice(0, 200));
        if (msg.id === 1 && msg.result) {
          send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
          send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 1 && msg.error) {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          try { child.kill('SIGTERM'); } catch {}
          rejectPromise(new Error(`${serverName}: initialize error — ${JSON.stringify(msg.error)}`));
        } else if (msg.id === 2 && msg.result?.tools) {
          for (const t of msg.result.tools) tools.push(t.name);
          if (done) return;
          done = true;
          clearTimeout(deadline);
          try { child.kill('SIGTERM'); } catch {}
          resolvePromise(tools);
        } else if (msg.id === 2 && msg.error) {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          try { child.kill('SIGTERM'); } catch {}
          rejectPromise(new Error(`${serverName}: tools/list error — ${JSON.stringify(msg.error)}`));
        }
      }
    });

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sync-runner-tools', version: '1' },
      },
    });
  });
}

function send(child, payload) {
  child.stdin.write(JSON.stringify(payload) + '\n');
}

// ---- Compose tools line --------------------------------------------------------------------

function composeToolsLine(target, mcpToolsByServer) {
  const parts = [...target.base];
  for (const t of target.cbmTools) parts.push(`mcp__codebase-memory-mcp__${t}`);
  for (const t of target.ctxTools) parts.push(`mcp__plugin_context-mode_context-mode__${t}`);
  for (const server of target.mcpServers) {
    const denied = new Set(server.deny ?? []);
    const tools = (mcpToolsByServer.get(server.name) ?? []).filter((t) => !denied.has(t));
    for (const t of tools) parts.push(`mcp__${server.name}__${t}`);
  }
  return `tools: ${parts.join(', ')}`;
}

// ---- Rewrite agent file --------------------------------------------------------------------

function readAgent(filePath) {
  if (!existsSync(filePath)) fail(`agent file not found: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

function replaceToolsLine(content, newLine) {
  const lines = content.split('\n');
  let inFront = false, fenceCount = 0, replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      fenceCount++;
      inFront = fenceCount === 1;
      if (fenceCount === 2) break;
      continue;
    }
    if (inFront && /^tools:\s/.test(lines[i])) {
      if (lines[i] === newLine) return { content, changed: false };
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }
  if (!replaced) fail('no `tools:` line found inside frontmatter');
  return { content: lines.join('\n'), changed: true };
}

// ---- Main ----------------------------------------------------------------------------------

async function processTarget(target) {
  const filePath = join(AGENTS_DIR, target.file);
  if (ONLY && target.file.replace(/\.md$/, '') !== ONLY) {
    dbg(`skip ${target.file} (--only ${ONLY})`);
    return { skipped: true };
  }
  log(`probing ${target.mcpServers.length} MCP server(s) for ${target.file}`);

  const mcpToolsByServer = new Map();
  for (const server of target.mcpServers) {
    try {
      const tools = await listToolsViaStdio(server.name, server.cmd);
      tools.sort(); // stable order = stable git diff when MCP server adds/removes tools
      log(`  ${server.name}: ${tools.length} tools`);
      mcpToolsByServer.set(server.name, tools);
    } catch (e) {
      if (server.optional) {
        warn(`  ${server.name}: ${e.message} (optional, skipping)`);
        mcpToolsByServer.set(server.name, []);
      } else {
        fail(`  ${server.name}: ${e.message}`);
      }
    }
  }

  const content = readAgent(filePath);
  const newLine = composeToolsLine(target, mcpToolsByServer);
  const { content: updated, changed } = replaceToolsLine(content, newLine);

  if (!changed) {
    log(`  ${target.file}: in sync`);
    return { changed: false };
  }

  if (CHECK) {
    console.error(`[sync-runner-tools] CHECK FAILED — ${target.file} drift detected`);
    console.error('  expected:', newLine.slice(0, 400) + (newLine.length > 400 ? '...' : ''));
    return { changed: true, drift: true };
  }

  if (DRY) {
    log(`  ${target.file}: would rewrite`);
    log('  new line:', newLine.slice(0, 400) + (newLine.length > 400 ? '...' : ''));
    return { changed: true };
  }

  writeFileSync(filePath, updated);
  log(`  ${target.file}: updated`);
  return { changed: true };
}

(async () => {
  let drift = 0, updated = 0;
  for (const target of TARGETS) {
    const r = await processTarget(target);
    if (r.skipped) continue;
    if (r.drift) drift++;
    else if (r.changed) updated++;
  }
  if (CHECK && drift > 0) process.exit(1);
  log(DRY ? `done (dry-run): ${updated} would update` : `done: ${updated} updated`);
})().catch((e) => fail(e.stack || e.message));
