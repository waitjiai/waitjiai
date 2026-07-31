import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────
interface Ad {
  id: string;
  text: string;
  url: string;
  advertiser: string;
  cpmPaise: number; // in paise (1 INR = 100 paise)
}

// ─── Constants ───────────────────────────────────────────────────────────────
const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const AD_PREFIX = '$(megaphone) ';
const DEFAULT_API = 'https://waitjiai-backend.onrender.com';

// Claude Code CLI's officially-documented statusLine extensibility point.
// We read/write the user's OWN ~/.claude/settings.json — never any file that
// belongs to Anthropic's Claude Code extension itself. This is the same kind
// of config file edit any CLI tool (claude-hud, oh-my-posh, etc.) makes, and
// it is fully reversible via "WaitJI AI: Disable Terminal Status Line Ads".
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const STATUSLINE_FRESH_MS = 90_000; // ignore a cached ad older than this

// ─── Extension State ─────────────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let spinnerInterval: NodeJS.Timeout | undefined;
let adRotateInterval: NodeJS.Timeout | undefined;
let adDisplayTimeout: NodeJS.Timeout | undefined;
let spinnerIdx = 0;
let currentAd: Ad | null = null;
let adCache: Ad[] = [];
let adCacheIdx = 0;
let totalEarnedPaise = 0;
let sessionImpressions = 0;
let deviceId: string;
let extContext: vscode.ExtensionContext;

// ─── Activate ────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  console.log('WaitJI AI: extension activated');

  deviceId = context.globalState.get<string>('waitjiAi.deviceId') ?? crypto.randomUUID();
  context.globalState.update('waitjiAi.deviceId', deviceId);

  totalEarnedPaise = context.globalState.get<number>('waitjiAi.totalEarnedPaise') ?? 0;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  statusBarItem.command = 'waitjiAi.showDashboard';
  statusBarItem.tooltip = 'WaitJI AI — click to view your earnings';
  setIdleStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('waitjiAi.showDashboard', showDashboard),
    vscode.commands.registerCommand('waitjiAi.toggleAds', toggleAds),
    vscode.commands.registerCommand('waitjiAi.openPortal', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://waitjiai.in'));
    }),
    vscode.commands.registerCommand('waitjiAi.setup', runSetup),
    vscode.commands.registerCommand('waitjiAi.enableStatusLine', () => enableStatusLine(context, true)),
    vscode.commands.registerCommand('waitjiAi.restoreClaudeCode', () => restoreStatusLine(context, true)),
    vscode.commands.registerCommand('waitjiAi.visitAd', () => {
      if (currentAd) {
        vscode.env.openExternal(vscode.Uri.parse(currentAd.url));
        recordClick(currentAd);
      }
    }),
    vscode.commands.registerCommand('waitjiAi.testForceShowAd', () => {
      const testAd: Ad = adCache[0] || { id: 'test_ad', text: 'WaitJI AI · test ad (forced)', url: 'https://waitjiai.in', advertiser: 'WaitJI AI', cpmPaise: 50000 };
      vscode.window.showInformationMessage('Forcing ad display for 10s: "' + testAd.text + '" — check your terminal status line now.');
      currentAd = testAd;
      writeStatusLineCache(testAd);
      statusBarItem.text = `$(megaphone) ${testAd.text}`;
      setTimeout(() => { if (!spinnerInterval) { setIdleStatusBar(); clearStatusLineCache(); } }, 10000);
    }),
  );

  fetchAds();
  watchTerminals(context);
  watchFileSystemForActivity(context);

  const userId = getUserId();
  const welcomed = context.globalState.get<boolean>('waitjiAi.welcomed');
  if (!welcomed) {
    context.globalState.update('waitjiAi.welcomed', true);
    vscode.window
      .showInformationMessage(
        'WaitJI AI installed. Ads will show during Claude Code wait-states and you will start earning.',
        'Connect Account', 'Open Dashboard'
      )
      .then(sel => {
        if (sel === 'Connect Account') vscode.commands.executeCommand('waitjiAi.setup');
        if (sel === 'Open Dashboard') vscode.commands.executeCommand('waitjiAi.showDashboard');
      });
  } else if (!userId) {
    vscode.window
      .showWarningMessage('WaitJI AI: connect your account to start earning from ads shown here.', 'Connect Now')
      .then(sel => { if (sel === 'Connect Now') vscode.commands.executeCommand('waitjiAi.setup'); });
  }

  // Offer the terminal status-line ad (Claude Code CLI users) once, separately
  // from account connection — entirely optional and reversible.
  maybeOfferStatusLine(context);
}

