import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────
interface Ad {
  id: string;
  text: string;
  url: string;
  advertiser: string;
  cpmPaise: number; // in paise (1 INR = 100 paise)
}

interface ImpressionPayload {
  userId: string;
  adId: string;
  deviceId: string;
  timestamp: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const SPINNER_CHARS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const AD_PREFIX = '$(megaphone) ';
const ADWAIT_COLOR = new vscode.ThemeColor('statusBarItem.prominentBackground');

// Fallback ads when API unreachable (local cache)
const FALLBACK_ADS: Ad[] = [
  { id: 'f1', text: 'Razorpay · India ka #1 payment gateway', url: 'https://razorpay.com', advertiser: 'Razorpay', cpmPaise: 8000 },
  { id: 'f2', text: 'Zerodha Kite · Commission-free trading', url: 'https://zerodha.com', advertiser: 'Zerodha', cpmPaise: 6000 },
  { id: 'f3', text: 'AWS India · ₹28,000 free credits pao', url: 'https://aws.amazon.com/in', advertiser: 'AWS', cpmPaise: 7000 },
  { id: 'f4', text: 'Notion Teams · ₹399/month se shuru', url: 'https://notion.so', advertiser: 'Notion', cpmPaise: 5000 },
  { id: 'f5', text: 'Groww · Mutual funds mein invest karo', url: 'https://groww.in', advertiser: 'Groww', cpmPaise: 5500 },
];

// ─── Extension State ─────────────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let spinnerInterval: NodeJS.Timeout | undefined;
let adRotateInterval: NodeJS.Timeout | undefined;
let spinnerIdx = 0;
let currentAd: Ad | null = null;
let adCache: Ad[] = [];
let totalEarnedPaise = 0;
let sessionImpressions = 0;
let deviceId: string;

// ─── Activate ────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  console.log('AdWait.in: Extension activated');

  // Generate or retrieve persistent device ID
  deviceId = context.globalState.get<string>('adwait.deviceId') ?? crypto.randomUUID();
  context.globalState.update('adwait.deviceId', deviceId);

  totalEarnedPaise = context.globalState.get<number>('adwait.totalEarnedPaise') ?? 0;

  // Create status bar item (right side, priority 1)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  statusBarItem.command = 'adwait.showDashboard';
  statusBarItem.tooltip = 'AdWait.in — Click karo earnings dekhne ke liye';
  statusBarItem.text = `$(coin) AdWait: ₹${pToRupee(totalEarnedPaise)}`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('adwait.showDashboard', () => showDashboard(context)),
    vscode.commands.registerCommand('adwait.toggleAds', () => toggleAds(context)),
    vscode.commands.registerCommand('adwait.openPortal', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://adwait.in/me'));
    }),
  );

  // Pre-fetch ads
  fetchAds();

  // Watch for Claude Code terminal activity
  watchTerminals(context);

  // Watch for Claude Code extension commands (file system changes = AI working)
  watchFileSystemForActivity(context);

  // First-run welcome
  const installed = context.globalState.get<boolean>('adwait.welcomed');
  if (!installed) {
    context.globalState.update('adwait.welcomed', true);
    vscode.window.showInformationMessage(
      '🎉 AdWait.in installed! Claude Code ke spinner pe ads dikhenge aur aap ₹ kamaoge.',
      'Dashboard Dekho', 'UPI Setup Karo'
    ).then(sel => {
      if (sel === 'Dashboard Dekho') vscode.commands.executeCommand('adwait.showDashboard');
      if (sel === 'UPI Setup Karo') vscode.commands.executeCommand('workbench.action.openSettings', 'adwait.upiId');
    });
  }
}

// ─── Watch Terminals ──────────────────────────────────────────────────────────
function watchTerminals(context: vscode.ExtensionContext) {
  // Intercept terminal data to detect Claude Code spinner patterns
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(terminal => {
      // When terminal opens, attach data watcher
      const disposable = (terminal as any).onDidWriteData?.((data: string) => {
        handleTerminalData(data, context);
      });
      if (disposable) context.subscriptions.push(disposable);
    })
  );
}

