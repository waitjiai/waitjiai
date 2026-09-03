#!/usr/bin/env node
// WaitJI AI — Claude Code CLI status-line renderer.
//
// Claude Code invokes this as the user's configured `statusLine` command and
// renders whatever we print to stdout. We only ever print:
//   1) the current cached ad (if fresh), as a clickable OSC 8 hyperlink, then
//   2) whatever the user's own previous status-line command would have
//      printed, on the line(s) below — so installing this never removes
//      anything the user already had (git branch, model, cost, etc).
//
// Hard rules this script follows:
//   - Never throw. A bug here must never break the user's Claude Code CLI.
//   - Never make a network call. It only reads two small local JSON files
//     that the VS Code extension keeps up to date.
//   - Never hang. The chained previous command is bounded by a hard timeout.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FRESH_MS = 90_000;
const CHAIN_TIMEOUT_MS = 1500;

const DATA_DIR = process.argv[2];
const AD_CACHE = DATA_DIR ? join(DATA_DIR, 'statusline-ad-cache.json') : null;
const PREV_CACHE = DATA_DIR ? join(DATA_DIR, 'statusline-prev.json') : null;

// Make sure the self-sufficient background poller is running. It has its
// own lock file and exits immediately if one is already alive, so calling
// this on every statusLine tick is safe and cheap.
function ensurePollerRunning() {
  if (!DATA_DIR) return;
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const pollerPath = join(scriptDir, 'poller.mjs');
    const child = spawn(process.execPath, [pollerPath, DATA_DIR], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', (e) => process.stderr.write('[waitji-statusline] poller spawn error: ' + (e && e.message || e) + '\n'));
    child.unref();
  } catch (e) {
    process.stderr.write('[waitji-statusline] ensurePollerRunning failed: ' + (e && e.message || e) + '\n');
  }
}

let printedAd = false;

function safePrint(s) {
  try { process.stdout.write(s); printedAd = printedAd || !!s; } catch { /* never throw */ }
}

function stripControlChars(s) {
  // Strip C0/C1 control chars + DEL so untrusted ad text can never inject
  // its own terminal escape sequences. The OSC 8 hyperlink below is the
  // only escape sequence this script ever emits.
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function renderAdLine() {
  if (!AD_CACHE) return;
  try {
    const raw = readFileSync(AD_CACHE, 'utf8');
    const cached = JSON.parse(raw);
    const fresh = cached && typeof cached.ts === 'number'
      && (Date.now() - cached.ts) <= FRESH_MS
      && typeof cached.adText === 'string' && cached.adText.length > 0;
    if (!fresh) return;

    const text = 'WaitJI AI · ' + stripControlChars(cached.adText);
    const url = typeof cached.clickUrl === 'string' ? stripControlChars(cached.clickUrl) : '';
    const ESC = '\u001b';
    const BEL = '\u0007';
    // OSC 8 hyperlink: clicking the printed text opens `url` in the terminal
    // (supported by most modern terminal emulators; degrades to plain text
    // in ones that don't support it — never breaks rendering either way).
    const line = url
      ? `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`
      : text;
    safePrint(line);
  } catch { /* no cache yet, or it's stale — show nothing, never throw */ }
}

function chainPreviousStatusLine() {
  if (!PREV_CACHE) { process.exit(0); return; }
  try {
    const prev = JSON.parse(readFileSync(PREV_CACHE, 'utf8'));
    const sl = prev && prev.statusLine;
    const cmd = sl && sl.type === 'command' && typeof sl.command === 'string' ? sl.command : '';
    if (!cmd || cmd.includes('statusline.mjs')) {
      setTimeout(() => process.exit(0), 50); // brief window for the poller's async spawn-error event to surface
      return;
    }

    const stdinMode = process.stdin.isTTY ? 'ignore' : 'inherit';
    const child = spawn(cmd, { shell: true, windowsHide: true, stdio: [stdinMode, 'pipe', 'ignore'] });
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const text = out.replace(/[\r\n]+$/, '');
      if (text) safePrint((printedAd ? '\n' : '') + text);
      process.exit(0);
    };
    child.stdout.on('data', d => { out += d; });
    child.stdout.on('error', () => { /* degrade gracefully */ });
    child.on('error', finish);
    child.on('close', finish);
    child.on('exit', () => setTimeout(finish, 150));
    setTimeout(() => { try { child.kill(); } catch { /* best-effort */ } finish(); }, CHAIN_TIMEOUT_MS);
  } catch {
    process.exit(0);
  }
}

renderAdLine();
ensurePollerRunning();
chainPreviousStatusLine();
