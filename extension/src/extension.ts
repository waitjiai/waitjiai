import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────
interface Ad {
  id: string;          // campaign id — MUST be sent back as `campaignId`, not `adId` (see BUG FIX #1 below)
  text: string;
  url: string;
  advertiser: string;
  cpmPaise: number;
  adType: 'spotlight' | 'stream';
  isHouseAd?: boolean;
}

interface ImpressionPayload {
  userId: string;
  campaignId: string;   // BUG FIX #1: backend's /v1/impression reads `b.campaignId`. The previous version of
                         // this file sent `adId` here instead. That field name never matched anything the
                         // backend looks for, so db.campaigns[undefined] was always a miss, every single
                         // impression 404'd, and — because this is fire-and-forget — no error ever surfaced
                         // anywhere. Developers were never actually credited for a single impression.
  deviceId: string;
  country: string;
  surface: string;
  timestamp: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────
// BUG FIX #2: this whole file used to be branded "AdWait.in" and pointed at
// https://api.adwait.in — a different product name and a backend that was never
// the real one. Corrected to match the actual shipped product/backend.
const PRODUCT_NAME = 'WaitJI AI';
const CONFIG_NS = 'waitji';
const DEFAULT_API = 'https://waitjiai-backend.onrender.com';
const FALLBACK_ADS: Ad[] = [
  { id: 'fallback_1', text: 'Razorpay · India ka #1 payment gateway', url: 'https://razorpay.com', advertiser: 'Razorpay', cpmPaise: 80000, adType: 'spotlight' },
  { id: 'fallback_2', text: 'Zerodha Kite · Commission-free trading', url: 'https://zerodha.com', advertiser: 'Zerodha', cpmPaise: 60000, adType: 'spotlight' },
  { id: 'fallback_3', text: 'AWS India · ₹28,000 free credits pao', url: 'https://aws.amazon.com/in', advertiser: 'AWS', cpmPaise: 70000, adType: 'stream' },
];

// BUG FIX #3: the previous version tried to display ads by intercepting raw
// terminal data via `(terminal as any).onDidWriteData`, an undocumented,
// non-guaranteed cast that VS Code does not promise to support, and it never
// touched Claude Code's actual configuration at all. This rewrite uses the
// mechanism the product is actually sold on: writing into Claude Code's own
// `spinnerVerbs` (Spotlight placement) and `statusLine` (Stream placement)
// settings in ~/.claude/settings.json. This is the ONLY part of the machine
// that ever touches a user file — and it only ever writes these two keys.
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// ─── Extension State ─────────────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let deviceId: string;
let totalEarnedPaise = 0;
let sessionImpressions = 0;
let pollTimer: NodeJS.Timeout | undefined;
let extContext: vscode.ExtensionContext;
let currentSpotlightAd: Ad | null = null;
let currentStreamAd: Ad | null = null;
let streamAdFilePath: string;

const POLL_INTERVAL_MS = 90 * 1000; // matches the poller.mjs cadence documented for this product

// ─── Activate ────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  console.log(`${PRODUCT_NAME}: extension activated`);

  deviceId = context.globalState.get<string>('waitji.deviceId') ?? crypto.randomUUID();
  context.globalState.update('waitji.deviceId', deviceId);
  totalEarnedPaise = context.globalState.get<number>('waitji.totalEarnedPaise') ?? 0;

  streamAdFilePath = path.join(context.globalStorageUri.fsPath, 'stream-ad.txt');
  try { fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true }); } catch { /* best effort */ }
  try { fs.writeFileSync(streamAdFilePath, ''); } catch { /* best effort */ }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  statusBarItem.command = 'waitji.showDashboard';
  statusBarItem.tooltip = `${PRODUCT_NAME} — click to see earnings`;
  statusBarItem.text = `$(coin) WaitJI: ₹${pToRupee(totalEarnedPaise)}`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('waitji.showDashboard', () => showDashboard(context)),
    vscode.commands.registerCommand('waitji.toggleAds', () => toggleAds(context)),
    vscode.commands.registerCommand('waitji.openPortal', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://waitjiai.in/customer.html'));
    }),
    vscode.commands.registerCommand('waitji.setUserId', () => setUserId()),
  );

  // Back up whatever spinnerVerbs/statusLine the user already had, exactly once,
  // so we can restore it if ads get turned off or the extension is removed.
  backupOriginalClaudeSettingsIfNeeded();

  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  if (!cfg.get<string>('userId')) {
    vscode.window.showInformationMessage(
      `🎉 ${PRODUCT_NAME} installed! Set your developer ID to start earning.`,
      'Set Developer ID', 'Later'
    ).then(sel => { if (sel === 'Set Developer ID') setUserId(); });
  }

  pollAndApplyAds(); // first fetch immediately
  pollTimer = setInterval(pollAndApplyAds, POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => { if (pollTimer) clearInterval(pollTimer); } });
}

export function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  restoreOriginalClaudeSettings();
}