export function deactivate() {
  stopAdDisplay();
}

// ─── Setup flow (unchanged from the live extension) ──────────────────────────
async function runSetup() {
  const choice = await vscode.window.showInformationMessage(
    'To connect your account, sign up at waitjiai.in, then paste your User ID below. You set your UPI ID on the website, not here.',
    'Open waitjiai.in', 'I have my User ID'
  );
  if (choice === 'Open waitjiai.in') {
    vscode.env.openExternal(vscode.Uri.parse('https://waitjiai.in'));
    return;
  }
  if (choice === 'I have my User ID') {
    const id = await vscode.window.showInputBox({
      prompt: 'Paste your WaitJI AI User ID',
      placeHolder: 'cust_xxxxxxxxxxxx',
      ignoreFocusOut: true,
    });
    if (id && id.trim()) {
      await vscode.workspace.getConfiguration('waitjiAi').update('userId', id.trim(), vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Connected. You will now earn from ads shown in this editor.');
    }
  }
}

function getUserId(): string {
  return vscode.workspace.getConfiguration('waitjiAi').get<string>('userId') ?? '';
}
function getApiBase(): string {
  return vscode.workspace.getConfiguration('waitjiAi').get<string>('apiEndpoint') ?? DEFAULT_API;
}

// ─── Status bar helpers ───────────────────────────────────────────────────────
function setIdleStatusBar() {
  statusBarItem.text = `$(coin) WaitJI AI: ₹${pToRupee(totalEarnedPaise)}`;
  statusBarItem.tooltip = 'WaitJI AI — click to view your earnings';
}

// ─── Watch terminals for Claude Code activity ───────────────────
function watchTerminals(context: vscode.ExtensionContext) {
  // onDidWriteData is a forever-proposed API — not available in stable VS Code.
  // Instead we use a file system watcher on the Claude Code globalStorage path
  // which Claude Code updates whenever it is actively thinking.
  watchFileSystemForActivity(context);

  // Also poll the statusline-ad-cache.json for freshness — if it was updated
  // recently the poller detected activity and we should show the ad.
  setInterval(() => {
    const cachePath = statusLineCachePath(context);
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const fresh = cached && typeof cached.ts === 'number' && (Date.now() - cached.ts) <= 90_000 && cached.adText;
      if (fresh && adCache.length > 0) startAdDisplay();
    } catch { /* no cache yet */ }
  }, 5000);
}

// ─── Backup detection via file system activity (unchanged) ──────────────────
function watchFileSystemForActivity(context: vscode.ExtensionContext) {
  const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/**');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => startAdDisplay()),
    watcher.onDidCreate(() => startAdDisplay()),
    watcher.onDidDelete(() => stopAdDisplay()),
  );
}

// ─── Ad display (unchanged, plus: keep the statusLine cache file fresh) ─────
function startAdDisplay() {
  if (spinnerInterval) return;
  const cfg = vscode.workspace.getConfiguration('waitjiAi');
  if (!cfg.get<boolean>('showAds')) return;
  if (adCache.length === 0) return;

  const ad = getNextAd();
  if (!ad) return;
  currentAd = ad;
  writeStatusLineCache(ad); // make this ad available to the Claude Code CLI status line too

  spinnerInterval = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_CHARS.length;
    const spinner = SPINNER_CHARS[spinnerIdx];
    statusBarItem.text = `${spinner} ${AD_PREFIX}${ad.text}`;
    statusBarItem.tooltip = `${ad.advertiser} · sponsored · click to visit · WaitJI AI`;
    statusBarItem.command = { title: 'visit', command: 'waitjiAi.visitAd' } as any;
  }, 80);

  adDisplayTimeout = setTimeout(() => recordImpression(ad), 5000);

  adRotateInterval = setInterval(() => {
    const nextAd = getNextAd();
    if (nextAd && nextAd.id !== currentAd?.id) {
      currentAd = nextAd;
      writeStatusLineCache(nextAd);
      if (adDisplayTimeout) clearTimeout(adDisplayTimeout);
      adDisplayTimeout = setTimeout(() => recordImpression(nextAd), 5000);
    }
  }, 20000);
}
function stopAdDisplay() {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = undefined; }
  if (adRotateInterval) { clearInterval(adRotateInterval); adRotateInterval = undefined; }
  if (adDisplayTimeout) { clearTimeout(adDisplayTimeout); adDisplayTimeout = undefined; }
  statusBarItem.command = 'waitjiAi.showDashboard';
  setIdleStatusBar();
  currentAd = null;
  clearStatusLineCache();
}
function getNextAd(): Ad | null {
  if (adCache.length === 0) return null;
  const ad = adCache[adCacheIdx % adCache.length];
  adCacheIdx++;
  return ad;
}

// ─── Fetch active ads (unchanged) ────────────────────────────────────────────
function fetchAds() {
  const apiBase = getApiBase();
  httpGet(`${apiBase}/v1/ads/active`)
    .then(body => {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.ads)) adCache = parsed.ads;
    })
    .catch(() => { /* silent fail, no ads shown until next successful fetch */ });
  setTimeout(fetchAds, 10 * 60 * 1000);
}

