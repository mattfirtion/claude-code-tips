#!/usr/bin/env node
// sync-copilot.mjs — symlink ~/.claude/commands/*.md into VSCode prompts dirs as *.prompt.md
//                    so they show up as `/name` slash commands in VSCode chat.
// Agents are intentionally NOT mirrored — Claude Code extension already exposes them and
// extra copies caused triplicate entries in the picker.
// Pure Node ESM, no deps. Run: node ~/.claude/bin/sync-copilot.mjs [--dry-run|--check|--only NAME]

import { readdirSync, existsSync, statSync, lstatSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const COMMANDS_DIR = join(ROOT, 'commands');

const VSCODE_PROMPT_DIRS = [
  join(HOME, 'Library', 'Application Support', 'Code', 'User', 'prompts'),
  join(HOME, 'Library', 'Application Support', 'Code - Insiders', 'User', 'prompts'),
].filter(p => existsSync(p));

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const log = (...a) => console.log('[sync-prompts]', ...a);
const warn = (...a) => console.warn('[sync-prompts] WARN', ...a);
const fail = (m) => { console.error('[sync-prompts] FAIL', m); process.exit(2); };

function listCommands() {
  if (!existsSync(COMMANDS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(COMMANDS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const full = join(COMMANDS_DIR, f);
    if (statSync(full).isDirectory()) continue;
    if (ONLY && basename(f, '.md') !== ONLY) continue;
    out.push(full);
  }
  return out;
}

function planSymlinks(sources) {
  const changes = [];
  let unchanged = 0;
  const skippedRegular = [];
  for (const dir of VSCODE_PROMPT_DIRS) {
    for (const src of sources) {
      const dest = join(dir, `${basename(src, '.md')}.prompt.md`);
      let lst = null;
      try { lst = lstatSync(dest); } catch {}
      if (lst && !lst.isSymbolicLink()) { skippedRegular.push(dest); continue; }
      if (lst && lst.isSymbolicLink()) {
        if (readlinkSync(dest) === src) { unchanged++; continue; }
        changes.push({ dest, src, kind: 'relink' });
        continue;
      }
      changes.push({ dest, src, kind: 'new' });
    }
  }
  return { changes, unchanged, skippedRegular };
}

function applyChange(c) {
  if (c.kind === 'relink') unlinkSync(c.dest);
  symlinkSync(c.src, c.dest);
}

function main() {
  if (VSCODE_PROMPT_DIRS.length === 0) { log('no VSCode prompts dirs found — nothing to do'); return; }
  const sources = listCommands();
  if (sources.length === 0) {
    if (ONLY) { warn(`--only ${ONLY} matched no command files`); return; }
    fail('no command files found');
  }

  const { changes, unchanged, skippedRegular } = planSymlinks(sources);

  if (CHECK) {
    if (changes.length > 0) {
      console.error(`[sync-prompts] CHECK FAILED — ${changes.length} symlink(s) out of sync:`);
      for (const c of changes) console.error(`  ${c.kind === 'new' ? 'NEW ' : 'DIFF'}: ${c.dest}`);
      process.exit(1);
    }
    log(`CHECK ok — ${unchanged} symlinks in sync across ${VSCODE_PROMPT_DIRS.length} dir(s)`);
    process.exit(0);
  }

  let linked = 0, relinked = 0;
  for (const c of changes) {
    if (DRY) log(`${c.kind === 'new' ? 'NEW ' : 'DIFF'} ${c.dest} -> ${c.src}`);
    else applyChange(c);
    if (c.kind === 'new') linked++; else relinked++;
  }
  log(`${DRY ? 'would link' : 'linked'}: ${linked} new, ${relinked} relinked, ${unchanged} unchanged across ${VSCODE_PROMPT_DIRS.length} dir(s)`);
  for (const p of skippedRegular) warn(`skipped non-symlink (manual file): ${p}`);
}

main();