function handleTerminalData(data: string, context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('adwait');
  if (!cfg.get<boolean>('showAds')) return;

  // Claude Code spinner detection patterns
  const isClaudeSpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Thinking\.\.\.|claude|Analyzing|Reading|Writing/i.test(data);

  if (isClaudeSpinner) {
    startAdDisplay(context);
  }

  // Detect completion (newline after spinner = done)
  if (data.includes('\n') || data.includes('\r')) {
    // Delay stop to avoid flickering
    setTimeout(() => stopAdDisplay(), 500);
  }
}

// ─── File System Watch (Backup detection) ─────────────────────────────────────
function watchFileSystemForActivity(context: vscode.ExtensionContext) {
  // Watch for .claude temp files that indicate active session
  const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/**');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => startAdDisplay(context)),
    watcher.onDidCreate(() => startAdDisplay(context)),
    watcher.onDidDelete(() => stopAdDisplay()),
  );
}

// ─── Ad Display ──────────────────────────────────────────────────────────────
let adDisplayTimeout: NodeJS.Timeout | undefined;

function startAdDisplay(context: vscode.ExtensionContext) {
  if (spinnerInterval) return; // Already showing

  const cfg = vscode.workspace.getConfiguration('adwait');
  if (!cfg.get<boolean>('showAds')) return;

  const ad = getNextAd();
  if (!ad) return;
  currentAd = ad;

  // Show ad in status bar with spinner
  spinnerInterval = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_CHARS.length;
    const spinner = SPINNER_CHARS[spinnerIdx];
    statusBarItem.text = `${spinner} ${AD_PREFIX}${ad.text}`;
    statusBarItem.tooltip = `${ad.advertiser} (sponsored) · Click to visit · AdWait.in`;
  }, 80);

  // Record impression after 5s (standard viewability)
  adDisplayTimeout = setTimeout(() => {
    recordImpression(ad, context);
  }, 5000);

  // Rotate ad every 20 seconds
  adRotateInterval = setInterval(() => {
    const nextAd = getNextAd();
    if (nextAd && nextAd.id !== currentAd?.id) {
      currentAd = nextAd;
      clearTimeout(adDisplayTimeout);
      adDisplayTimeout = setTimeout(() => recordImpression(nextAd, context), 5000);
    }
  }, 20000);
}

function stopAdDisplay() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = undefined;
  }
  if (adRotateInterval) {
    clearInterval(adRotateInterval);
    adRotateInterval = undefined;
  }
  if (adDisplayTimeout) {
    clearTimeout(adDisplayTimeout);
    adDisplayTimeout = undefined;
  }
  // Restore normal status bar
  statusBarItem.text = `$(coin) AdWait: ₹${pToRupee(totalEarnedPaise)}`;
  statusBarItem.tooltip = 'AdWait.in — Click karo earnings dekhne ke liye';
  currentAd = null;
}

// ─── Impression Recording ─────────────────────────────────────────────────────
function recordImpression(ad: Ad, context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('adwait');
  const userId = cfg.get<string>('userId') ?? '';
  const earnedPaise = Math.floor(ad.cpmPaise / 1000 / 2); // 50% revenue share, per impression

  totalEarnedPaise += earnedPaise;
  sessionImpressions += 1;
  context.globalState.update('adwait.totalEarnedPaise', totalEarnedPaise);

  // Send to API
  const payload: ImpressionPayload = {
    userId,
    adId: ad.id,
    deviceId,
    timestamp: Date.now(),
  };
  sendImpression(cfg.get<string>('apiEndpoint') ?? 'https://api.adwait.in', payload);
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
      'X-AdWait-Version': '0.1.0',
    },
  }, (res) => {
    // fire and forget
  });
  req.on('error', () => {}); // silent fail — offline OK
  req.write(body);
  req.end();
}

// ─── Ad Fetching ──────────────────────────────────────────────────────────────
let adIdx = 0;

function getNextAd(): Ad {
  const pool = adCache.length > 0 ? adCache : FALLBACK_ADS;
  const ad = pool[adIdx % pool.length];
  adIdx++;
  return ad;
}

async function fetchAds() {
  const cfg = vscode.workspace.getConfiguration('adwait');
  const apiBase = cfg.get<string>('apiEndpoint') ?? 'https://api.adwait.in';

  try {
    const data = await httpGet(`${apiBase}/v1/ads/active`);
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed.ads) && parsed.ads.length > 0) {
      adCache = parsed.ads;
    }
  } catch {
    // Use fallback ads — no error shown
    adCache = FALLBACK_ADS;
  }

  // Refresh every 5 minutes
  setTimeout(fetchAds, 5 * 60 * 1000);
}

// ─── Dashboard Webview ────────────────────────────────────────────────────────
function showDashboard(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'adwaitDashboard',
    'AdWait.in — Dashboard',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  const cfg = vscode.workspace.getConfiguration('adwait');
  const userId = cfg.get<string>('userId') || '—';
  const upiId = cfg.get<string>('upiId') || '—';
  const totalRupees = pToRupee(totalEarnedPaise);

  panel.webview.html = getDashboardHtml(totalRupees, sessionImpressions, userId, upiId);

  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'openPortal') {
      vscode.env.openExternal(vscode.Uri.parse('https://adwait.in/me'));
    }
    if (msg.type === 'openSettings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'adwait');
    }
  });
}

function getDashboardHtml(earned: string, impressions: number, userId: string, upiId: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Segoe UI', sans-serif; background: #0d0d0d; color: #fafafa; padding: 32px; margin: 0; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 32px; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 20px; }
  .card-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card-val { font-size: 32px; font-weight: 700; font-family: monospace; }
  .green { color: #00c170; }
  .saffron { color: #ff6b00; }
  .btn { background: #ff6b00; color: #0d0d0d; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; margin-right: 12px; }
  .btn-sec { background: transparent; color: #fafafa; border: 1px solid #2a2a2a; padding: 12px 24px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .info { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 20px; margin-bottom: 24px; font-size: 13px; color: #888; line-height: 1.8; }
  .info b { color: #fafafa; }
</style>
</head><body>
<h1>💰 AdWait.in Dashboard</h1>
<div class="sub">Aapka passive income — Claude Code ke through</div>
<div class="cards">
  <div class="card">
    <div class="card-label">Total Earned</div>
    <div class="card-val green">₹${earned}</div>
  </div>
  <div class="card">
    <div class="card-label">This Session</div>
    <div class="card-val saffron">${impressions} imps</div>
  </div>
  <div class="card">
    <div class="card-label">Status</div>
    <div class="card-val" style="font-size:20px;color:#00c170">● Active</div>
  </div>
</div>
<div class="info">
  <b>User ID:</b> ${userId}<br>
  <b>UPI ID:</b> ${upiId}<br>
  <b>Next payout:</b> Month end (minimum ₹100)
</div>
<button class="btn" onclick="vscode.postMessage({type:'openPortal'})">adwait.in Portal Kholo</button>
<button class="btn-sec" onclick="vscode.postMessage({type:'openSettings'})">Settings</button>
<script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
}

// ─── Toggle Ads ───────────────────────────────────────────────────────────────
async function toggleAds(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('adwait');
  const current = cfg.get<boolean>('showAds') ?? true;
  await cfg.update('showAds', !current, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`AdWait ads ${!current ? 'ON ✅' : 'OFF ⏸'}`);
  if (current) stopAdDisplay();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pToRupee(paise: number): string {
  return (paise / 100).toFixed(2);
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'X-AdWait-Version': '0.1.0' },
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

export function deactivate() {
  stopAdDisplay();
}