// ─── Record impression / click (unchanged) ───────────────────────────────────
function recordImpression(ad: Ad) {
  const userId = getUserId();
  if (!userId) return;
  const payload = JSON.stringify({ campaignId: ad.id, userId });
  httpPost(`${getApiBase()}/v1/impression`, payload)
    .then(body => {
      const res = JSON.parse(body);
      if (res.success && res.billed) {
        totalEarnedPaise += res.earnedPaise || 0;
        sessionImpressions += 1;
        extContext.globalState.update('waitjiAi.totalEarnedPaise', totalEarnedPaise);
        if (!spinnerInterval) setIdleStatusBar();
      }
    })
    .catch(() => { /* network error — no local earnings credited without server confirmation */ });
}
export function recordClick(ad: Ad) {
  const userId = getUserId();
  if (!userId) return;
  const payload = JSON.stringify({ campaignId: ad.id, userId });
  httpPost(`${getApiBase()}/v1/click`, payload)
    .then(body => {
      const res = JSON.parse(body);
      if (res.success && res.billed) {
        totalEarnedPaise += res.earnedPaise || 0;
        extContext.globalState.update('waitjiAi.totalEarnedPaise', totalEarnedPaise);
        if (!spinnerInterval) setIdleStatusBar();
      }
    })
    .catch(() => { /* silent */ });
}

// ═══════════════════════════════════════════════════════════════════════════
// Claude Code CLI status-line integration (NEW)
//
// This uses Claude Code's own documented `statusLine` setting in the user's
// ~/.claude/settings.json — the same extensibility point tools like
// claude-hud use. It is the user's own file; we only ever edit it with their
// explicit consent, we capture and preserve anything already there, and we
// ship a one-click "restore" command. We never touch any file that belongs
// to Anthropic's Claude Code extension itself.
// ═══════════════════════════════════════════════════════════════════════════

function statusLineCachePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'statusline-ad-cache.json');
}
function prevStatusLinePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'statusline-prev.json');
}
function bundledStatusLineScript(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'assets', 'statusline.mjs');
}

