/**
 * WaitJI AI — Production Backend
 * Persistent storage: Postgres (Neon) — required. Render's filesystem is
 * EPHEMERAL: anything written to local disk is wiped on every deploy/restart.
 * The entire app-state JSON is stored as a single row in a `kv_store` table —
 * this keeps every other line of business logic in this file unchanged
 * (db.users, db.campaigns etc. all still work exactly as in-memory objects;
 * only loadDB/saveDB talk to Postgres instead of the local disk now).
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'waitji-dev-secret-change-in-prod';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@waitjiai.in';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'WaitJI@Admin2026';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json'); // local fallback only — see below
const DATABASE_URL = process.env.DATABASE_URL || null; // Neon Postgres connection string — REQUIRED for production
const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
// Supabase (identity provider for customers + advertisers)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tqfjdhneycntoasahstt.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxZmpkaG5leWNudG9hc2Foc3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2Mjg1ODcsImV4cCI6MjA5NzIwNDU4N30.u5oqo0c9tmZ7OxZW6R2hbMxUyVrM4nedYsGKC8PR4TA';
const EXTENSION_ID = process.env.EXTENSION_ID || 'WaitJiai.waitji-ai';
// Service role key — required for server-side admin reads that bypass RLS (e.g. reading the waitlist table).
// NEVER given a default value here: this key has full database access and must only live in Render's env vars.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;
// Resend API key — required to send bulk/marketing emails via Resend's HTTP API.
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const LAUNCH_EMAIL_FROM = process.env.LAUNCH_EMAIL_FROM || 'WaitJI AI <admin@waitjiai.in>';
// Razorpay — required for real advertiser payment collection. Never given a default
// (these are secret credentials and must only live in Render's env vars).
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || null;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || null;

async function razorpayApi(method, path, body) {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error('Razorpay is not configured on the server (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing)');
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.description || `Razorpay ${method} ${path} returned ${r.status}`);
  return data;
}
let extensionStatsCache = { installCount: null, fetchedAt: 0 };

// Pulls REAL install count from the public VS Code Marketplace API. Cached for
// 10 minutes so the admin dashboard's auto-refresh doesn't hammer Microsoft's API.
async function getExtensionStats() {
  const TEN_MIN = 10 * 60 * 1000;
  if (extensionStatsCache.installCount !== null && Date.now() - extensionStatsCache.fetchedAt < TEN_MIN) {
    return extensionStatsCache;
  }
  try {
    const r = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 914 }),
    });
    if (!r.ok) throw new Error('marketplace http ' + r.status);
    const data = await r.json();
    const ext = data.results?.[0]?.extensions?.[0];
    const stats = ext?.statistics || [];
    const installCount = stats.find(s => s.statisticName === 'install')?.value ?? null;
    const avgRating = stats.find(s => s.statisticName === 'averagerating')?.value ?? null;
    const ratingCount = stats.find(s => s.statisticName === 'ratingcount')?.value ?? null;
    extensionStatsCache = { installCount, avgRating, ratingCount, fetchedAt: Date.now(), error: null };
  } catch (e) {
    console.error('Marketplace stats fetch failed:', e.message);
    // keep stale cache if we have one; otherwise mark as unavailable (never fabricate a number)
    if (extensionStatsCache.installCount === null) extensionStatsCache = { installCount: null, fetchedAt: Date.now(), error: e.message };
  }
  return extensionStatsCache;
}

// ── Persistent JSON "database" ─────────────────────────────────────────────────
let db = {
  users: {},        // id -> { id, email, passwordHash, role, name, company, upiId, createdAt, banned }
  campaigns: {},    // id -> { id, advertiserId, advertiser, adText, url, bidPaise, budgetPaise, spentPaise, status, createdAt }
  impressions: [],  // { id, userId, campaignId, earnedPaise, ts, ip, clicked }
  clicks: [],       // { id, userId, campaignId, ts, ip, valid, reason }
  fraudFlags: [],   // { id, userId, type, detail, ts, severity }
  payouts: [],      // { id, userId, amountPaise, status, ts }
  sentLaunchEmails: {}, // { email: { sentAt, subject } } — duplicate-send protection for bulk waitlist emails
  houseAds: [],     // { id, text, url, active } — shown when no real advertiser campaign is active
};
const HOUSE_AD_RATE_PAISE = 5000; // ₹50 per 1000 impressions, founder-funded (not billed to any advertiser)

let pgAvailable = false;
async function loadDB() {
  if (pgPool) {
    try {
      await pgPool.query(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      const r = await pgPool.query(`SELECT value FROM kv_store WHERE key = 'db'`);
      pgAvailable = true;
      if (r.rows.length) {
        db = r.rows[0].value;
        db.users ||= {}; db.campaigns ||= {}; db.impressions ||= [];
        db.clicks ||= []; db.fraudFlags ||= []; db.payouts ||= [];
        db.sentLaunchEmails ||= {};
        db.houseAds ||= [];
        console.log(`Loaded DB from Postgres: ${Object.keys(db.users).length} users, ${Object.keys(db.campaigns).length} campaigns`);
      } else {
        console.log('No existing DB row in Postgres — starting fresh (first boot).');
      }
      return;
    } catch (e) {
      console.error('FATAL: could not load from Postgres:', e.message);
      console.error('Falling back to local disk — THIS DATA WILL BE LOST ON NEXT DEPLOY. Fix DATABASE_URL immediately.');
    }
  } else {
    console.error('WARNING: DATABASE_URL is not set. Using local disk storage, which Render WIPES on every deploy. Set DATABASE_URL in Render env vars now.');
  }
  // local-file fallback (only reached if Postgres is unavailable or unconfigured)
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.users ||= {}; db.campaigns ||= {}; db.impressions ||= [];
      db.clicks ||= []; db.fraudFlags ||= []; db.payouts ||= [];
      db.sentLaunchEmails ||= {};
      db.houseAds ||= [];
    }
  } catch (e) { console.error('Local DB load error:', e.message); }
}

let saveTimer = null;
let savePending = false;
function saveDB() {
  // debounce writes — coalesce rapid successive saves into one write
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (pgPool) {
      try {
        await pgPool.query(
          `INSERT INTO kv_store (key, value, updated_at) VALUES ('db', $1, now())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
          [JSON.stringify(db)]
        );
        return;
      } catch (e) {
        console.error('Postgres save error (data NOT persisted this write):', e.message);
        // fall through to local-disk write below as a last-resort safety net
      }
    }
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
    catch (e) { console.error('Local DB save error:', e.message); }
  }, 300);
}

// ── Seed demo campaigns + admin (first run only) ───────────────────────────────
function seed() {
  if (Object.keys(db.users).length === 0) {
    // create admin
    const adminId = 'admin';
    db.users[adminId] = {
      id: adminId, email: ADMIN_EMAIL, passwordHash: hashPassword(ADMIN_PASSWORD),
      role: 'admin', name: 'Platform Admin', createdAt: Date.now(), banned: false,
    };
    console.log('Seeded admin:', ADMIN_EMAIL);
  }
  if (!db.houseAds || db.houseAds.length === 0) {
    db.houseAds = [
      { id: uid('house_'), text: 'WaitJI AI · Refer a dev, earn 10% lifetime →', url: 'https://waitjiai.in/login.html?mode=signup', active: true, createdAt: Date.now() },
      { id: uid('house_'), text: 'WaitJI AI · Loving this? Rate us on the Marketplace ⭐', url: 'https://marketplace.visualstudio.com/items?itemName=WaitJiai.waitji-ai&ssr=false#review-details', active: true, createdAt: Date.now() },
    ];
    console.log('Seeded default house ads');
  }
  saveDB();
}

// ── Crypto helpers ─────────────────────────────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}
// Minimal JWT (HS256)
function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 864e5 }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function b64url(s) { return Buffer.from(s).toString('base64url'); }
function uid(prefix = '') { return prefix + crypto.randomBytes(8).toString('hex'); }

// ── Fraud detection engine ─────────────────────────────────────────────────────
const FRAUD = {
  // thresholds
  MAX_CLICKS_PER_MIN: 10,        // a human can't click an ad 10x/min legitimately
  MAX_CLICKS_PER_IP_HR: 50,      // per-IP hourly ceiling
  MAX_IMPRESSIONS_PER_MIN: 60,   // 1/sec is already abnormal
  MIN_MS_BETWEEN_CLICKS: 1500,   // human reaction floor
  CTR_ALERT_THRESHOLD: 0.25,     // >25% CTR = almost certainly fraud (normal is <2%)
};

function recentCount(arr, userId, windowMs) {
  const cut = Date.now() - windowMs;
  return arr.filter(x => x.userId === userId && x.ts > cut).length;
}
function recentByIP(arr, ip, windowMs) {
  const cut = Date.now() - windowMs;
  return arr.filter(x => x.ip === ip && x.ts > cut).length;
}
function flagFraud(userId, type, detail, severity = 'medium') {
  const flag = { id: uid('f_'), userId, type, detail, ts: Date.now(), severity };
  db.fraudFlags.push(flag);
  // auto-ban on critical
  if (severity === 'critical' && db.users[userId]) {
    db.users[userId].banned = true;
  }
  saveDB();
  return flag;
}

/**
 * Validate a click. Returns { valid, reason }.
 * Invalid clicks are NOT billed to the advertiser — protecting their money.
 */
