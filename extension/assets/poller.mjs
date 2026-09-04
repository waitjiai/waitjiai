#!/usr/bin/env node
// WaitJI AI — background ad poller for Claude Code CLI sessions.
//
// WHY THIS EXISTS: VS Code has no public, stable API for reading terminal
// output (Terminal.onDidWriteTerminalData has been a "forever proposed" API
// since 2019 — not usable by normal extensions). So the extension cannot
// reliably detect "Claude Code is thinking" from inside VS Code. Instead,
// this script runs as an independent background process — started once by
// statusline.mjs — that keeps the ad cache fresh on its own, entirely
// decoupled from VS Code being open, the terminal API, or any UI mode
// (terminal CLI and the VS Code panel both end up reading the same cache).
//
// Billing model note: because there is no reliable "thinking now" signal
// available to a third-party extension, impressions here are credited on a
// fixed interval while a Claude Code CLI session is active (one billed
// impression per POLL_MS, default 90s) rather than per thinking-pause. This
// is a deliberate, transparent trade-off — see the WaitJI AI docs.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const _argDataDir = process.argv[2];
const DATA_DIR = resolveDataDir(_argDataDir);
const API_BASE = getApiBaseOverride() || process.argv[3] || 'https://waitjiai-backend.onrender.com';
const POLL_MS = 90_000;

function resolveDataDir(arg) {
  // If arg looks like the correct globalStorage path — use it directly
  if (arg && arg.includes('globalStorage')) return arg;
  // Otherwise find the correct globalStorage path automatically
  const home = homedir();
  const candidates = [
    join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'waitjiai.waitji-ai'),
    join(home, '.config', 'Code', 'User', 'globalStorage', 'waitjiai.waitji-ai'),
    join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'waitjiai.waitji-ai'),
  ];
  for (const c of candidates) {
    try { mkdirSync(c, { recursive: true }); return c; } catch { /* try next */ }
  }
  return arg || candidates[0];
}

const AD_CACHE = join(DATA_DIR, 'statusline-ad-cache.json');
const LOCK_FILE = join(DATA_DIR, 'poller.lock');

function vsCodeSettingsPath() {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  if (platform() === 'win32') return join(process.env.APPDATA || home, 'Code', 'User', 'settings.json');
  return join(home, '.config', 'Code', 'User', 'settings.json'); // linux
}

function getUserId() {
  try {
    const raw = readFileSync(vsCodeSettingsPath(), 'utf8');
    const settings = JSON.parse(raw);
    return settings['waitjiAi.userId'] || '';
  } catch { return ''; }
}
function getApiBaseOverride() {
  try {
    const raw = readFileSync(vsCodeSettingsPath(), 'utf8');
    const settings = JSON.parse(raw);
    return settings['waitjiAi.apiEndpoint'] || null;
  } catch { return null; }
}