function writeStatusLineCache(ad: Ad) {
  try {
    fs.mkdirSync(extContext.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(statusLineCachePath(extContext), JSON.stringify({ ts: Date.now(), adText: ad.text, clickUrl: ad.url }));
  } catch { /* never let status-line bookkeeping break the extension */ }
}
function clearStatusLineCache() {
  try { fs.writeFileSync(statusLineCachePath(extContext), JSON.stringify({ ts: 0, adText: '', clickUrl: '' })); }
  catch { /* ignore */ }
}

function readClaudeSettings(): any {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8') || '{}');
  } catch { return {}; }
}
function writeClaudeSettings(settings: any) {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

async function maybeOfferStatusLine(context: vscode.ExtensionContext) {
  const installed = context.globalState.get<boolean>('waitjiAi.statusLineInstalled');
  const dismissed = context.globalState.get<boolean>('waitjiAi.statusLineOfferDismissed');
  if (installed || dismissed) return;

  const sel = await vscode.window.showInformationMessage(
    'WaitJI AI can show a labeled ad in your Claude Code "Thinking…" spinner and status line — in both terminal sessions and the VS Code Claude panel. ' +
    'This uses Claude Code\'s own documented spinnerVerbs/statusLine settings and only ever edits your own settings files. Fully reversible.',
    'Enable', 'Not now'
  );
  if (sel === 'Enable') {
    await enableStatusLine(context, false);
  } else {
    context.globalState.update('waitjiAi.statusLineOfferDismissed', true);
  }
}

async function enableStatusLine(context: vscode.ExtensionContext, isManualInvoke: boolean) {
  try {
    const settings = readClaudeSettings();
    const existing = settings.statusLine;

    // Capture whatever the user already had so "restore" can put it back exactly.
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(prevStatusLinePath(context), JSON.stringify({ statusLine: existing ?? null }));

    const scriptPath = bundledStatusLineScript(context);
    const dataDir = context.globalStorageUri.fsPath;
    settings.statusLine = { type: 'command', command: `node "${scriptPath}" "${dataDir}"` };
    writeClaudeSettings(settings);

    context.globalState.update('waitjiAi.statusLineInstalled', true);
    clearStatusLineCache();

    vscode.window.showInformationMessage(
      existing
        ? 'WaitJI AI status line enabled — your previous status line still runs underneath the ad.'
        : 'WaitJI AI status line enabled for Claude Code CLI sessions.',
      'Undo'
    ).then(sel => { if (sel === 'Undo') restoreStatusLine(context, true); });
  } catch (e: any) {
    if (isManualInvoke) {
      vscode.window.showErrorMessage('Could not enable the status line: ' + (e?.message || String(e)));
    }
  }
}

async function restoreStatusLine(context: vscode.ExtensionContext, isManualInvoke: boolean) {
  try {
    const settings = readClaudeSettings();
    let prev: any = null;
    try {
      prev = JSON.parse(fs.readFileSync(prevStatusLinePath(context), 'utf8'));
    } catch { /* nothing captured — fine */ }

    if (prev && prev.statusLine) {
      settings.statusLine = prev.statusLine;
    } else {
      delete settings.statusLine;
    }
    writeClaudeSettings(settings);

    // Also revert spinnerVerbs in both ~/.claude/settings.json and VS Code's
    // own settings.json, using the poller script's own restore logic so the
    // exact-capture/exact-restore behavior lives in one place.
    try {
      spawnSync(process.execPath, [bundledStatusLineScript(context).replace('statusline.mjs', 'poller.mjs'), '--restore'], { timeout: 5000 });
    } catch { /* best-effort */ }

    context.globalState.update('waitjiAi.statusLineInstalled', false);

    if (isManualInvoke) {
      vscode.window.showInformationMessage('Claude Code status line and spinner verbs restored to your previous configuration.');
    }
  } catch (e: any) {
    if (isManualInvoke) {
      vscode.window.showErrorMessage('Could not restore Claude Code settings: ' + (e?.message || String(e)));
    }
  }
}

// ─── Commands (unchanged) ─────────────────────────────────────────────────────
function showDashboard() {
  const userId = getUserId();
  if (!userId) {
    vscode.window
      .showInformationMessage('Connect your WaitJI AI account first to see real earnings.', 'Connect Now')
      .then(sel => { if (sel === 'Connect Now') vscode.commands.executeCommand('waitjiAi.setup'); });
    return;
  }
  vscode.window
    .showInformationMessage(
      `WaitJI AI — ₹${pToRupee(totalEarnedPaise)} earned locally this install · ${sessionImpressions} impressions this session. Open the full dashboard for verified totals and payouts.`,
      'Open Full Dashboard'
    )
    .then(sel => { if (sel === 'Open Full Dashboard') vscode.env.openExternal(vscode.Uri.parse('https://waitjiai.in/customer.html')); });
}
async function toggleAds() {
  const cfg = vscode.workspace.getConfiguration('waitjiAi');
  const current = cfg.get<boolean>('showAds');
  await cfg.update('showAds', !current, vscode.ConfigurationTarget.Global);
  if (current) stopAdDisplay();
  vscode.window.showInformationMessage(`WaitJI AI ads are now ${!current ? 'on' : 'off'}.`);
}

// ─── HTTP helpers (unchanged) ─────────────────────────────────────────────────
function httpGet(urlStr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 8000 }, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    } catch (e) { reject(e); }
  });
}
function httpPost(urlStr: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const req = https.request({
        hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}
function pToRupee(paise: number): string {
  return (paise / 100).toFixed(2);
}