function validateClick(userId, campaignId, ip) {
  // 1. rapid-fire clicks by user
  const userClicksLastMin = recentCount(db.clicks, userId, 60_000);
  if (userClicksLastMin >= FRAUD.MAX_CLICKS_PER_MIN) {
    flagFraud(userId, 'click_velocity', `${userClicksLastMin} clicks/min`, 'high');
    return { valid: false, reason: 'click_velocity_exceeded' };
  }
  // 2. time since last click (bot-like cadence)
  const userClicks = db.clicks.filter(c => c.userId === userId);
  const last = userClicks[userClicks.length - 1];
  if (last && (Date.now() - last.ts) < FRAUD.MIN_MS_BETWEEN_CLICKS) {
    flagFraud(userId, 'click_cadence', `gap ${Date.now() - last.ts}ms`, 'high');
    return { valid: false, reason: 'clicks_too_fast' };
  }
  // 3. per-IP hourly ceiling (click farms share IPs)
  const ipClicksLastHr = recentByIP(db.clicks, ip, 3_600_000);
  if (ipClicksLastHr >= FRAUD.MAX_CLICKS_PER_IP_HR) {
    flagFraud(userId, 'ip_abuse', `IP ${ip}: ${ipClicksLastHr} clicks/hr`, 'critical');
    return { valid: false, reason: 'ip_rate_limit' };
  }
  // 4. abnormal CTR for this user (clicks / impressions)
  const userImps = db.impressions.filter(i => i.userId === userId).length;
  const userClickCount = userClicks.length;
  if (userImps > 20) {
    const ctr = userClickCount / userImps;
    if (ctr > FRAUD.CTR_ALERT_THRESHOLD) {
      flagFraud(userId, 'abnormal_ctr', `CTR ${(ctr * 100).toFixed(1)}%`, 'high');
      return { valid: false, reason: 'abnormal_ctr' };
    }
  }
  return { valid: true, reason: 'ok' };
}