// ─── Core loop: fetch ads, write them into Claude Code's own settings ────────
async function pollAndApplyAds() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  if (!cfg.get<boolean>('showAds')) return;

  const userId = cfg.get<string>('userId') || '';
  const apiBase = cfg.get<string>('apiEndpoint') || DEFAULT_API;
  const country = 'IN'; // TODO: derive from a future settings field once client-side geo-pricing is needed

  const [spotlightAds, streamAds] = await Promise.all([
    fetchAds(apiBase, 'spotlight', country),
    fetchAds(apiBase, 'stream', country),
  ]);

  const spotlight = spotlightAds[0] || FALLBACK_ADS.find(a => a.adType === 'spotlight') || null;
  const stream = streamAds[0] || FALLBACK_ADS.find(a => a.adType === 'stream') || null;

  applySpinnerVerbAd(spotlight);
  applyStreamAd(stream);

  // Record one impression per surface per poll cycle the ad was actually shown for.
  if (spotlight && !spotlight.id.startsWith('fallback_')) recordImpression(spotlight, userId, country, 'spotlight');
  if (stream && !stream.id.startsWith('fallback_')) recordImpression(stream, userId, country, 'stream');
}

async function fetchAds(apiBase: string, adType: 'spotlight' | 'stream', country: string): Promise<Ad[]> {
  try {
    const data = await httpGet(`${apiBase}/v1/ads/active?type=${adType}&country=${country}&surface=vscode`);
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed.ads)) return parsed.ads;
    return [];
  } catch {
    return []; // caller falls back to FALLBACK_ADS
  }
}

// ─── Spotlight placement: Claude Code's `spinnerVerbs` setting ───────────────
function applySpinnerVerbAd(ad: Ad | null) {
  currentSpotlightAd = ad;
  const settings = readClaudeSettings();
  if (!settings) return; // couldn't read/parse — never write and risk corrupting the user's file

  if (ad) {
    // Blend with the user's original verbs so it isn't 100% ads, 100% of the time.
    const original: string[] = extContext.globalState.get('waitji.originalSpinnerVerbs') ?? [];
    const base = original.length > 0 ? original : ['Thinking', 'Analyzing', 'Reading', 'Writing'];
    settings.spinnerVerbs = [...base, ad.text];
  } else {
    const original: string[] | undefined = extContext.globalState.get('waitji.originalSpinnerVerbs');
    if (original && original.length > 0) settings.spinnerVerbs = original; else delete settings.spinnerVerbs;
  }
  writeClaudeSettings(settings);
}

// ─── Stream placement: Claude Code's `statusLine` setting ────────────────────
// statusLine runs a command and shows its stdout. We point it at a tiny, portable
// node one-liner that reads a file this extension keeps updated — avoids shelling
// out to `cat`, which isn't available by default on Windows.
function applyStreamAd(ad: Ad | null) {
  currentStreamAd = ad;
  try { fs.writeFileSync(streamAdFilePath, ad ? `$(megaphone) ${ad.text}` : ''); } catch { /* best effort */ }

  const settings = readClaudeSettings();
  if (!settings) return;

  if (ad) {
    if (extContext.globalState.get('waitji.originalStatusLine') === undefined) {
      extContext.globalState.update('waitji.originalStatusLine', settings.statusLine ?? null);
    }
    settings.statusLine = {
      type: 'command',
      command: `node -e "try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(streamAdFilePath)},'utf8'))}catch(e){}"`,
    };
  } else {
    const original = extContext.globalState.get('waitji.originalStatusLine');
    if (original) settings.statusLine = original; else delete settings.statusLine;
  }
  writeClaudeSettings(settings);
}

// ─── ~/.claude/settings.json read/write (merge, never clobber unrelated keys) ─
function readClaudeSettings(): any | null {
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`${PRODUCT_NAME}: could not read ${CLAUDE_SETTINGS_PATH} — leaving it untouched.`, e);
    return null;
  }
}

function writeClaudeSettings(settings: any) {
  try {
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error(`${PRODUCT_NAME}: could not write ${CLAUDE_SETTINGS_PATH}`, e);
  }
}

function backupOriginalClaudeSettingsIfNeeded() {
  if (extContext.globalState.get('waitji.originalSpinnerVerbs') !== undefined) return; // already backed up once
  const settings = readClaudeSettings();
  if (!settings) return;
  extContext.globalState.update('waitji.originalSpinnerVerbs', settings.spinnerVerbs ?? []);
  extContext.globalState.update('waitji.originalStatusLine', settings.statusLine ?? null);
}

function restoreOriginalClaudeSettings() {
  const settings = readClaudeSettings();
  if (!settings) return;
  const originalVerbs = extContext.globalState.get<string[]>('waitji.originalSpinnerVerbs');
  const originalStatusLine = extContext.globalState.get<any>('waitji.originalStatusLine');
  if (originalVerbs && originalVerbs.length > 0) settings.spinnerVerbs = originalVerbs; else delete settings.spinnerVerbs;
  if (originalStatusLine) settings.statusLine = originalStatusLine; else delete settings.statusLine;
  writeClaudeSettings(settings);
}