// ── spinnerVerbs: the OFFICIAL, documented Claude Code customization point
// that controls what word replaces "Thinking..." while it works. This is
// intentionally exposed by Anthropic for exactly this kind of personalization
// (people use it for Star Wars/Dune themes etc.) — NOT a patch of any shipped
// file. We use "append" mode so the ad mixes into the normal rotation rather
// than replacing it outright. Two separate targets:
//   ~/.claude/settings.json          -> Claude Code CLI (terminal sessions)
//   VS Code's own settings.json      -> the Claude Code VS Code panel, under
//                                        the "claudeCode.spinnerVerbs" key
function claudeCliSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}
function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
function writeJsonSafe(path, obj) {
  try { writeFileSync(path, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
}

const OUR_TAG = '__waitji_managed__';

function buildVerbsFromAds(ads) {
  // Short, honestly-tagged entries — never pretending to be a "default" verb.
  return ads.slice(0, 3).map(ad => `WaitJI: ${String(ad.text).slice(0, 40)}`);
}

function applySpinnerVerbs(path, key, ourVerbs) {
  const settings = readJsonSafe(path);
  const existing = key ? settings[key] : settings.spinnerVerbs;
  const target = key || 'spinnerVerbs';

  // Capture the user's pre-existing config exactly once, so it can be restored.
  if (!existing || !existing[OUR_TAG]) {
    const captureFile = path + '.waitji-prev-' + (key || 'cli') + '.json';
    if (!existsSync(captureFile)) {
      writeJsonSafe(captureFile, { prior: existing || null });
    }
  }

  const baseVerbs = (existing && Array.isArray(existing.verbs) && !existing[OUR_TAG]) ? existing.verbs : [];
  const merged = { mode: 'replace', verbs: [...new Set([...ourVerbs])], [OUR_TAG]: true };

  if (key) settings[key] = merged; else settings.spinnerVerbs = merged;
  writeJsonSafe(path, settings);
}

function restoreSpinnerVerbs(path, key) {
  const captureFile = path + '.waitji-prev-' + (key || 'cli') + '.json';
  let prior = null;
  try { prior = JSON.parse(readFileSync(captureFile, 'utf8')).prior; } catch { /* nothing captured */ }
  const settings = readJsonSafe(path);
  if (key) {
    if (prior) settings[key] = prior; else delete settings[key];
  } else {
    if (prior) settings.spinnerVerbs = prior; else delete settings.spinnerVerbs;
  }
  writeJsonSafe(path, settings);
}

// CLI entry point for the extension to call directly: `node poller.mjs --restore`
function maybeHandleRestoreCli() {
  if (process.argv[2] === '--restore') {
    restoreSpinnerVerbs(claudeCliSettingsPath(), null);
    restoreSpinnerVerbs(vsCodeSettingsPath(), 'claudeCode.spinnerVerbs');
    process.exit(0);
  }
}

function updateSpinnerVerbsEverywhere(ads) {
  if (!ads || !ads.length) return;
  const ourVerbs = buildVerbsFromAds(ads);
  try { applySpinnerVerbs(claudeCliSettingsPath(), null, ourVerbs); } catch { /* never break the poller */ }
  try { applySpinnerVerbs(vsCodeSettingsPath(), 'claudeCode.spinnerVerbs', ourVerbs); } catch { /* never break the poller */ }
}

// Single-instance lock: if another poller is already running (lock file
// fresh within 2x poll interval), exit immediately rather than double-poll.
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const age = Date.now() - JSON.parse(readFileSync(LOCK_FILE, 'utf8')).ts;
      if (age < POLL_MS * 2) return false;
    }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }));
    return true;
  } catch (e) {
    process.stderr.write('[waitji-poller] acquireLock failed: ' + (e && e.stack || e) + '\n');
    return false;
  }
}
function refreshLock() {
  try { writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid })); } catch { /* ignore */ }
}

// BUG FIX: this used to call /v1/ads/active with no query string, so the
// backend's `type` filter silently defaulted to 'spotlight' — meaning this
// poller, whose entire purpose is serving the terminal status line (the
// Stream placement), was actually always fetching and billing Spotlight-
// typed ads. Every Stream-designated campaign was filtered out of every
// request from every surface, so Stream inventory never delivered at all.
async function fetchActiveAds() {
  try {
    const res = await fetch(`${API_BASE}/v1/ads/active?type=stream&surface=terminal`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.ads) ? data.ads : [];
  } catch (e) {
    process.stderr.write('[waitji-poller] fetchActiveAds failed: ' + (e && e.message || e) + '\n');
    return [];
  }
}

function cacheTopAd(ads) {
  if (!ads.length) {
    writeFileSync(AD_CACHE, JSON.stringify({ ts: 0, adText: '', clickUrl: '' }));
    return;
  }
  const ad = ads[0];
  writeFileSync(AD_CACHE, JSON.stringify({ ts: Date.now(), adText: ad.text, clickUrl: ad.url, campaignId: ad.id }));
}

async function billImpression(ad) {
  const userId = getUserId();
  if (!userId) {
    // userId not set — user hasn't connected their account yet.
    // Ads still show in the spinner (good UX), just no earnings credited.
    process.stderr.write('[waitji-poller] no userId set — connect account at waitjiai.in to start earning\n');
    return;
  }
  if (!ad) return;
  try {
    const r = await fetch(`${API_BASE}/v1/impression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: ad.id, userId, adType: ad.adType || 'spotlight', surface: 'terminal' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      process.stderr.write('[waitji-poller] impression rejected: ' + (d.reason || d.error || r.status) + '\n');
    }
  } catch (e) {
    process.stderr.write('[waitji-poller] impression network error: ' + (e && e.message || e) + '\n');
  }
}

async function tick() {
  refreshLock();
  const ads = await fetchActiveAds();
  cacheTopAd(ads);
  updateSpinnerVerbsEverywhere(ads);
  await billImpression(ads[0]);
}

(async () => {
  maybeHandleRestoreCli(); // exits immediately if invoked with --restore
  if (!acquireLock()) { process.exit(0); } // another poller is already alive
  await tick();
  setInterval(tick, POLL_MS);
  // Stays alive indefinitely as a detached background process; it is a
  // single per-machine daemon (guarded by the lock file above), not tied
  // to any particular VS Code window or terminal session.
})();