function validateImpression(userId, ip) {
  const impsLastMin = recentCount(db.impressions, userId, 60_000);
  if (impsLastMin >= FRAUD.MAX_IMPRESSIONS_PER_MIN) {
    flagFraud(userId, 'impression_velocity', `${impsLastMin} imp/min`, 'high');
    return { valid: false, reason: 'impression_velocity' };
  }
  return { valid: true, reason: 'ok' };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────────
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function getBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
}
// ── Supabase token validation ──────────────────────────────────────────────────
// Validates a Supabase access token by asking Supabase who the user is.
// Returns { id, email, phone, emailVerified, phoneVerified, provider } or null.
async function validateSupabaseToken(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.id) return null;
    return {
      id: u.id,
      email: (u.email || '').toLowerCase(),
      phone: u.phone || '',
      emailVerified: !!u.email_confirmed_at,
      phoneVerified: !!u.phone_confirmed_at,
      provider: (u.app_metadata && u.app_metadata.provider) || 'email',
      meta: u.user_metadata || {},
    };
  } catch (e) { console.error('Supabase validate error:', e.message); return null; }
}

function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = db.users[payload.uid];
  if (!user || user.banned) return null;
  // touch activity timestamp (debounced — only write if >5 min stale, avoids hammering disk on every request)
  const now = Date.now();
  if (!user.lastActiveAt || now - user.lastActiveAt > 5 * 60 * 1000) {
    user.lastActiveAt = now;
    saveDB();
  }
  return user;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;
  const ip = getIP(req);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ═══════════ PUBLIC ═══════════
    if (method === 'GET' && url === '/health') {
      return send(res, 200, { status: 'ok', version: '3.0.0-supabase', ts: Date.now() });
    }
    if (method === 'GET' && url === '/') {
      return send(res, 200, { message: 'WaitJI AI API v2', auth: true });
    }

    // ── Auth: Supabase token exchange (customers + advertisers) ──
    // Frontend logs in via Supabase (verified email / Google / phone),
    // then exchanges the Supabase token for a WaitJI backend token.
    if (method === 'POST' && url === '/v1/auth/exchange') {
      const b = await getBody(req);
      const sbUser = await validateSupabaseToken(b.access_token);
      if (!sbUser) return send(res, 401, { error: 'invalid or expired Supabase session' });
      // require verified email (Supabase enforces this too, double-check here)
      if (!sbUser.emailVerified && !sbUser.phoneVerified) {
        return send(res, 403, { error: 'please verify your email before continuing' });
      }
      const profileId = 'sb_' + sbUser.id;
      let user = db.users[profileId];
      if (!user) {
        // first login → create profile. Role is read from Supabase user_metadata
        // (set at signup time) first, since the actual profile-creating exchange
        // call often happens on the FIRST LOGIN after email verification, not
        // at signup itself — by then the signup screen's role choice is long gone
        // unless we persisted it into Supabase metadata. Body role is a fallback only.
        let role = (sbUser.meta.role === 'advertiser' || b.role === 'advertiser') ? 'advertiser' : 'customer';
        user = {
          id: profileId, supabaseId: sbUser.id, email: sbUser.email, phone: sbUser.phone,
          role, name: b.name || sbUser.meta.name || '', company: b.company || sbUser.meta.company || '',
          upiId: b.upiId || sbUser.meta.upiId || '',
          provider: sbUser.provider, emailVerified: sbUser.emailVerified, phoneVerified: sbUser.phoneVerified,
          createdAt: Date.now(), banned: false,
        };
        db.users[profileId] = user;
      } else {
        // existing → refresh verification status + contact, but NEVER change role here
        user.email = sbUser.email || user.email;
        user.phone = sbUser.phone || user.phone;
        user.emailVerified = sbUser.emailVerified;
        user.phoneVerified = sbUser.phoneVerified;
      }
      if (user.banned) return send(res, 403, { error: 'account suspended' });
      saveDB();
      const token = signToken({ uid: user.id, role: user.role });
      return send(res, 200, { token, user: publicUser(user) });
    }

    // ── Old direct signup: DISABLED (fake-account prevention) ──
    if (method === 'POST' && url === '/v1/auth/signup') {
      return send(res, 410, { error: 'signup now requires email/Google verification — use the website signup' });
    }

    // ── Auth: login (ADMIN ONLY — internal account, password-based) ──
    if (method === 'POST' && url === '/v1/auth/login') {
      const b = await getBody(req);
      const { email, password } = b;
      const user = Object.values(db.users).find(u => u.email === (email || '').toLowerCase() && u.role === 'admin');
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return send(res, 401, { error: 'invalid credentials' });
      }
      if (user.banned) return send(res, 403, { error: 'account suspended' });
      const token = signToken({ uid: user.id, role: user.role });
      return send(res, 200, { token, user: publicUser(user) });
    }

    // ── Auth: me ──
    if (method === 'GET' && url === '/v1/auth/me') {
      const user = auth(req);
      if (!user) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { user: publicUser(user) });
    }

    // ═══════════ ADS SERVING (public, used by extension) ═══════════
    if (method === 'GET' && url === '/v1/ads/active') {
      const ads = Object.values(db.campaigns)
        .filter(c => c.status === 'active' && c.spentPaise < c.budgetPaise)
        .sort((a, b) => b.bidPaise - a.bidPaise)
        .slice(0, 3)
        .map(c => ({ id: c.id, text: c.adText, url: c.url, advertiser: c.advertiser, cpmPaise: c.bidPaise, isHouseAd: false }));

      if (ads.length > 0) return send(res, 200, { ads, servedAt: Date.now() });

      // No real advertiser campaign is live — fall back to a rotating house ad so
      // developers still see (and earn from) something during the thinking pause.
      // Tagged "WaitJI AI", never "Sponsored" — there is no real sponsor here.
      const liveHouseAds = (db.houseAds || []).filter(h => h.active);
      if (liveHouseAds.length === 0) return send(res, 200, { ads: [], servedAt: Date.now() });
      const pick = liveHouseAds[Math.floor(Math.random() * liveHouseAds.length)];
      return send(res, 200, {
        ads: [{ id: pick.id, text: pick.text, url: pick.url, advertiser: 'WaitJI AI', cpmPaise: HOUSE_AD_RATE_PAISE, isHouseAd: true }],
        servedAt: Date.now(),
      });
    }

    // ── Record impression (with fraud check) ──
    if (method === 'POST' && url === '/v1/impression') {
      const b = await getBody(req);
      const userId = b.userId || 'anon';

      // House-ad impression — founder-funded, no real advertiser budget involved
      const houseAd = (db.houseAds || []).find(h => h.id === b.campaignId);
      if (houseAd) {
        const check = validateImpression(userId, ip);
        if (!check.valid) return send(res, 200, { success: false, reason: check.reason, billed: false });
        const earnPaise = Math.floor(HOUSE_AD_RATE_PAISE / 1000); // full house rate goes to the developer
        db.impressions.push({ id: uid('i_'), userId, campaignId: houseAd.id, earnedPaise: earnPaise, costPaise: 0, isHouseAd: true, ts: Date.now(), ip, clicked: false });
        saveDB();
        return send(res, 200, { success: true, earnedPaise: earnPaise, billed: true, isHouseAd: true });
      }

      const c = db.campaigns[b.campaignId];
      if (!c) return send(res, 404, { error: 'campaign not found' });

      const check = validateImpression(userId, ip);
      if (!check.valid) return send(res, 200, { success: false, reason: check.reason, billed: false });

      const earnPaise = Math.floor(c.bidPaise / 1000 / 2); // 50% of per-impression
      const advCostPaise = Math.floor(c.bidPaise / 1000);
      // budget guard
      if (c.spentPaise + advCostPaise > c.budgetPaise) {
        c.status = 'completed'; saveDB();
        return send(res, 200, { success: false, reason: 'budget_exhausted', billed: false });
      }
      c.spentPaise += advCostPaise;
      db.impressions.push({ id: uid('i_'), userId, campaignId: c.id, earnedPaise: earnPaise, costPaise: advCostPaise, isHouseAd: false, ts: Date.now(), ip, clicked: false });
      saveDB();
      return send(res, 200, { success: true, earnedPaise: earnPaise, billed: true });
    }

    // ── Record click (with fraud validation — protects advertiser money) ──
    if (method === 'POST' && url === '/v1/click') {
      const b = await getBody(req);
      const userId = b.userId || 'anon';

      // House-ad click — no advertiser to bill, just log it (no extra developer earning beyond the impression)
      const houseAdC = (db.houseAds || []).find(h => h.id === b.campaignId);
      if (houseAdC) {
        const check = validateClick(userId, houseAdC.id, ip);
        db.clicks.push({ id: uid('cl_'), userId, campaignId: houseAdC.id, ts: Date.now(), ip, valid: check.valid, reason: check.reason, costPaise: 0, isHouseAd: true });
        saveDB();
        return send(res, 200, { success: check.valid, reason: check.valid ? undefined : check.reason, billed: false, isHouseAd: true });
      }

      const c = db.campaigns[b.campaignId];
      if (!c) return send(res, 404, { error: 'campaign not found' });

      const check = validateClick(userId, c.id, ip);
      const clickCostPaiseForRecord = Math.floor(c.bidPaise / 1000) * 50;
      const clickRecord = { id: uid('cl_'), userId, campaignId: c.id, ts: Date.now(), ip, valid: check.valid, reason: check.reason, costPaise: check.valid ? clickCostPaiseForRecord : 0 };
      db.clicks.push(clickRecord);

      if (!check.valid) {
        saveDB();
        return send(res, 200, { success: false, reason: check.reason, billed: false });
      }
      // valid click bills advertiser 50x impression, dev earns 50% of that
      const clickCostPaise = Math.floor(c.bidPaise / 1000) * 50;
      const clickEarnPaise = Math.floor(clickCostPaise / 2);
      if (c.spentPaise + clickCostPaise <= c.budgetPaise) {
        c.spentPaise += clickCostPaise;
      }
      saveDB();
      return send(res, 200, { success: true, earnedPaise: clickEarnPaise, billed: true });
    }

    // ═══════════ ADVERTISER ═══════════
    if (url.startsWith('/v1/advertiser')) {
      const user = auth(req);
      if (!user || user.role !== 'advertiser') return send(res, 403, { error: 'advertiser access required' });

      // create campaign — starts unpaid. Must complete Razorpay payment before it can go live.
      if (method === 'POST' && url === '/v1/advertiser/campaigns') {
        const b = await getBody(req);
        if (!b.adText || !b.url || !b.bidPaise) return send(res, 400, { error: 'adText, url, bidPaise required' });
        if (b.bidPaise < 20000) return send(res, 400, { error: 'minimum bid ₹200 per 1K (20000 paise)' });
        const id = uid('c_');
        db.campaigns[id] = {
          id, advertiserId: user.id, advertiser: user.company || user.name || user.email,
          adText: b.adText, url: b.url, bidPaise: b.bidPaise,
          budgetPaise: b.budgetPaise || 100000, spentPaise: 0,
          status: 'pending_payment', createdAt: Date.now(), targetingCategory: b.targetingCategory || 'all',
          paymentId: null, orderId: null, paidAt: null, refunded: false,
        };
        saveDB();
        return send(res, 201, { campaign: db.campaigns[id] });
      }

      // create a Razorpay order for this campaign's budget (only if unpaid and owned by this advertiser)
      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/create-order$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'campaign not found' });
        if (c.status !== 'pending_payment') return send(res, 400, { error: 'This campaign is not awaiting payment.' });
        try {
          const order = await razorpayApi('POST', '/orders', { amount: c.budgetPaise, currency: 'INR', receipt: c.id, notes: { campaignId: c.id, advertiserId: user.id } });
          c.orderId = order.id;
          saveDB();
          return send(res, 200, { orderId: order.id, amountPaise: c.budgetPaise, keyId: RAZORPAY_KEY_ID });
        } catch (e) {
          return send(res, 502, { error: e.message });
        }
      }

      // verify Razorpay payment signature, then move campaign to pending_review (awaiting content moderation)
      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/verify-payment$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'campaign not found' });
        if (c.status !== 'pending_payment') return send(res, 400, { error: 'This campaign is not awaiting payment.' });
        const b = await getBody(req);
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = b;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return send(res, 400, { error: 'Missing payment verification fields' });
        if (razorpay_order_id !== c.orderId) return send(res, 400, { error: 'Order mismatch' });
        if (!RAZORPAY_KEY_SECRET) return send(res, 500, { error: 'Razorpay not configured on the server' });
        const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
        if (expectedSig !== razorpay_signature) return send(res, 400, { error: 'Payment signature verification failed' });

        c.status = 'pending_review';
        c.paymentId = razorpay_payment_id;
        c.paidAt = Date.now();
        saveDB();
        return send(res, 200, { campaign: c });
      }

      // advertiser pauses/resumes their OWN already-live campaign (cannot touch payment/review state this way)
      if (method === 'PATCH' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+$/)) {
        const cid = url.split('/').pop();
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'campaign not found' });
        const b = await getBody(req);
        if (b.status === 'paused' && c.status === 'active') c.status = 'paused';
        else if (b.status === 'active' && c.status === 'paused') c.status = 'active';
        else return send(res, 400, { error: 'Cannot change to that status from here' });
        saveDB();
        return send(res, 200, { campaign: c });
      }

      // list my campaigns (includes live rank among all active campaigns, by bid)
      if (method === 'GET' && url === '/v1/advertiser/campaigns') {
        const mine = Object.values(db.campaigns).filter(c => c.advertiserId === user.id);
        const activeSorted = Object.values(db.campaigns)
          .filter(c => c.status === 'active')
          .sort((a, b) => b.bidPaise - a.bidPaise || a.createdAt - b.createdAt);
        const totalActive = activeSorted.length;
        const withRank = mine.map(c => {
          const idx = activeSorted.findIndex(x => x.id === c.id);
          return { ...c, rank: idx >= 0 ? idx + 1 : null, totalActive };
        });
        return send(res, 200, { campaigns: withRank });
      }

      // update advertiser profile (company / name)
      if (method === 'PATCH' && url === '/v1/advertiser/profile') {
        const b = await getBody(req);
        if (typeof b.company === 'string') user.company = b.company.trim();
        if (typeof b.name === 'string') user.name = b.name.trim();
        saveDB();
        return send(res, 200, { user: publicUser(user) });
      }

      // my analytics
      if (method === 'GET' && url === '/v1/advertiser/analytics') {
        const mine = Object.values(db.campaigns).filter(c => c.advertiserId === user.id);
        const ids = new Set(mine.map(c => c.id));
        const imps = db.impressions.filter(i => ids.has(i.campaignId));
        const clk = db.clicks.filter(c => ids.has(c.campaignId) && c.valid);
        const invalidClk = db.clicks.filter(c => ids.has(c.campaignId) && !c.valid);
        const totalSpent = mine.reduce((s, c) => s + c.spentPaise, 0);
        return send(res, 200, {
          campaigns: mine.length,
          activeCampaigns: mine.filter(c => c.status === 'active').length,
          impressions: imps.length,
          validClicks: clk.length,
          blockedClicks: invalidClk.length,  // fraud saved them money
          ctr: imps.length ? (clk.length / imps.length * 100).toFixed(2) : '0.00',
          spentRupees: (totalSpent / 100).toFixed(2),
          savedFromFraudRupees: (invalidClk.length * (mine[0]?.bidPaise || 20000) / 1000 * 50 / 100).toFixed(2),
        });
      }

      // pause/activate campaign
      if (method === 'PATCH' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+$/)) {
        const cid = url.split('/').pop();
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'not found' });
        const b = await getBody(req);
        if (b.status && ['active', 'paused'].includes(b.status)) c.status = b.status;
        saveDB();
        return send(res, 200, { campaign: c });
      }
    }

    // ═══════════ CUSTOMER (earner) ═══════════
    if (url.startsWith('/v1/customer')) {
      const user = auth(req);
      if (!user || user.role !== 'customer') return send(res, 403, { error: 'customer access required' });

      // earnings dashboard
      if (method === 'GET' && url === '/v1/customer/earnings') {
        const imps = db.impressions.filter(i => i.userId === user.id);
        const clk = db.clicks.filter(c => c.userId === user.id && c.valid);
        const totalImpPaise = imps.reduce((s, i) => s + i.earnedPaise, 0);
        const totalClickPaise = clk.length * 100; // simplified
        const paidOut = db.payouts.filter(p => p.userId === user.id && p.status === 'paid')
          .reduce((s, p) => s + p.amountPaise, 0);
        const total = totalImpPaise + totalClickPaise;
        // today
        const dayCut = Date.now() - 864e5;
        const todayPaise = imps.filter(i => i.ts > dayCut).reduce((s, i) => s + i.earnedPaise, 0);
        return send(res, 200, {
          totalEarnedRupees: (total / 100).toFixed(2),
          todayRupees: (todayPaise / 100).toFixed(2),
          pendingRupees: ((total - paidOut) / 100).toFixed(2),
          paidOutRupees: (paidOut / 100).toFixed(2),
          impressions: imps.length,
          clicks: clk.length,
          upiId: user.upiId || null,
        });
      }

      // recent activity (real-time feed)
      if (method === 'GET' && url === '/v1/customer/activity') {
        const imps = db.impressions.filter(i => i.userId === user.id)
          .slice(-30).reverse()
          .map(i => ({ type: 'impression', campaignId: i.campaignId, earnedPaise: i.earnedPaise, ts: i.ts }));
        return send(res, 200, { activity: imps });
      }

      // request payout
      if (method === 'POST' && url === '/v1/customer/payout') {
        const imps = db.impressions.filter(i => i.userId === user.id);
        const total = imps.reduce((s, i) => s + i.earnedPaise, 0);
        const paidOut = db.payouts.filter(p => p.userId === user.id).reduce((s, p) => s + p.amountPaise, 0);
        const available = total - paidOut;
        if (available < 10000) return send(res, 400, { error: 'minimum payout ₹100' });
        if (!user.upiId) return send(res, 400, { error: 'add UPI ID first' });
        const payout = { id: uid('p_'), userId: user.id, amountPaise: available, status: 'pending', ts: Date.now() };
        db.payouts.push(payout); saveDB();
        return send(res, 200, { payout });
      }

      // update UPI
      if (method === 'PATCH' && url === '/v1/customer/profile') {
        const b = await getBody(req);
        if (b.upiId) user.upiId = b.upiId;
        if (b.name) user.name = b.name;
        saveDB();
        return send(res, 200, { user: publicUser(user) });
      }
    }

    // ═══════════ ADMIN ═══════════
    if (url.startsWith('/v1/admin')) {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });

      // overview dashboard
      if (method === 'GET' && url === '/v1/admin/overview') {
        const users = Object.values(db.users);
        const advertisers = users.filter(u => u.role === 'advertiser');
        const customers = users.filter(u => u.role === 'customer');
        const totalSpent = Object.values(db.campaigns).reduce((s, c) => s + c.spentPaise, 0);
        const validClicks = db.clicks.filter(c => c.valid).length;
        const blockedClicks = db.clicks.filter(c => !c.valid).length;
        const sevenDaysAgo = Date.now() - 7 * 864e5;
        const activeUsers = users.filter(u => u.lastActiveAt && u.lastActiveAt > sevenDaysAgo && u.role !== 'admin').length;
        const totalRegistered = advertisers.length + customers.length;
        const extStats = await getExtensionStats();
        return send(res, 200, {
          advertisers: advertisers.length,
          customers: customers.length,
          totalRegisteredUsers: totalRegistered,
          activeUsers7d: activeUsers,
          extensionInstalls: extStats.installCount, // null if marketplace fetch failed — never fabricated
          extensionStatsError: extStats.error || null,
          campaigns: Object.keys(db.campaigns).length,
          activeCampaigns: Object.values(db.campaigns).filter(c => c.status === 'active').length,
          pendingPaymentCampaigns: Object.values(db.campaigns).filter(c => c.status === 'pending_payment').length,
          pendingCampaigns: Object.values(db.campaigns).filter(c => c.status === 'pending_review').length,
          impressions: db.impressions.length,
          validClicks, blockedClicks,
          fraudFlags: db.fraudFlags.length,
          bannedUsers: users.filter(u => u.banned).length,
          platformRevenueRupees: (totalSpent / 2 / 100).toFixed(2),
          payoutsOwedRupees: (db.impressions.reduce((s, i) => s + i.earnedPaise, 0) / 100).toFixed(2),
        });
      }

      // all advertisers
      if (method === 'GET' && url === '/v1/admin/advertisers') {
        const advs = Object.values(db.users).filter(u => u.role === 'advertiser').map(u => {
          const camps = Object.values(db.campaigns).filter(c => c.advertiserId === u.id);
          return { ...publicUser(u), campaigns: camps.length, totalSpentRupees: (camps.reduce((s, c) => s + c.spentPaise, 0) / 100).toFixed(2) };
        });
        return send(res, 200, { advertisers: advs });
      }

      // all customers
      if (method === 'GET' && url === '/v1/admin/customers') {
        const custs = Object.values(db.users).filter(u => u.role === 'customer').map(u => {
          const imps = db.impressions.filter(i => i.userId === u.id);
          const flags = db.fraudFlags.filter(f => f.userId === u.id);
          return { ...publicUser(u), impressions: imps.length, earnedRupees: (imps.reduce((s, i) => s + i.earnedPaise, 0) / 100).toFixed(2), fraudFlags: flags.length };
        });
        return send(res, 200, { customers: custs });
      }

      // all campaigns
      if (method === 'GET' && url === '/v1/admin/campaigns') {
        return send(res, 200, { campaigns: Object.values(db.campaigns) });
      }

      // approve / reject campaign — approval only allowed once payment is verified (pending_review).
      // Rejecting a paid campaign automatically refunds the advertiser via Razorpay.
      if (method === 'PATCH' && url.match(/^\/v1\/admin\/campaigns\/[^/]+$/)) {
        const cid = url.split('/').pop();
        const c = db.campaigns[cid];
        if (!c) return send(res, 404, { error: 'not found' });
        const b = await getBody(req);
        if (b.status === 'active') {
          if (c.status !== 'pending_review') return send(res, 400, { error: `Cannot activate — campaign status is "${c.status}", payment not yet verified.` });
          c.status = 'active';
        } else if (b.status === 'rejected') {
          if (c.paymentId && !c.refunded) {
            try {
              await razorpayApi('POST', `/payments/${c.paymentId}/refund`, { notes: { reason: b.reason || 'Campaign rejected — policy review' } });
              c.refunded = true;
            } catch (e) {
              saveDB();
              return send(res, 502, { error: 'Refund failed: ' + e.message + '. Campaign NOT marked rejected — retry once Razorpay issue is resolved.' });
            }
          }
          c.status = 'rejected';
          c.rejectReason = b.reason || null;
        } else if (b.status === 'paused' && c.status === 'active') {
          c.status = 'paused';
        }
        saveDB();
        return send(res, 200, { campaign: c });
      }

      // ── HOUSE ADS: manage the zero-advertiser fallback ──
      if (method === 'GET' && url === '/v1/admin/house-ads') {
        return send(res, 200, { houseAds: db.houseAds || [] });
      }
      if (method === 'POST' && url === '/v1/admin/house-ads') {
        const b = await getBody(req);
        if (!b.text || !b.url) return send(res, 400, { error: 'text and url required' });
        const ad = { id: uid('house_'), text: b.text, url: b.url, active: b.active !== false, createdAt: Date.now() };
        db.houseAds.push(ad);
        saveDB();
        return send(res, 201, { houseAd: ad });
      }
      if (method === 'PATCH' && url.match(/^\/v1\/admin\/house-ads\/[^/]+$/)) {
        const id = url.split('/').pop();
        const ad = (db.houseAds || []).find(h => h.id === id);
        if (!ad) return send(res, 404, { error: 'not found' });
        const b = await getBody(req);
        if (typeof b.text === 'string') ad.text = b.text;
        if (typeof b.url === 'string') ad.url = b.url;
        if (typeof b.active === 'boolean') ad.active = b.active;
        saveDB();
        return send(res, 200, { houseAd: ad });
      }
      if (method === 'DELETE' && url.match(/^\/v1\/admin\/house-ads\/[^/]+$/)) {
        const id = url.split('/').pop();
        db.houseAds = (db.houseAds || []).filter(h => h.id !== id);
        saveDB();
        return send(res, 200, { deleted: true });
      }

      // ── WAITLIST: preview (count + already-sent count, no email content sent here) ──
      if (method === 'GET' && url === '/v1/admin/waitlist') {
        try {
          const emails = await fetchWaitlistEmails();
          const alreadySent = emails.filter(e => db.sentLaunchEmails[e]).length;
          const sentList = Object.entries(db.sentLaunchEmails)
            .map(([email, info]) => ({ email, sentAt: info.sentAt, subject: info.subject }))
            .sort((a, b) => b.sentAt - a.sentAt);
          return send(res, 200, {
            total: emails.length,
            alreadySent,
            pending: emails.length - alreadySent,
            sample: emails.slice(0, 10),
            sentList,
          });
        } catch (e) {
          return send(res, 502, { error: 'Could not read waitlist from Supabase: ' + e.message });
        }
      }

      // ── WAITLIST: send bulk launch email (duplicate-send protected) ──
      if (method === 'POST' && url === '/v1/admin/send-launch-email') {
        if (!RESEND_API_KEY) return send(res, 500, { error: 'RESEND_API_KEY not configured on the server' });
        const b = await getBody(req);
        if (!b.subject || !b.html) return send(res, 400, { error: 'subject and html are required' });

        let emails;
        try { emails = await fetchWaitlistEmails(); }
        catch (e) { return send(res, 502, { error: 'Could not read waitlist from Supabase: ' + e.message }); }

        const targets = b.force ? emails : emails.filter(e => !db.sentLaunchEmails[e]);
        const results = { totalWaitlist: emails.length, attempted: targets.length, sent: 0, failed: [] };

        for (const email of targets) {
          try {
            await sendResendEmail({ to: email, subject: b.subject, html: b.html });
            db.sentLaunchEmails[email] = { sentAt: Date.now(), subject: b.subject };
            results.sent++;
          } catch (e) {
            results.failed.push({ email, error: e.message });
          }
          await new Promise(r => setTimeout(r, 250)); // gentle pacing, avoid Resend rate limits
        }
        saveDB();
        return send(res, 200, results);
      }

      // ── SECURITY PANEL: fraud flags ──
      if (method === 'GET' && url === '/v1/admin/security') {
        const flags = db.fraudFlags.slice(-100).reverse().map(f => ({
          ...f, userEmail: db.users[f.userId]?.email || f.userId,
        }));
        const byType = {};
        db.fraudFlags.forEach(f => { byType[f.type] = (byType[f.type] || 0) + 1; });
        const blockedClicks = db.clicks.filter(c => !c.valid);
        const moneySavedPaise = blockedClicks.reduce((s, c) => {
          const camp = db.campaigns[c.campaignId];
          return s + (camp ? Math.floor(camp.bidPaise / 1000) * 50 : 0);
        }, 0);
        return send(res, 200, {
          flags, byType,
          blockedClicks: blockedClicks.length,
          moneySavedRupees: (moneySavedPaise / 100).toFixed(2),
          thresholds: FRAUD,
        });
      }

      // ban / unban user (with optional reason — e.g. "ad policy violation", "nudity")
      if (method === 'PATCH' && url.match(/^\/v1\/admin\/users\/[^/]+$/)) {
        const uidToBan = url.split('/').pop();
        const target = db.users[uidToBan];
        if (!target) return send(res, 404, { error: 'not found' });
        const b = await getBody(req);
        if (typeof b.banned === 'boolean') {
          target.banned = b.banned;
          target.banReason = b.banned ? (b.reason || 'Not specified') : null;
          target.bannedAt = b.banned ? Date.now() : null;
        }
        if (b.role === 'advertiser' || b.role === 'customer') target.role = b.role;
        saveDB();
        return send(res, 200, { user: publicUser(target) });
      }
    }

    // ── public bidding stats (for homepage live bidding section) ──
    if (method === 'GET' && url === '/v1/public/bidding-stats') {
      const activeCampaigns = Object.values(db.campaigns)
        .filter(c => c.status === 'active')
        .sort((a, b) => b.bidPaise - a.bidPaise)
        .map(c => ({ advertiser: c.advertiser, adText: c.adText, bidPaise: c.bidPaise, targetingCategory: c.targetingCategory }));

      // last 14 days of real spend, grouped by calendar day (no fabricated history)
      const days = 14;
      const dayMs = 864e5;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const buckets = [];
      for (let i = days - 1; i >= 0; i--) {
        const dayStart = today.getTime() - i * dayMs;
        buckets.push({ date: new Date(dayStart).toISOString().slice(0, 10), start: dayStart, end: dayStart + dayMs, spentPaise: 0, impressions: 0 });
      }
      function addToBucket(ts, costPaise) {
        const b = buckets.find(b => ts >= b.start && ts < b.end);
        if (b) { b.spentPaise += (costPaise || 0); b.impressions += 1; }
      }
      db.impressions.forEach(i => addToBucket(i.ts, i.costPaise));
      db.clicks.filter(c => c.valid).forEach(c => addToBucket(c.ts, c.costPaise));

      const dailyBidding = buckets.map(b => ({ date: b.date, spentRupees: (b.spentPaise / 100).toFixed(2), impressions: b.impressions }));
      const todayBucket = buckets[buckets.length - 1];

      return send(res, 200, {
        activeCampaignsCount: activeCampaigns.length,
        activeCampaigns,
        todaySpentRupees: (todayBucket.spentPaise / 100).toFixed(2),
        todayImpressions: todayBucket.impressions,
        dailyBidding,
        updatedAt: Date.now(),
      });
    }

    // ── public stats (for website ticker) ──
    if (method === 'GET' && url === '/v1/stats') {
      const totalEarned = db.impressions.reduce((s, i) => s + i.earnedPaise, 0);
      return send(res, 200, {
        totalImpressions: db.impressions.length,
        activeCampaigns: Object.values(db.campaigns).filter(c => c.status === 'active').length,
        totalEarnedByDevsRupees: (totalEarned / 100).toFixed(2),
      });
    }

    return send(res, 404, { error: 'not found', url });
  } catch (e) {
    console.error('Server error:', e);
    return send(res, 500, { error: 'internal error' });
  }
});