// ─── Impression recording ─────────────────────────────────────────────────────
function recordImpression(ad: Ad, userId: string, country: string, surface: string) {
  const earnedPaise = Math.floor((ad.cpmPaise / 1000) * 0.65); // matches backend's 65% developer share
  totalEarnedPaise += earnedPaise;
  sessionImpressions += 1;
  extContext.globalState.update('waitji.totalEarnedPaise', totalEarnedPaise);
  statusBarItem.text = `$(coin) WaitJI: ₹${pToRupee(totalEarnedPaise)}`;

  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const apiBase = cfg.get<string>('apiEndpoint') || DEFAULT_API;

  const payload: ImpressionPayload = {
    userId,
    campaignId: ad.id, // BUG FIX #1 applied here — was `adId` before
    deviceId,
    country,
    surface,
    timestamp: Date.now(),
  };
  sendImpression(apiBase, payload);
}

function sendImpression(apiBase: string, payload: ImpressionPayload) {
  const body = JSON.stringify(payload);
  const url = new URL('/v1/impression', apiBase);
  const req = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-WaitJI-Version': '1.2.3',
    },
  }, (res) => { res.on('data', () => {}); });
  req.on('error', () => {}); // offline is fine — next poll cycle retries
  req.write(body);
  req.end();
}

// ─── Dashboard, settings, toggling ────────────────────────────────────────────
async function setUserId() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const current = cfg.get<string>('userId') || '';
  const value = await vscode.window.showInputBox({
    prompt: 'Enter your WaitJI AI developer ID (from waitjiai.in)',
    value: current,
    ignoreFocusOut: true,
  });
  if (value !== undefined) {
    await cfg.update('userId', value.trim(), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(value.trim() ? '✅ Developer ID saved.' : 'Developer ID cleared.');
  }
}

async function toggleAds(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const current = cfg.get<boolean>('showAds') ?? true;
  await cfg.update('showAds', !current, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${PRODUCT_NAME} ads ${!current ? 'ON ✅' : 'OFF ⏸'}`);
  if (current) { // turning OFF — restore Claude Code's own settings immediately
    restoreOriginalClaudeSettings();
    currentSpotlightAd = null;
    currentStreamAd = null;
  } else {
    pollAndApplyAds();
  }
}

function showDashboard(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel('waitjiDashboard', `${PRODUCT_NAME} — Dashboard`, vscode.ViewColumn.Beside, { enableScripts: true });
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const userId = cfg.get<string>('userId') || '— not set —';
  panel.webview.html = getDashboardHtml(pToRupee(totalEarnedPaise), sessionImpressions, userId, currentSpotlightAd, currentStreamAd);
  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'openPortal') vscode.env.openExternal(vscode.Uri.parse('https://waitjiai.in/customer.html'));
    if (msg.type === 'setUserId') setUserId();
  });
}

function getDashboardHtml(earned: string, impressions: number, userId: string, spotlight: Ad | null, stream: Ad | null): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: 'Segoe UI', sans-serif; background: #0B0E1D; color: #fafafa; padding: 32px; margin: 0; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #6B7185; font-size: 13px; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card { background: #14182b; border: 1px solid #232848; border-radius: 10px; padding: 20px; }
  .card-label { font-size: 11px; color: #6B7185; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card-val { font-size: 28px; font-weight: 700; font-family: monospace; }
  .gold { color: #F2C14E; } .sky { color: #0EA5E9; }
  .btn { background: #4F46E5; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; margin-right: 12px; }
  .info { background: #14182b; border: 1px solid #232848; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; font-size: 13px; color: #9198B8; line-height: 1.8; }
  .info b { color: #fafafa; }
</style></head><body>
<h1>💰 ${PRODUCT_NAME} Dashboard</h1>
<div class="sub">Passive income while you use Claude Code</div>
<div class="cards">
  <div class="card"><div class="card-label">Total Earned</div><div class="card-val gold">₹${earned}</div></div>
  <div class="card"><div class="card-label">This Session</div><div class="card-val sky">${impressions} imps</div></div>
</div>
<div class="info">
  <b>Developer ID:</b> ${userId}<br>
  <b>Current Spotlight ad:</b> ${spotlight ? spotlight.text + ' (' + spotlight.advertiser + ')' : '— none right now —'}<br>
  <b>Current Stream ad:</b> ${stream ? stream.text + ' (' + stream.advertiser + ')' : '— none right now —'}<br>
  <b>Payout:</b> ₹480–800/month typical at 2–3hr/day Claude Code usage, min ₹100 via UPI
</div>
<button class="btn" onclick="vscode.postMessage({type:'openPortal'})">Open waitjiai.in Portal</button>
<button class="btn" style="background:transparent;border:1px solid #232848" onclick="vscode.postMessage({type:'setUserId'})">Set Developer ID</button>
<script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pToRupee(paise: number): string { return (paise / 100).toFixed(2); }

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'X-WaitJI-Version': '1.2.3' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