// ── Waitlist + bulk email helpers ──────────────────────────────────────────────
// Reads the waitlist table directly from Supabase using the service-role key,
// bypassing RLS. Assumes a column named "email" — adjust here if your table differs.
async function fetchWaitlistEmails() {
  if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY not configured on the server');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?select=email`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase REST returned ${r.status}`);
  const rows = await r.json();
  const emails = rows.map(row => (row.email || '').toLowerCase().trim()).filter(Boolean);
  return [...new Set(emails)]; // dedupe
}

async function sendResendEmail({ to, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: LAUNCH_EMAIL_FROM, to: [to], subject, html }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${errBody.slice(0, 200)}`);
  }
  return r.json();
}

function publicUser(u) {
  return { id: u.id, email: u.email, phone: u.phone || '', role: u.role, name: u.name, company: u.company, upiId: u.upiId, provider: u.provider || 'email', emailVerified: !!u.emailVerified, phoneVerified: !!u.phoneVerified, banned: u.banned, banReason: u.banReason || null, lastActiveAt: u.lastActiveAt || null, createdAt: u.createdAt };
}

(async () => {
  await loadDB();
  seed();
  server.listen(PORT, () => console.log(`WaitJI AI API v3 running on port ${PORT} (storage: ${pgAvailable ? 'Postgres' : 'LOCAL DISK — NOT PERSISTENT'})`));
})();
