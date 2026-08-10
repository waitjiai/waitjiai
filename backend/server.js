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
const ENCRYPT_KEY = process.env.ENCRYPT_KEY || crypto.scryptSync('waitji-default-encrypt-key-change-in-prod', 'salt', 32);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@waitjiai.in';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'WaitJI@Admin2026';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const DATABASE_URL = process.env.DATABASE_URL || null;
const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tqfjdhneycntoasahstt.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxZmpkaG5leWNudG9hc2Foc3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2Mjg1ODcsImV4cCI6MjA5NzIwNDU4N30.u5oqo0c9tmZ7OxZW6R2hbMxUyVrM4nedYsGKC8PR4TA';
const EXTENSION_ID = process.env.EXTENSION_ID || 'WaitJiai.waitji-ai';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
// Set QIVALABS_GSTIN in Render env vars ONLY once QivaLabs LLP is actually GST-registered.
// Until then this stays null and invoices correctly show "Not GST registered" with
// zero GST charged — charging GST without a valid GSTIN is not legally permitted in India.
const QIVALABS_GSTIN = process.env.QIVALABS_GSTIN || null;

// ── PayPal Payouts (international developer payouts) ────────────────────────
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || null;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || null;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live'; // 'live' or 'sandbox'
const PAYPAL_BASE = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';
const paypalEnabled = () => !!(PAYPAL_CLIENT_ID && PAYPAL_SECRET);

let _ppToken = null, _ppTokenExp = 0;
async function paypalToken() {
  if (_ppToken && Date.now() < _ppTokenExp) return _ppToken;
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal auth failed: ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  _ppToken = d.access_token;
  _ppTokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return _ppToken;
}

// INR → USD conversion for international payouts
const INR_TO_USD = Number(process.env.INR_TO_USD || 0.0119); // ~₹84/$

async function paypalPayout(email, amountPaise, note) {
  if (!paypalEnabled()) throw new Error('PayPal not configured');
  const token = await paypalToken();
  const usd = Math.max(1, (amountPaise / 100) * INR_TO_USD).toFixed(2);
  const batchId = 'WJ_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const r = await fetch(`${PAYPAL_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: 'WaitJI AI — your developer earnings',
        email_message: note || 'Your WaitJI AI earnings payout. Thank you for being part of the marketplace.',
      },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: usd, currency: 'USD' },
        receiver: email,
        note: note || 'WaitJI AI developer earnings',
        sender_item_id: batchId + '_1',
      }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('PayPal payout failed: ' + JSON.stringify(d).slice(0, 300));
  return { batchId: d.batch_header?.payout_batch_id, status: d.batch_header?.batch_status, usd };
}
const LAUNCH_EMAIL_FROM = process.env.LAUNCH_EMAIL_FROM || 'WaitJI AI <admin@waitjiai.in>';

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
const ENC_KEY = typeof ENCRYPT_KEY === 'string'
  ? crypto.scryptSync(ENCRYPT_KEY, 'waitji-salt-v1', 32)
  : ENCRYPT_KEY;
function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(text) {
  if (!text || !String(text).startsWith('enc:')) return text;
  try {
    const buf = Buffer.from(text.slice(4), 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch { return text; }
}

// ── Rate limiter — login/signup brute-force protection ──────────────────────
const loginAttempts = new Map(); // ip -> { count, resetAt }
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 15 * 60000; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= 10; // 10 attempts per 15 min
}
// Clear stale entries hourly
setInterval(() => { const now = Date.now(); loginAttempts.forEach((v, k) => { if (now > v.resetAt) loginAttempts.delete(k); }); }, 3600000);

// ── Admin audit log ──────────────────────────────────────────────────────────
function auditLog(adminId, action, detail) {
  db.auditLog = db.auditLog || [];
  const admin = db.users[adminId];
  db.auditLog.push({
    id: uid('audit_'),
    adminId,
    adminEmail: admin?.email || adminId,
    action,
    detail,
    ts: Date.now(),
  });
  if (db.auditLog.length > 1000) db.auditLog = db.auditLog.slice(-1000);
  try { saveDB(); } catch (e) { /* non-fatal */ }
}



// Cashfree Payouts — for automatic UPI/bank transfers to earners
// Get from Cashfree dashboard → Payouts → API Keys
const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID || null;
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || null;
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'production'; // 'sandbox' for testing
const CASHFREE_BASE = CASHFREE_ENV === 'sandbox'
  ? 'https://sandbox.cashfree.com'
  : 'https://api.cashfree.com';

async function cashfreeApi(method, path, body) {
  if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) throw new Error('Cashfree is not configured (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET missing)');
  const r = await fetch(`${CASHFREE_BASE}${path}`, {
    method,
    headers: {
      'x-client-id': CASHFREE_CLIENT_ID,
      'x-client-secret': CASHFREE_CLIENT_SECRET,
      'x-api-version': '2024-01-01',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.message || `Cashfree ${method} ${path} → ${r.status}`);
  return { data: d, status: r.status };
}

// ── Shared withdrawal-approval logic ───────────────────────────────────────────
// Extracted so both the single "/approve" endpoint and the bulk
// "/approve-all-for-user" endpoint share one code path (previously this logic
// was duplicated only in the single-approve route, and approve-all-for-user
// didn't exist at all — its button in admin.html called a route with no handler).
async function approveOneWithdrawal(wr, adminUserId, note) {
  const earner = db.users[wr.userId];

  let cashfreeTransferId = null;
  let cashfreeError = null;
  let autoPaid = false;

  // ── PayPal route (international developers) ──
  if (earner?.payoutMode === 'paypal' && earner.paypalEmail && paypalEnabled()) {
    try {
      const pp = await paypalPayout(earner.paypalEmail, wr.amountPaise, `WaitJI AI earnings — ${(wr.amountPaise/100).toFixed(2)} INR`);
      autoPaid = true;
      wr.paypalBatchId = pp.batchId;
      wr.paypalUsd = pp.usd;
    } catch (e) {
      cashfreeError = 'PayPal: ' + e.message;
    }
  }
  // ── Cashfree route (Indian developers — UPI/bank) ──
  else if (CASHFREE_CLIENT_ID && CASHFREE_CLIENT_SECRET && earner) {
    try {
      const transferBody = {
        transfer_id: wr.id,
        transfer_amount: (wr.amountPaise / 100).toFixed(2),
        transfer_currency: 'INR',
        transfer_mode: earner.payoutMode === 'bank' && earner.bankAccount ? 'banktransfer' : 'upi',
        beneficiary_details: earner.payoutMode === 'bank' && earner.bankAccount ? {
          beneficiary_id: 'BEN_' + wr.userId,
          beneficiary_name: earner.bankAccount.accountHolder,
          beneficiary_instrument_details: {
            bank_account_number: decrypt(earner.bankAccount.accountNumber),
            bank_ifsc: earner.bankAccount.ifsc,
          },
        } : {
          beneficiary_id: 'BEN_' + wr.userId,
          beneficiary_name: earner.name || earner.email,
          beneficiary_instrument_details: {
            vpa: earner.upiId,
          },
        },
      };
      const { data } = await cashfreeApi('POST', '/payout/v2/transfers', transferBody);
      cashfreeTransferId = data?.data?.transfer_id || data?.transfer_id || wr.id;
      autoPaid = true;
      wr.cashfreeTransferId = cashfreeTransferId;
    } catch (e) {
      cashfreeError = e.message;
      // Don't block approval — admin can still manually pay
    }
  }

  wr.status = 'approved';
  wr.reviewedAt = Date.now();
  wr.reviewNote = note;
  wr.autoPaid = autoPaid;

  db.payouts.push({ id: uid('p_'), userId: wr.userId, amountPaise: wr.amountPaise, status: autoPaid ? 'paid' : 'approved', ts: Date.now(), withdrawalRequestId: wr.id, cashfreeTransferId });
  auditLog(adminUserId, autoPaid ? 'withdrawal_paid' : 'withdrawal_approved', { wrId: wr.id, userId: wr.userId, amountPaise: wr.amountPaise });
  saveDB();

  if (RESEND_API_KEY && earner?.email) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: LAUNCH_EMAIL_FROM,
        to: [earner.email],
        subject: `✅ Your withdrawal of ₹${(wr.amountPaise/100).toFixed(2)} has been ${autoPaid ? 'processed' : 'approved'}`,
        html: `<p>Hi ${earner.name||'there'},</p>
          <p>Your withdrawal has been <b>${autoPaid ? 'automatically processed via Cashfree' : 'approved'}</b>.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
            <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Amount</td><td><b>₹${(wr.amountPaise/100).toFixed(2)}</b></td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Paid to</td><td>${wr.upiId || (earner.bankAccount?.accountNumber ? 'Bank account ending '+decrypt(earner.bankAccount.accountNumber).slice(-4) : '—')}</td></tr>
            ${autoPaid ? '<tr><td style="padding:6px 12px 6px 0;color:#6B7185">Status</td><td>Transferred — should arrive within minutes to a few hours</td></tr>' : '<tr><td style="padding:6px 12px 6px 0;color:#6B7185">ETA</td><td>2–3 business days</td></tr>'}
            ${wr.reviewNote ? `<tr><td style="padding:6px 12px 6px 0;color:#6B7185">Note</td><td>${wr.reviewNote}</td></tr>` : ''}
          </table>
          <p>— WaitJI AI Team</p>`,
      }),
    }).catch(() => {});
  }

  return { autoPaid, cashfreeTransferId, cashfreeError };
}

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
// ── Profile completion helper ──────────────────────────────────────────────────
// A profile is "complete" if the earner has: name, phone, email verified,
// AND either a verified UPI ID or a verified bank account (account+IFSC).
// Withdrawal is blocked until all four requirements are met.
function profileCompletion(user) {
  const checks = {
    name: !!(user.name && user.name.trim().length >= 2),
    phone: !!(user.phone && /^[6-9]\d{9}$/.test(user.phone.replace(/\D/g, ''))),
    emailVerified: !!user.emailVerified,
    payoutMethod: !!(user.upiVerified && user.upiId) || !!(user.bankVerified && user.bankAccount?.accountNumber) || !!(user.paypalVerified && user.paypalEmail),
  };
  const completed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  return { checks, completed, total, isComplete: completed === total };
}

// ── IFSC verification using free public IFSC API ──────────────────────────────
async function verifyIFSC(ifsc) {
  try {
    const r = await fetch(`https://ifsc.razorpay.com/${ifsc.toUpperCase()}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    return await r.json(); // { BANK, BRANCH, CITY, STATE, ADDRESS, CONTACT, MICR, UPI, RTGS, NEFT, IMPS }
  } catch { return null; }
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
  withdrawalRequests: [], // { id, userId, amountPaise, upiId, status, requestedAt, reviewedAt, reviewNote }
  discountCodes: [],      // { id, code, discountPct, maxUses, usedCount, expiresAt, createdAt, active, description }
  waitlist: [],           // { email, source, joinedAt } — public waitlist signups (blog + status page forms)
  disputes: [],            // { id, userId, flagId, message, status, createdAt, resolvedAt, adminNote }
};
const HOUSE_AD_RATE_PAISE = 5000; // ₹50 per 1000 impressions, founder-funded

// ── Country-specific pricing (PPP + exchange rate adjusted) ──────────────────
// Base: India ₹800 Spotlight / ₹300 Stream per 1K impressions
// All prices stored internally in INR paise. Exchange rates approximate June 2026.
// Logic: USD price × exchange_rate = INR equivalent, then PPP-adjust for local economy
const GEO_PRICING = {
  IN: { currency:'INR', symbol:'₹', rate:1, spotlight:{ min:80000, recommended:80000 }, stream:{ min:30000, recommended:30000 }, label:'India', minBudgetSpotlight:500000, minBudgetStream:200000 },
  US: { currency:'USD', symbol:'$', rate:8390, spotlight:{ min:101880, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'USA', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 USD ≈ ₹83.9 · US devs have 3x higher ad value · Spotlight $12/1K, Stream $5/1K
  GB: { currency:'GBP', symbol:'£', rate:10600, spotlight:{ min:106000, recommended:127000 }, stream:{ min:45000, recommended:53000 }, label:'United Kingdom', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 GBP ≈ ₹106 · Spotlight £10/1K
  SG: { currency:'SGD', symbol:'S$', rate:6200, spotlight:{ min:99200, recommended:111600 }, stream:{ min:40000, recommended:46000 }, label:'Singapore', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 SGD ≈ ₹62 · Spotlight S$16/1K
  AU: { currency:'AUD', symbol:'A$', rate:5450, spotlight:{ min:98100, recommended:115000 }, stream:{ min:40000, recommended:47000 }, label:'Australia', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 AUD ≈ ₹54.5 · Spotlight A$18/1K
  CA: { currency:'CAD', symbol:'C$', rate:6150, spotlight:{ min:98400, recommended:115000 }, stream:{ min:40000, recommended:47000 }, label:'Canada', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 CAD ≈ ₹61.5 · Spotlight C$16/1K
  DE: { currency:'EUR', symbol:'€', rate:9050, spotlight:{ min:99550, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'Germany', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 EUR ≈ ₹90.5 · Spotlight €11/1K
  NL: { currency:'EUR', symbol:'€', rate:9050, spotlight:{ min:99550, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'Netherlands', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  AE: { currency:'AED', symbol:'AED', rate:2285, spotlight:{ min:91400, recommended:109000 }, stream:{ min:38000, recommended:45000 }, label:'UAE', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 AED ≈ ₹22.85 · Spotlight AED 40/1K
  JP: { currency:'JPY', symbol:'¥', rate:56, spotlight:{ min:100800, recommended:120000 }, stream:{ min:42000, recommended:50000 }, label:'Japan', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 JPY ≈ ₹0.56 · Spotlight ¥1800/1K
};

function getGeoPricing(countries) {
  // Return pricing for the first/primary target country
  const primary = (countries && countries[0]) || 'IN';
  return GEO_PRICING[primary] || GEO_PRICING['IN'];
}

// Public endpoint to get pricing for a country


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
        db.careers ||= [];
        db.jobs ||= [];
        db.auditLog ||= [];
        db.ipBlockList ||= [];
        db.sessions ||= {};      // userId -> { start, lastSeen, impressions, sessionCount }
        db.loginLog ||= [];      // { userId, email, role, ip, ua, ts }
        db.sentLaunchEmails ||= {};
        db.houseAds ||= [];
        db.withdrawalRequests ||= [];
        db.discountCodes ||= [];
        db.waitlist ||= [];
        db.disputes ||= [];
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
      db.waitlist ||= [];
      db.disputes ||= [];
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
  if (!db.jobs || db.jobs.length === 0) {
    db.jobs = [
      { id: uid('job_'), title: 'Full-Stack Developer', type: 'Full-time', location: 'Remote / Udaipur', tags: ['full-time','remote'], description: 'Node.js backend, Postgres, VS Code extension (TypeScript), HTML/CSS/JS frontend. You\'ll own features end-to-end — from idea to deployed. We move fast and ship daily.', requirements: 'Node.js, TypeScript, SQL, Git. Bonus: VS Code extension API experience.', active: true, createdAt: Date.now(), order: 0 },
      { id: uid('job_'), title: 'VS Code Extension Developer', type: 'Full-time', location: 'Remote', tags: ['full-time','remote'], description: 'Deep expertise in the VS Code extension API. You\'ll improve our spinnerVerbs integration, build new surfaces, and solve problems that no Stack Overflow answer covers.', requirements: 'VS Code Extension API, TypeScript, Node.js.', active: true, createdAt: Date.now(), order: 1 },
      { id: uid('job_'), title: 'Growth & BD Intern', type: 'Internship', location: 'Remote', tags: ['internship','commission','remote'], description: 'Acquire advertisers — SaaS companies, bootcamps, developer tools. No fixed salary; earn 10% commission on every campaign you close. Uncapped earning potential.', requirements: 'Communication skills, persistence, basic understanding of B2B SaaS.', active: true, createdAt: Date.now(), order: 2 },
      { id: uid('job_'), title: 'UI/UX Designer', type: 'Part-time / Full-time', location: 'Remote / Udaipur', tags: ['full-time','remote'], description: 'Design the advertiser dashboard, developer earnings UI, and marketing pages. Figma-first. You\'ll have full creative ownership.', requirements: 'Figma, strong visual design sense, experience with SaaS dashboards.', active: true, createdAt: Date.now(), order: 3 },
      { id: uid('job_'), title: 'Developer Relations & Content', type: 'Internship', location: 'Remote', tags: ['internship','remote'], description: 'Write for dev.to, write Twitter threads, make YouTube demos, engage with the Claude Code community.', requirements: 'Strong writing skills, active developer community presence.', active: true, createdAt: Date.now(), order: 4 },
    ];
    console.log('Seeded default jobs');
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

// ── FEATURE: role-based admin sub-accounts ──────────────────────────────────────
// An admin user without `adminScope` set (or with adminScope === 'full') is the
// original, unrestricted founder/admin account. Sub-admins created via
// POST /v1/admin/sub-admins get an explicit scopes array and can only reach
// routes that call requireFullAdmin() if 'full' is in their scopes — everything
// else in the /v1/admin block remains open to them (view-only dashboards, etc.)
// since the blast radius of viewing data is much lower than mutating money/bans.
function isFullAdmin(user) {
  return !user.adminScope || user.adminScope === 'full' || (Array.isArray(user.adminScope) && user.adminScope.includes('full'));
}
function requireFullAdmin(user, res) {
  if (isFullAdmin(user)) return true;
  send(res, 403, { error: 'This action requires full-admin access. Your account is scoped to: ' + (Array.isArray(user.adminScope) ? user.adminScope.join(', ') : 'limited') });
  return false;
}
function requireScope(user, allowedScopes, res) {
  if (isFullAdmin(user)) return true;
  const has = Array.isArray(user.adminScope) && user.adminScope.some(s => allowedScopes.includes(s));
  if (has) return true;
  send(res, 403, { error: `This action requires one of these scopes: ${allowedScopes.join(', ')}. Your account is scoped to: ${Array.isArray(user.adminScope) ? user.adminScope.join(', ') : 'limited'}` });
  return false;
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

// ── Real geo resolution from IP ────────────────────────────────────────────────
// Previously every impression's `country` field silently defaulted to 'IN' —
// the extension never sent a real country, and nothing ever looked one up from
// the IP that was already being captured on every impression. All "geo stats"
// were therefore 100% India regardless of where the developer actually was.
// This resolves country from IP via a free lookup, cached in memory per IP so
// we're not hitting the external API on every single impression — most
// developers keep the same IP for a session/day, so the cache does the work
// after the very first impression from a given address.
const geoIpCache = new Map(); // ip -> { country, ts }
const GEO_IP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — IPs can change ISPs/locations over time

function cachedCountryForIp(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return null; // local/dev traffic — no public geo
  const hit = geoIpCache.get(ip);
  if (hit && Date.now() - hit.ts < GEO_IP_CACHE_TTL) return hit.country;
  return null;
}

async function resolveCountryForIpAsync(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return;
  try {
    const r = await fetch(`https://ipapi.co/${ip}/country/`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const code = (await r.text()).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) {
      geoIpCache.set(ip, { country: code, ts: Date.now() });
    }
  } catch {
    // best-effort only — never let a geo lookup failure affect impression recording
  }
}

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
  // Track live session activity
  db.sessions ||= {};
  const now = Date.now();
  const s = db.sessions[userId];
  if (!s || now - s.lastSeen > 15 * 60_000) {
    // New session (gap > 15 min)
    db.sessions[userId] = { start: now, lastSeen: now, impressions: 1, sessionCount: (s?.sessionCount || 0) + 1 };
  } else {
    s.lastSeen = now;
    s.impressions = (s.impressions || 0) + 1;
  }
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
      // Store uptime ping for real 90-day history
      db.uptimePings = db.uptimePings || [];
      const today = new Date().toISOString().slice(0,10);
      if (!db.uptimePings.find(p => p.date === today)) {
        db.uptimePings.push({ date: today, up: true, ts: Date.now() });
        if (db.uptimePings.length > 100) db.uptimePings = db.uptimePings.slice(-100);
        saveDB();
      }
      return send(res, 200, { ok: true, storage: pgAvailable ? 'Postgres' : 'local', ts: Date.now() });
    }

    // ── Public: real 90-day uptime history ──
    if (method === 'GET' && url === '/v1/public/uptime') {
      const dayMs = 864e5;
      const pings = db.uptimePings || [];
      const pingMap = {};
      pings.forEach(p => { pingMap[p.date] = p; });
      const days = [];
      for (let i = 89; i >= 0; i--) {
        const d = new Date(Date.now() - i * dayMs);
        const dateStr = d.toISOString().slice(0,10);
        days.push({ date: dateStr, label: d.toLocaleDateString('en-IN',{month:'short',day:'numeric'}), status: pingMap[dateStr] ? 'ok' : 'no-data' });
      }
      const knownUpDays = pings.filter(p => p.up).length;
      return send(res, 200, { days, uptimePct: pings.length > 0 ? (knownUpDays / pings.length * 100).toFixed(2) : '100.00' });
    }


    // ── Public: waitlist signup (blog "join waitlist" form + status.html subscribe form) ──
    // Was previously dead — frontend called this but no handler existed, so signups silently 404'd.
    if (method === 'POST' && (url === '/v1/waitlist' || url === '/v1/waitlist/join')) {
      const b = await getBody(req);
      const email = (b.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { error: 'Please enter a valid email address' });
      }
      db.waitlist ||= [];
      const existing = db.waitlist.find(w => w.email === email);
      if (existing) {
        return send(res, 200, { success: true, alreadyJoined: true, message: "You're already on the waitlist!" });
      }
      db.waitlist.push({ email, source: b.source || 'unknown', joinedAt: Date.now() });
      saveDB();

      if (RESEND_API_KEY) {
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: LAUNCH_EMAIL_FROM,
            to: [email],
            subject: "You're on the WaitJI AI waitlist! 🎉",
            html: `<p>Hi,</p><p>Thanks for joining the WaitJI AI waitlist. We'll email you the moment there's news — new features, early access, or launch updates.</p><p>— WaitJI AI Team</p>`,
          }),
        }).catch(() => {});
      }

      return send(res, 200, { success: true, alreadyJoined: false, message: "You're on the waitlist!" });
    }

    // ── Public: feature flags for the frontend (no secrets exposed) ──
    if (method === 'GET' && url === '/v1/public/config') {
      return send(res, 200, {
        paypalEnabled: paypalEnabled(),
        razorpayEnabled: !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
        inrToUsd: INR_TO_USD,
      });
    }

    if (method === 'GET' && url === '/v1/public/status') {
      const dayAgo = Date.now() - 864e5;
      const impsToday = db.impressions.filter(i => i.ts > dayAgo).length;
      const activeCamps = Object.values(db.campaigns).filter(c => c.status === 'active').length;
      const totalUsers = Object.keys(db.users).length;
      return send(res, 200, {
        status: 'operational',
        services: {
          api: 'operational',
          database: 'operational',
          payments: 'operational',
        },
        metrics: {
          impsToday,
          activeCampaigns: activeCamps,
          totalUsers,
          uptime: '99.9%',
        },
        checkedAt: Date.now(),
      });
    }

    // ── Public leaderboard — top earners (anonymized) ──
    if (method === 'GET' && url === '/v1/public/leaderboard') {
      const earners = Object.values(db.users)
        .filter(u => u.role === 'customer' && !u.banned)
        .map(u => {
          const imps = db.impressions.filter(i => i.userId === u.id && !i.isHouseAd);
          const clks = db.clicks.filter(c => c.userId === u.id && c.valid);
          const totalPaise = imps.reduce((s, i) => s + (i.earnedPaise||0), 0);
          return { totalPaise, imps: imps.length, clicks: clks.length };
        })
        .filter(e => e.totalPaise > 0)
        .sort((a, b) => b.totalPaise - a.totalPaise)
        .slice(0, 20)
        .map((e, i) => ({
          rank: i + 1,
          handle: `Developer ${Math.random().toString(36).slice(2,7).toUpperCase()}`,
          lifetimeRupees: (e.totalPaise / 100).toFixed(2),
          impressions: e.imps,
          clicks: e.clicks,
        }));
      return send(res, 200, { leaderboard: earners, updatedAt: Date.now() });
    }

    // ── Public bid market — live auction state ──
    if (method === 'GET' && url === '/v1/public/market') {
      const activeCampaigns = Object.values(db.campaigns)
        .filter(c => c.status === 'active')
        .sort((a, b) => b.bidPaise - a.bidPaise)
        .map((c, i) => ({
          rank: i + 1,
          advertiser: c.advertiser || 'Anonymous advertiser',
          bidRupees: (c.bidPaise / 100).toFixed(0),
          adType: c.adType || 'spotlight',
          impressions: db.impressions.filter(i => i.campaignId === c.id).length,
        }));
      const totalImpsLast24h = db.impressions.filter(i => Date.now() - i.ts < 86400000).length;
      const topBid = activeCampaigns[0]?.bidRupees || '0';
      return send(res, 200, {
        market: activeCampaigns,
        stats: {
          activeCampaigns: activeCampaigns.length,
          topBidRupees: topBid,
          developerShare: '65%',
          impsLast24h: totalImpsLast24h,
          clickMultiplier: 50,
          minBidSpotlight: 800,
          minBidStream: 300,
        },
        updatedAt: Date.now(),
      });
    }


    if (method === 'GET' && url === '/') {
      return send(res, 200, { message: 'WaitJI AI API v2', auth: true });
    }

    // ── Auth: Supabase token exchange (customers + advertisers) ──
    // Frontend logs in via Supabase (verified email / Google / phone),
    // then exchanges the Supabase token for a WaitJI backend token.
    if (method === 'POST' && url === '/v1/auth/exchange') {
      if (!checkLoginRateLimit(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const b = await getBody(req);
      const sbUser = await validateSupabaseToken(b.access_token);
      if (!sbUser) return send(res, 401, { error: 'invalid or expired Supabase session' });
      // require verified email (Supabase enforces this too, double-check here)
      // OAuth providers (Google/GitHub) verify the email themselves — trust them.
      const oauthProvider = sbUser.provider && sbUser.provider !== 'email';
      if (!oauthProvider && !sbUser.emailVerified && !sbUser.phoneVerified) {
        return send(res, 403, { error: 'Please verify your email before continuing. Check your inbox (and spam folder) for the verification link.' });
      }
      const profileId = 'sb_' + sbUser.id;
      let user = db.users[profileId];
      const isNewUser = !user;
      if (!user) {
        // First login → create profile. Role comes from Supabase user_metadata
        // (set at signup), falling back to the request body.
        let role = (sbUser.meta.role === 'advertiser' || b.role === 'advertiser') ? 'advertiser' : 'customer';
        user = {
          id: profileId, supabaseId: sbUser.id, email: sbUser.email, phone: sbUser.phone,
          role,
          name: b.name || sbUser.meta.name || sbUser.meta.full_name || sbUser.meta.user_name || '',
          company: b.company || sbUser.meta.company || '',
          avatarUrl: sbUser.meta.avatar_url || sbUser.meta.picture || null,
          upiId: b.upiId || sbUser.meta.upiId || '',
          provider: sbUser.provider || 'email',
          emailVerified: sbUser.emailVerified, phoneVerified: sbUser.phoneVerified,
          createdAt: Date.now(), banned: false, loginCount: 0,
        };
        db.users[profileId] = user;
        // Referral tracking — credit referrer if ref param passed
        if (b.ref && db.users[b.ref] && db.users[b.ref].role === 'customer') {
          user.referredBy = b.ref;
          db.users[b.ref].referralCount = (db.users[b.ref].referralCount || 0) + 1;
        }
      } else {
        // Existing user → refresh verification + contact, but NEVER change role here
        user.email = sbUser.email || user.email;
        user.phone = sbUser.phone || user.phone;
        user.emailVerified = sbUser.emailVerified;
        user.phoneVerified = sbUser.phoneVerified;
        if (sbUser.provider && sbUser.provider !== 'email') user.provider = sbUser.provider;
        if (!user.name && (sbUser.meta.name || sbUser.meta.full_name || sbUser.meta.user_name)) {
          user.name = sbUser.meta.name || sbUser.meta.full_name || sbUser.meta.user_name;
        }
        if (!user.avatarUrl && (sbUser.meta.avatar_url || sbUser.meta.picture)) {
          user.avatarUrl = sbUser.meta.avatar_url || sbUser.meta.picture;
        }
      }
      if (user.banned) return send(res, 403, { error: 'account suspended' });
      saveDB();
      const token = signToken({ uid: user.id, role: user.role });
      // Log the login for admin visibility
      db.loginLog ||= [];
      db.loginLog.push({
        userId: user.id, email: user.email, role: user.role,
        ip, ua: (req.headers['user-agent'] || '').slice(0, 160), ts: Date.now(),
      });
      if (db.loginLog.length > 2000) db.loginLog = db.loginLog.slice(-2000);
      user.lastLoginAt = Date.now();
      user.loginCount = (user.loginCount || 0) + 1;
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
      // Log the login for admin visibility
      db.loginLog ||= [];
      db.loginLog.push({
        userId: user.id, email: user.email, role: user.role,
        ip, ua: (req.headers['user-agent'] || '').slice(0, 160), ts: Date.now(),
      });
      if (db.loginLog.length > 2000) db.loginLog = db.loginLog.slice(-2000);
      user.lastLoginAt = Date.now();
      user.loginCount = (user.loginCount || 0) + 1;
      return send(res, 200, { token, user: publicUser(user) });
    }

    // ── Auth: me ──
    if (method === 'GET' && url === '/v1/auth/me') {
      const user = auth(req);
      if (!user) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { user: publicUser(user) });
    }

    // ═══════════ ADS SERVING (public, used by extension) ═══════════
    if (method === 'GET' && url.startsWith('/v1/ads/active')) {
      const params = new URL('http://x'+url).searchParams;
      const adType = params.get('type') || 'spotlight'; // default: spotlight (VS Code spinner)

      const reqCountry = params.get('country') || 'IN';
      const reqSurface = params.get('surface') || 'terminal';

      // Audience targeting filter
      const now_h = new Date().getHours(); // IST hour
      const ads2 = Object.values(db.campaigns)
        .filter(c => {
          if (c.status !== 'active' || c.spentPaise >= c.budgetPaise) return false;
          if (c.adType && c.adType !== adType) return false;
          // Geo filter
          const geoCountries = c.geo?.countries || ['IN'];
          if (geoCountries.length && !geoCountries.includes(reqCountry)) return false;
          // Time of day targeting
          const tod = c.targeting?.timeOfDay;
          if (tod && tod !== 'all') {
            if (tod === 'morning' && (now_h < 9 || now_h >= 12)) return false;
            if (tod === 'afternoon' && (now_h < 12 || now_h >= 18)) return false;
            if (tod === 'evening' && (now_h < 18 || now_h >= 23)) return false;
          }
          // IDE targeting
          const ideTools = c.targeting?.ideTools || ['vscode'];
          if (ideTools.length && !ideTools.includes('vscode') && reqSurface === 'vscode') return false;
          return true;
        })
        .sort((a, b) => b.bidPaise - a.bidPaise);

      const ads = ads2.slice(0, 3).map(c => {
        // ── FEATURE: multi-creative rotation ──
        // Pick uniformly between the primary ad text/url and any additional
        // creative variants the advertiser added, so they can see which wins.
        const variants = [{ id: 'primary', adText: c.adText, url: c.url }, ...(c.creatives || [])];
        const chosen = variants[Math.floor(Math.random() * variants.length)];
        return { id: c.id, creativeId: chosen.id, text: chosen.adText, url: chosen.url, advertiser: c.advertiser, cpmPaise: c.bidPaise, adType: c.adType || 'spotlight', isHouseAd: false, geo: c.geo };
      });

      if (ads.length > 0) return send(res, 200, { ads, servedAt: Date.now() });

      // No real advertiser campaign is live — fall back to a rotating house ad
      const liveHouseAds = (db.houseAds || []).filter(h => h.active);
      if (liveHouseAds.length === 0) return send(res, 200, { ads: [], servedAt: Date.now() });
      const pick = liveHouseAds[Math.floor(Math.random() * liveHouseAds.length)];
      return send(res, 200, {
        ads: [{ id: pick.id, text: pick.text, url: pick.url, advertiser: 'WaitJI AI', cpmPaise: HOUSE_AD_RATE_PAISE, adType, isHouseAd: true }],
        servedAt: Date.now(),
      });
    }

    // ── Record impression (with fraud check) ──
    if (method === 'POST' && url === '/v1/impression') {
      const b = await getBody(req);
      const userId = b.userId || 'anon';
      // Resolve real country from IP (client rarely sends one) — falls back to
      // 'IN' only for a brand-new IP not yet cached, self-corrects within the session.
      const resolvedCountry = b.country || cachedCountryForIp(ip) || 'IN';
      if (!b.country && !cachedCountryForIp(ip)) resolveCountryForIpAsync(ip); // fire-and-forget, populates cache for next time

      // House-ad impression — founder-funded, no real advertiser budget involved
      const houseAd = (db.houseAds || []).find(h => h.id === b.campaignId);
      if (houseAd) {
        const check = validateImpression(userId, ip);
        if (!check.valid) return send(res, 200, { success: false, reason: check.reason, billed: false });
        const earnPaise = Math.floor(HOUSE_AD_RATE_PAISE / 1000); // full house rate goes to the developer
        db.impressions.push({ id: uid('i_'), userId, campaignId: houseAd.id, earnedPaise: earnPaise, costPaise: 0, isHouseAd: true, ts: Date.now(), ip, clicked: false, country: resolvedCountry, surface: b.surface||'terminal' });
        saveDB();
        return send(res, 200, { success: true, earnedPaise: earnPaise, billed: true, isHouseAd: true });
      }

      const c = db.campaigns[b.campaignId];
      if (!c) return send(res, 404, { error: 'campaign not found' });

      const check = validateImpression(userId, ip);
      if (!check.valid) return send(res, 200, { success: false, reason: check.reason, billed: false });

      const earnPaise = Math.floor(c.bidPaise / 1000 * 0.65); // 65% of per-impression to developer
      const advCostPaise = Math.floor(c.bidPaise / 1000);
      // budget guard
      if (c.spentPaise + advCostPaise > c.budgetPaise) {
        c.status = 'completed'; saveDB();
        return send(res, 200, { success: false, reason: 'budget_exhausted', billed: false });
      }
      c.spentPaise += advCostPaise;

      // ── FEATURE: multi-creative rotation — track which variant was shown ──
      const shownCreativeId = b.creativeId || 'primary';
      if (shownCreativeId !== 'primary' && Array.isArray(c.creatives)) {
        const cr = c.creatives.find(x => x.id === shownCreativeId);
        if (cr) cr.impressions = (cr.impressions || 0) + 1;
      }

      // No frequency cap — earners earn unlimited impressions
      db.impressions.push({ id: uid('i_'), userId, campaignId: c.id, earnedPaise: earnPaise, costPaise: advCostPaise, isHouseAd: false, ts: Date.now(), ip, clicked: false, country: resolvedCountry, surface: b.surface||'terminal', adType: c.adType || 'spotlight', advertiserName: c.advertiser || c.companyName || 'Unknown', adText: (c.adText||'').slice(0,60), creativeId: shownCreativeId });

      // Spend alert — notify advertiser at 80% budget
      const spentPct = c.spentPaise / c.budgetPaise;
      if (spentPct >= 0.80 && spentPct < 0.80 + advCostPaise/c.budgetPaise && RESEND_API_KEY) {
        const adv = db.users[c.advertiserId];
        if (adv?.email && !c.alertSent80) {
          c.alertSent80 = true;
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: LAUNCH_EMAIL_FROM,
              to: [adv.email],
              subject: `⚠️ Campaign budget at 80% — ${c.campaignName || c.adText?.slice(0,30)}`,
              html: `<p>Hi ${adv.name || 'there'},</p><p>Your campaign <b>"${c.adText?.slice(0,50)}"</b> has used 80% of its budget (₹${(c.spentPaise/100).toFixed(2)} of ₹${(c.budgetPaise/100).toFixed(2)}).</p><p>It will pause automatically when the budget runs out. Add more budget to keep it running.</p><p><a href="https://waitjiai.in/advertiser.html" style="background:#2A7A4F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;margin-top:8px;">Top up budget →</a></p>`,
            }),
          }).catch(()=>{});
        }
      }

      // Referral credit — referrer earns 10% of impression
      if (db.users[userId]?.referredBy) {
        const referrer = db.users[db.users[userId].referredBy];
        if (referrer && !referrer.banned) {
          const refEarn = Math.floor(earnPaise * 0.10);
          db.impressions.push({ id: uid('ref_'), userId: referrer.id, campaignId: c.id, earnedPaise: refEarn, costPaise: 0, isHouseAd: false, isReferralBonus: true, referredUser: userId, ts: Date.now(), ip: '', clicked: false, country: resolvedCountry, surface: 'referral' });
        }
      }
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
      // valid click bills advertiser 50x impression, dev earns 65% of that
      const clickCostPaise = Math.floor(c.bidPaise / 1000) * 50;
      const clickEarnPaise = Math.floor(clickCostPaise * 0.65);
      if (c.spentPaise + clickCostPaise <= c.budgetPaise) {
        c.spentPaise += clickCostPaise;
      }
      // ── FEATURE: multi-creative rotation — track which variant was clicked ──
      const clickedCreativeId = b.creativeId || 'primary';
      if (clickedCreativeId !== 'primary' && Array.isArray(c.creatives)) {
        const cr = c.creatives.find(x => x.id === clickedCreativeId);
        if (cr) cr.clicks = (cr.clicks || 0) + 1;
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
        if (!b.adText || !b.url) return send(res, 400, { error: 'adText and url are required' });

        // adType: 'spotlight' (VS Code spinner, premium) or 'stream' (terminal status line, standard)
        const adType = b.adType === 'stream' ? 'stream' : 'spotlight';
        const geoPricing = getGeoPricing(b.geo?.countries);
        const minBidPaise = adType === 'spotlight' ? geoPricing.spotlight.min : geoPricing.stream.min;
        const minBudgetPaise = adType === 'spotlight' ? geoPricing.minBudgetSpotlight : geoPricing.minBudgetStream;
        const bidPaise = b.bidPaise || minBidPaise;

        if (bidPaise < minBidPaise) {
          return send(res, 400, {
            error: `Minimum bid for ${geoPricing.label} is ${geoPricing.symbol}${(minBidPaise / geoPricing.rate / 100).toFixed(0)} per 1,000 impressions`,
            minBidPaise, currency: geoPricing.currency, symbol: geoPricing.symbol,
          });
        }

        const id = uid('c_');
        db.campaigns[id] = {
          id, advertiserId: user.id, advertiser: user.company || user.name || user.email,
          adText: b.adText, url: b.url, bidPaise,
          adType,
          budgetPaise: b.budgetPaise || minBudgetPaise, spentPaise: 0,
          status: 'pending_payment', createdAt: Date.now(),
          targetingCategory: b.targetingCategory || 'all',
          currency: geoPricing.currency,
          currencySymbol: geoPricing.symbol,
          exchangeRate: geoPricing.rate,
          // Geo-targeting
          geo: {
            countries: b.geo?.countries || ['IN'],           // ISO country codes ['IN','US']
            states: b.geo?.states || [],                      // Indian states ['MH','KA','DL']
            cities: b.geo?.cities || [],                      // ['Mumbai','Bangalore','Delhi']
            excludeCountries: b.geo?.excludeCountries || [],
          },
          // Audience targeting
          targeting: {
            devExperience: b.targeting?.devExperience || 'all', // 'junior','mid','senior','all'
            ideTools: b.targeting?.ideTools || ['vscode'],       // ['vscode','cursor','codex']
            timeOfDay: b.targeting?.timeOfDay || 'all',          // 'morning','evening','all'
            languages: b.targeting?.languages || [],             // ['javascript','python','all']
          },
          // Campaign metadata
          companyName: b.companyName || user.company || '',
          campaignName: b.campaignName || b.adText.slice(0, 40),
          ctaText: b.ctaText || '',
          paymentId: null, orderId: null, paidAt: null, refunded: false,
          // ── Scheduling: optional auto start/stop (ms epoch timestamps) ──
          // If scheduledStartAt is set and in the future, campaign stays 'scheduled'
          // even after payment, and the scheduler flips it to 'active' automatically.
          // If scheduledEndAt passes while active, the scheduler auto-completes it.
          scheduledStartAt: b.scheduledStartAt || null,
          scheduledEndAt: b.scheduledEndAt || null,
          // ── Multi-creative rotation: additional ad text/url variants tested alongside the primary one ──
          // Each variant tracks its own impression/click counts so the advertiser can see which wins.
          creatives: Array.isArray(b.creatives) ? b.creatives.slice(0, 4).map(cr => ({
            id: uid('cr_'), adText: (cr.adText || b.adText).slice(0, 200), url: cr.url || b.url,
            impressions: 0, clicks: 0,
          })) : [],
          // ── Zero-impression alert tracking (avoid re-sending the same alert repeatedly) ──
          zeroImpressionAlertSentAt: null,
          // ── FEATURE: public leaderboard opt-in (Kickbacks.ai-style social proof) ──
          showOnLeaderboard: !!b.showOnLeaderboard,
          brandIconUrl: (b.brandIconUrl || '').slice(0, 500),
          // ── FEATURE: delivery speed preference — priority hint only, does not change price ──
          // 'fast' = deliver ASAP (default), 'medium' = spread over ~6h, 'slow' = spread over ~2 days.
          // Used only to sequence which pending campaign the ad-server favors when multiple
          // campaigns are tied on bid — does not affect billing.
          deliverySpeed: ['slow', 'medium', 'fast'].includes(b.deliverySpeed) ? b.deliverySpeed : 'fast',
        };
        saveDB();
        return send(res, 201, { campaign: db.campaigns[id] });
      }

      // ── PayPal: create order for campaign payment (international advertisers) ──
      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/create-paypal-order$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'campaign not found' });
        if (c.status !== 'pending_payment') return send(res, 400, { error: 'This campaign is not awaiting payment.' });
        if (!paypalEnabled()) return send(res, 503, { error: 'PayPal is not configured on this server yet.' });
        const b = await getBody(req);

        let finalAmountPaise = c.budgetPaise;
        let discountApplied = null;
        if (b.discountCode) {
          const code = b.discountCode.trim().toUpperCase();
          const dc = (db.discountCodes || []).find(d => d.code === code && d.active);
          if (dc && (!dc.expiresAt || Date.now() <= dc.expiresAt) && (!dc.maxUses || dc.usedCount < dc.maxUses)) {
            const discountPaise = Math.floor(c.budgetPaise * dc.discountPct / 100);
            finalAmountPaise = Math.max(100, c.budgetPaise - discountPaise);
            discountApplied = { code: dc.code, discountPct: dc.discountPct, savedPaise: discountPaise };
            c.pendingDiscountCode = dc.code;
          }
        }

        const usd = Math.max(1, finalAmountPaise / 100 * INR_TO_USD).toFixed(2);
        try {
          const token = await paypalToken();
          const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              intent: 'CAPTURE',
              purchase_units: [{
                reference_id: c.id,
                description: `WaitJI AI ad campaign — ${(c.adText || '').slice(0, 60)}`,
                amount: { currency_code: 'USD', value: usd },
              }],
              application_context: {
                brand_name: 'WaitJI AI',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
              },
            }),
          });
          const order = await r.json();
          if (!r.ok) return send(res, 502, { error: 'PayPal order creation failed: ' + JSON.stringify(order).slice(0, 300) });
          c.paypalOrderId = order.id;
          c.finalBudgetPaise = finalAmountPaise;
          c.paypalUsd = usd;
          saveDB();
          return send(res, 200, {
            orderId: order.id,
            amountUsd: usd,
            amountPaise: finalAmountPaise,
            originalAmountPaise: c.budgetPaise,
            discountApplied,
            approveUrl: (order.links || []).find(l => l.rel === 'approve')?.href || null,
          });
        } catch (e) {
          return send(res, 502, { error: 'PayPal error: ' + e.message });
        }
      }

      // ── PayPal: capture order after buyer approval ──
      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/capture-paypal-order$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'campaign not found' });
        if (c.status !== 'pending_payment') return send(res, 400, { error: 'This campaign is not awaiting payment.' });
        const b = await getBody(req);
        if (!b.orderId || b.orderId !== c.paypalOrderId) return send(res, 400, { error: 'Order mismatch' });

        try {
          const token = await paypalToken();
          const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${b.orderId}/capture`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          });
          const cap = await r.json();
          if (!r.ok || cap.status !== 'COMPLETED') {
            return send(res, 402, { error: 'Payment not completed: ' + (cap.status || JSON.stringify(cap).slice(0, 200)) });
          }
          c.status = 'pending_review';
          c.paymentId = cap.id;
          c.paymentRail = 'paypal';
          c.paidAt = Date.now();
          c.paidAmountPaise = c.finalBudgetPaise || c.budgetPaise;
          if (c.pendingDiscountCode) {
            const dc = (db.discountCodes || []).find(d => d.code === c.pendingDiscountCode);
            if (dc) dc.usedCount = (dc.usedCount || 0) + 1;
            c.discountCode = c.pendingDiscountCode;
            delete c.pendingDiscountCode;
          }
          saveDB();
          return send(res, 200, { campaign: c });
        } catch (e) {
          return send(res, 502, { error: 'PayPal capture error: ' + e.message });
        }
      }

      // create a Razorpay order for this campaign's budget (only if unpaid and owned by this advertiser)
      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/create-order$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'campaign not found' });
        if (c.status !== 'pending_payment') return send(res, 400, { error: 'This campaign is not awaiting payment.' });
        const b = await getBody(req);

        // Apply discount code if provided
        let finalAmountPaise = c.budgetPaise;
        let discountApplied = null;
        if (b.discountCode) {
          const code = b.discountCode.trim().toUpperCase();
          const dc = (db.discountCodes || []).find(d => d.code === code && d.active);
          if (dc && (!dc.expiresAt || Date.now() <= dc.expiresAt) && (!dc.maxUses || dc.usedCount < dc.maxUses)) {
            const discountPaise = Math.floor(c.budgetPaise * dc.discountPct / 100);
            finalAmountPaise = Math.max(100, c.budgetPaise - discountPaise); // min ₹1
            discountApplied = { code: dc.code, discountPct: dc.discountPct, savedPaise: discountPaise };
            // Store on campaign so verify-payment can record usage
            c.pendingDiscountCode = dc.code;
          }
        }

        try {
          const order = await razorpayApi('POST', '/orders', {
            amount: finalAmountPaise, currency: 'INR', receipt: c.id,
            notes: { campaignId: c.id, advertiserId: user.id, discountCode: discountApplied?.code || '' }
          });
          c.orderId = order.id;
          c.finalBudgetPaise = finalAmountPaise; // actual charged amount
          saveDB();
          return send(res, 200, {
            orderId: order.id,
            amountPaise: finalAmountPaise,
            originalAmountPaise: c.budgetPaise,
            keyId: RAZORPAY_KEY_ID,
            discountApplied,
          });
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
        c.paidAmountPaise = c.finalBudgetPaise || c.budgetPaise;
        // Mark discount code as used
        if (c.pendingDiscountCode) {
          const dc = (db.discountCodes || []).find(d => d.code === c.pendingDiscountCode);
          if (dc) { dc.usedCount = (dc.usedCount || 0) + 1; }
          c.discountCode = c.pendingDiscountCode;
          delete c.pendingDiscountCode;
        }
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
          const campImps = db.impressions.filter(i => i.campaignId === c.id && !i.isReferralBonus);
          const campClicks = db.clicks.filter(cl => cl.campaignId === c.id && cl.valid);
          return {
            ...c,
            rank: idx >= 0 ? idx + 1 : null,
            totalActive,
            impressions: campImps.length,
            clicks: campClicks.length,
            uniqueUsersReached: new Set(campImps.map(i => i.userId)).size,
            ctr: campImps.length ? (campClicks.length / campImps.length * 100).toFixed(2) : '0.00',
          };
        });
        return send(res, 200, { campaigns: withRank });
      }

      // update advertiser profile (company / name)
      // ── Advertiser: get + update profile ────────────────────────────
      if (method === 'GET' && url === '/v1/advertiser/profile') {
        return send(res, 200, { user: publicUser(user) });
      }
      if (method === 'PATCH' && url === '/v1/advertiser/profile') {
        const b = await getBody(req);
        if (typeof b.company === 'string') user.company = b.company.trim();
        if (typeof b.name === 'string') user.name = b.name.trim();
        saveDB();
        return send(res, 200, { user: publicUser(user) });
      }

      // my analytics — now includes unique developers reached + daily trend
      if (method === 'GET' && url === '/v1/advertiser/analytics') {
        const mine = Object.values(db.campaigns).filter(c => c.advertiserId === user.id);
        const ids = mine.map(c => c.id);
        const idSet = new Set(ids);
        const imps = db.impressions.filter(i => idSet.has(i.campaignId));
        const clk = db.clicks.filter(c => idSet.has(c.campaignId) && c.valid);
        const invalidClk = db.clicks.filter(c => idSet.has(c.campaignId) && !c.valid);
        const totalSpent = mine.reduce((s, c) => s + (c.spentPaise||0), 0);
        const uniqueUsersReached = new Set(imps.map(i => i.userId)).size;
        return send(res, 200, {
          campaigns: mine.length,
          activeCampaigns: mine.filter(c => c.status === 'active').length,
          totalImpressions: imps.length,
          impressions: imps.length,
          totalClicks: clk.length,
          validClicks: clk.length,
          blockedClicks: invalidClk.length,
          ctr: imps.length ? (clk.length / imps.length * 100).toFixed(2) : '0.00',
          totalSpentRupees: (totalSpent / 100).toFixed(2),
          spentRupees: (totalSpent / 100).toFixed(2),
          savedFromFraudRupees: (invalidClk.length * (mine[0]?.bidPaise || 20000) / 1000 * 50 / 100).toFixed(2),
          uniqueUsersReached,
          daily: dailyBreakdown(ids),
        });
      }

      // ── Advertiser: real geo breakdown from impressions ─────────────
      if (method === 'GET' && url === '/v1/advertiser/geo') {
        const mine = Object.values(db.campaigns).filter(c => c.advertiserId === user.id);
        const ids = new Set(mine.map(c => c.id));
        const imps = db.impressions.filter(i => ids.has(i.campaignId) && !i.isReferralBonus);
        const geo = {};
        imps.forEach(i => { const c = i.country||'IN'; geo[c] = (geo[c]||0)+1; });
        const sorted = Object.entries(geo).sort((a,b)=>b[1]-a[1]);
        return send(res, 200, { geo: Object.fromEntries(sorted), total: imps.length });
      }

if (method === 'POST' && url === '/v1/advertiser/reach-estimate') {
        const b = await getBody(req);
        const { geo, adType, targeting } = b;
        const countries = geo?.countries || ['IN'];
        const totalDevs = Object.values(db.users).filter(u => u.role === 'customer').length;
        // Estimate based on actual impression distribution
        const recentImps = db.impressions.filter(i => i.ts > Date.now() - 7 * 864e5);
        const activeDevs = new Set(recentImps.map(i => i.userId)).size;
        const geoMatch = recentImps.filter(i => countries.includes(i.country || 'IN')).length;
        const geoRatio = recentImps.length ? geoMatch / recentImps.length : 0.9;
        const estimatedReach = Math.round(activeDevs * geoRatio);
        const dailyImps = Math.round(recentImps.length / 7);
        const shareOfVoice = db.campaigns && Object.values(db.campaigns).filter(c => c.status === 'active').length;
        return send(res, 200, {
          estimatedDailyReach: estimatedReach,
          estimatedDailyImpressions: Math.round(dailyImps / Math.max(1, shareOfVoice + 1)),
          totalActiveDevelopers: activeDevs,
          totalRegisteredDevelopers: totalDevs,
          geoMatchRatio: (geoRatio * 100).toFixed(0) + '%',
          countries,
          note: 'Estimates based on last 7 days of platform activity.',
        });
      }

      // single-campaign stats for the advertiser who owns it
      if (method === 'GET' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/stats$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'not found' });
        const imps = db.impressions.filter(i => i.campaignId === cid);
        const clk = db.clicks.filter(c2 => c2.campaignId === cid);
        const uniqueUsers = new Set(imps.map(i => i.userId)).size;
        return send(res, 200, {
          campaign: c,
          daily: dailyBreakdown([cid]),
          uniqueUsersReached: uniqueUsers,
          totalImpressions: imps.length,
          validClicks: clk.filter(x => x.valid).length,
          invalidClicks: clk.filter(x => !x.valid).length,
          ctr: imps.length ? (clk.filter(x => x.valid).length / imps.length * 100).toFixed(2) : '0.00',
        });
      }

      // ── FEATURE: add a creative variant to an already-running campaign ──
      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/creatives$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'not found' });
        c.creatives = c.creatives || [];
        if (c.creatives.length >= 4) return send(res, 400, { error: 'Maximum 4 additional creative variants per campaign (plus the primary).' });
        const b = await getBody(req);
        if (!b.adText) return send(res, 400, { error: 'adText is required' });
        const creative = { id: uid('cr_'), adText: b.adText.slice(0, 200), url: b.url || c.url, impressions: 0, clicks: 0 };
        c.creatives.push(creative);
        saveDB();
        return send(res, 201, { creative, creatives: c.creatives });
      }

      // ── FEATURE: per-creative performance breakdown (which A/B variant wins) ──
      if (method === 'GET' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/creatives$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'not found' });

        const namedCreatives = c.creatives || [];
        const namedImpressions = namedCreatives.reduce((s, cr) => s + (cr.impressions || 0), 0);
        const namedClicks = namedCreatives.reduce((s, cr) => s + (cr.clicks || 0), 0);
        const totalImpressions = db.impressions.filter(i => i.campaignId === cid).length;
        const totalClicks = db.clicks.filter(x => x.campaignId === cid && x.valid).length;

        const rows = [
          {
            id: 'primary', adText: c.adText, url: c.url,
            impressions: Math.max(0, totalImpressions - namedImpressions),
            clicks: Math.max(0, totalClicks - namedClicks),
          },
          ...namedCreatives.map(cr => ({ id: cr.id, adText: cr.adText, url: cr.url, impressions: cr.impressions || 0, clicks: cr.clicks || 0 })),
        ].map(r => ({ ...r, ctr: r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(2) : '0.00' }));

        return send(res, 200, { creatives: rows });
      }

      // pause / resume own campaign — only active→paused or paused→active allowed
      if (method === 'PATCH' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+$/)) {
        const cid = url.split('/').pop();
        const c = db.campaigns[cid];
        if (!c || c.advertiserId !== user.id) return send(res, 404, { error: 'Campaign not found' });
        const b = await getBody(req);
        const newStatus = b.status;
        if (newStatus === 'paused' && c.status === 'active') {
          c.status = 'paused'; saveDB();
          return send(res, 200, { campaign: c });
        }
        if (newStatus === 'active' && c.status === 'paused') {
          c.status = 'active'; saveDB();
          return send(res, 200, { campaign: c });
        }
        return send(res, 400, {
          error: `Cannot set status to "${newStatus}" from "${c.status}". Only active↔paused toggle is allowed here.`
        });
      }

      // ── Advertiser: GST invoice (self-serve) ─────────────────────────
      if (method === 'GET' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/invoice$/)) {
        const campId = url.split('/')[4];
        const camp = db.campaigns[campId];
        if (!camp || camp.advertiserId !== user.id) return send(res, 404, { error: 'Not found' });
        const spentRs = (camp.spentPaise || 0) / 100;
        const isGstRegistered = !!QIVALABS_GSTIN;
        const gst = isGstRegistered ? spentRs * 0.18 : 0;
        return send(res, 200, {
          invoice: {
            invoiceNo: 'WAITJI-' + campId.slice(-8).toUpperCase(),
            date: new Date().toISOString().slice(0, 10),
            seller: { name: 'QivaLabs LLP', address: 'Udaipur, Rajasthan, India', gstin: isGstRegistered ? QIVALABS_GSTIN : 'Not GST registered', pan: 'AABFQ4385M' },
            buyer: { name: user.company || user.name, email: user.email },
            subtotal: spentRs, gst, total: spentRs + gst,
            cgst: isGstRegistered ? gst/2 : 0, sgst: isGstRegistered ? gst/2 : 0,
            gstApplicable: isGstRegistered,
            items: [{ desc: 'Ad campaign: ' + (camp.campaignName || camp.adText || '').slice(0,40), amount: spentRs }],
            campaign: { id: campId, name: camp.campaignName || camp.adText, impressions: camp.impressions || 0 },
          },
        });
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
        const totalImpPaise = imps.reduce((s, i) => s + (i.earnedPaise||0), 0);
        const totalClickPaise = clk.length * 100; // simplified
        const paidOut = db.payouts.filter(p => p.userId === user.id && p.status === 'paid')
          .reduce((s, p) => s + p.amountPaise, 0);
        const total = totalImpPaise + totalClickPaise;
        // today
        const dayCut = Date.now() - 864e5;
        const todayPaise = imps.filter(i => i.ts > dayCut).reduce((s, i) => s + (i.earnedPaise||0), 0);
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

      // ── Customer: 14-day daily earnings breakdown ────────────────────
      if (method === 'GET' && url === '/v1/customer/daily') {
        const dayMs = 864e5;
        const now = Date.now();
        const imps = db.impressions.filter(i => i.userId === user.id);
        const clks = db.clicks.filter(c => c.userId === user.id && c.valid);
        const days = [];
        for (let i = 13; i >= 0; i--) {
          const dayStart = new Date(now - i * dayMs); dayStart.setHours(0,0,0,0);
          const dayEnd = new Date(dayStart); dayEnd.setHours(23,59,59,999);
          const dayImps = imps.filter(imp => imp.ts >= dayStart.getTime() && imp.ts <= dayEnd.getTime());
          const dayClks = clks.filter(cl => cl.ts >= dayStart.getTime() && cl.ts <= dayEnd.getTime());
          days.push({
            date: dayStart.toISOString().slice(0,10),
            label: dayStart.toLocaleDateString('en-IN',{month:'short',day:'numeric'}),
            impressions: dayImps.length,
            clicks: dayClks.length,
            earnedPaise: dayImps.reduce((s,i) => s+(i.earnedPaise||0), 0),
          });
        }
        return send(res, 200, { daily: days });
      }

      // ── Customer: streak & stickiness stats ─────────────────────────
      if (method === 'GET' && url === '/v1/customer/streak') {
        const dayMs = 864e5;
        const imps = db.impressions.filter(i => i.userId === user.id);
        if (!imps.length) return send(res, 200, { currentStreak:0, longestStreak:0, activeDays:0, totalDays:0 });
        const activeDaySet = new Set(imps.map(i => new Date(i.ts).toISOString().slice(0,10)));
        const activeDays = [...activeDaySet].sort();
        let currentStreak = 0, longestStreak = 0, streak = 1;
        for (let i = 1; i < activeDays.length; i++) {
          const diff = (new Date(activeDays[i]) - new Date(activeDays[i-1])) / dayMs;
          if (diff === 1) { streak++; } else { longestStreak = Math.max(longestStreak, streak); streak = 1; }
        }
        longestStreak = Math.max(longestStreak, streak);
        // Current streak — check if today or yesterday active
        const today = new Date().toISOString().slice(0,10);
        const yesterday = new Date(Date.now()-dayMs).toISOString().slice(0,10);
        if (activeDaySet.has(today) || activeDaySet.has(yesterday)) {
          currentStreak = 1;
          let d = new Date(activeDaySet.has(today)?today:yesterday);
          while (true) {
            d = new Date(d - dayMs);
            if (activeDaySet.has(d.toISOString().slice(0,10))) currentStreak++; else break;
          }
        }
        return send(res, 200, { currentStreak, longestStreak, activeDays: activeDaySet.size, totalDays: Math.ceil((Date.now()-imps[imps.length-1].ts)/dayMs) });
      }

      // ── Customer: referral stats ─────────────────────────────────────
      if (method === 'GET' && url === '/v1/customer/referrals') {
        const referred = Object.values(db.users).filter(u => u.referredBy === user.id);
        const referralEarnings = referred.reduce((s, u) => {
          const uImps = db.impressions.filter(i => i.userId === u.id);
          return s + Math.floor(uImps.reduce((s2,i) => s2+(i.earnedPaise||0), 0) * 0.10);
        }, 0);
        return send(res, 200, {
          referrals: referred.length,
          referralEarningsPaise: referralEarnings,
          referralLink: `https://www.waitjiai.in?ref=${user.id}`,
          referred: referred.map(u => ({ email: u.email.replace(/(.{2}).*(@.*)/, '$1***$2'), joinedAt: u.createdAt })),
        });
      }

      // ── Customer: geo stats (where their ads were shown) ─────────────
      if (method === 'GET' && url === '/v1/customer/geo') {
        const imps = db.impressions.filter(i => i.userId === user.id);
        const geoCounts = {};
        imps.forEach(i => { const c = i.country||'IN'; geoCounts[c] = (geoCounts[c]||0)+1; });
        const surfaceCounts = {};
        imps.forEach(i => { const s = i.surface||'terminal'; surfaceCounts[s] = (surfaceCounts[s]||0)+1; });
        return send(res, 200, { geo: geoCounts, surfaces: surfaceCounts, total: imps.length });
      }

      // ── Customer: referral credit on signup ─────────────────────────
      // (handled in signup — credits referrer 10% of each impression)

if (method === 'GET' && url === '/v1/customer/health') {
        const imps = db.impressions.filter(i => i.userId === user.id);
        const lastImp = imps.length ? Math.max(...imps.map(i => i.ts)) : null;
        const hourAgo = Date.now() - 3600000;
        return send(res, 200, {
          connected: !!lastImp,
          activeLastHour: lastImp && lastImp > hourAgo,
          lastImpressionAt: lastImp,
          lastImpressionAgo: lastImp ? Math.round((Date.now() - lastImp) / 60000) + ' min ago' : null,
          status: lastImp && lastImp > hourAgo ? 'active' : lastImp ? 'idle' : 'not_connected',
          message: lastImp && lastImp > hourAgo
            ? 'Extension is active and earning'
            : lastImp
            ? 'Extension connected but idle — open Claude Code to earn'
            : 'Extension not yet connected — paste your User ID in VS Code',
        });
      }

if (method === 'GET' && url === '/v1/customer/projection') {
        const imps = db.impressions.filter(i => i.userId === user.id);
        const sevenDaysAgo = Date.now() - 7 * 864e5;
        const last7Imps = imps.filter(i => i.ts > sevenDaysAgo);
        const last7Earned = last7Imps.reduce((s, i) => s + (i.earnedPaise || 0), 0);
        const dailyAvg = last7Earned / 7;
        const monthlyProjection = dailyAvg * 30;
        const totalEarned = imps.reduce((s, i) => s + (i.earnedPaise || 0), 0);
        return send(res, 200, {
          dailyAvgPaise: Math.round(dailyAvg),
          weeklyPaise: last7Earned,
          monthlyProjectionPaise: Math.round(monthlyProjection),
          totalEarnedPaise: totalEarned,
          last7Days: last7Imps.length,
          message: monthlyProjection > 0
            ? `At your current pace, you'll earn ₹${(monthlyProjection / 100).toFixed(0)} this month`
            : 'Start using Claude Code to see your earnings projection',
        });
      }

      // ── Recent activity (real-time feed) ──────────────────────────
      if (method === 'GET' && url === '/v1/customer/activity') {
        const imps = db.impressions.filter(i => i.userId === user.id)
          .slice(-30).reverse()
          .map(i => ({ type: 'impression', campaignId: i.campaignId, earnedPaise: (i.earnedPaise||0), ts: i.ts, advertiser: db.campaigns[i.campaignId]?.advertiser || 'WaitJI AI' }));
        return send(res, 200, { activity: imps });
      }

      // ── Profile status — what's complete, what's missing ──
      if (method === 'GET' && url === '/v1/customer/profile-status') {
        const ps = profileStatus(user);
        return send(res, 200, { ...ps, user: publicUser(user) });
      }

      // ── Update profile (name, phone) ──
      if (method === 'PATCH' && url === '/v1/customer/profile') {
        const b = await getBody(req);
        if (b.name !== undefined) user.name = b.name.trim();
        if (b.phone !== undefined) {
          const ph = b.phone.trim().replace(/\D/g, '');
          if (ph && !/^[6-9]\d{9}$/.test(ph)) return send(res, 400, { error: 'Phone must be a valid 10-digit Indian mobile number' });
          user.phone = ph;
        }
        saveDB();
        const ps = profileStatus(user);
        return send(res, 200, { user: publicUser(user), profileStatus: ps });
      }

      // ── IFSC Verify (free, uses Cashfree free IFSC API) ──
      if (method === 'GET' && url.startsWith('/v1/customer/verify-ifsc/')) {
        const ifsc = url.split('/').pop().toUpperCase();
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return send(res, 400, { error: 'Invalid IFSC format (e.g. SBIN0001234)' });
        try {
          // Cashfree free IFSC lookup
          const r = await fetch(`https://ifsc.razorpay.com/${ifsc}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) return send(res, 404, { valid: false, error: 'IFSC not found — please check and re-enter' });
          const d = await r.json();
          return send(res, 200, { valid: true, ifsc, bank: d.BANK, branch: d.BRANCH, city: d.CITY, state: d.STATE });
        } catch (e) {
          return send(res, 502, { error: 'Could not verify IFSC right now — try again' });
        }
      }

      // ── UPI Verify via Cashfree (real VPA validation) ──
      if (method === 'POST' && url === '/v1/customer/verify-upi') {
        const b = await getBody(req);
        const upiId = (b.upiId || '').trim();
        if (!upiId) return send(res, 400, { error: 'UPI ID is required' });

        // Format validation first — this is always run
        const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
        if (!upiRegex.test(upiId)) {
          return send(res, 400, { valid: false, error: 'Invalid format. Example: name@upi or 9876543210@okaxis' });
        }

        let nameAtBank = '';
        let liveVerified = false;

        // Try Cashfree live check — but NEVER block the user if it fails
        if (CASHFREE_CLIENT_ID && CASHFREE_CLIENT_SECRET) {
          try {
            const { data } = await cashfreeApi('POST', '/payout/v2/vpa/validate', { vpa: upiId });
            const inner = data?.data || data || {};
            liveVerified = inner.valid === true || inner.status === 'VALID' || inner.vpa_valid === true || inner.registered === true;
            nameAtBank = inner.name_at_bank || inner.name || inner.payee_name || '';
          } catch (e) {
            // Cashfree error — proceed with format-only, don't block user
          }
        }

        // Always save if format is valid — Cashfree live check is best-effort only
        user.upiId = upiId;
        user.upiNameAtBank = nameAtBank;
        user.payoutMode = 'upi';
        user.bankAccount = null;
        user.payoutVerified = true;
        user.upiLiveVerified = liveVerified;
        saveDB();

        const ps = profileStatus(user);
        const message = nameAtBank
          ? `✓ Verified — account: ${nameAtBank}`
          : liveVerified
          ? '✓ UPI ID verified and saved'
          : '✓ UPI ID saved (format valid — live bank check unavailable right now)';

        return send(res, 200, {
          valid: true, upiId, nameAtBank, liveVerified,
          message, user: publicUser(user), profileStatus: ps,
        });
      }

      // ── Bank account verify (save + mark verified) ──
      if (method === 'POST' && url === '/v1/customer/verify-bank') {
        const b = await getBody(req);
        const { accountNumber, ifsc, accountHolder } = b;
        if (!accountNumber || !ifsc || !accountHolder) return send(res, 400, { error: 'accountNumber, ifsc, and accountHolder are required' });
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase())) return send(res, 400, { error: 'Invalid IFSC format' });
        // Save bank details — Cashfree penny drop is async/webhook-based, handled separately
        user.bankAccount = { accountNumber: encrypt(accountNumber), ifsc: ifsc.toUpperCase(), accountHolder: accountHolder.trim(), addedAt: Date.now() };
        user.payoutMode = 'bank';
        user.bankVerified = true;
        user.upiId = null;
        user.upiVerified = false;
        user.payoutVerified = true;
        saveDB();
        const ps = profileStatus(user);
        return send(res, 200, { success: true, message: 'Bank account saved', profileStatus: ps });
      }

      // ── PayPal payout setup (international developers) ──
      if (method === 'POST' && url === '/v1/customer/verify-paypal') {
        const b = await getBody(req);
        const email = (b.paypalEmail || '').trim().toLowerCase();
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return send(res, 400, { error: 'Enter a valid PayPal email address' });
        }
        user.paypalEmail = email;
        user.payoutMode = 'paypal';
        user.paypalVerified = true;
        user.payoutVerified = true;
        user.upiId = null;
        user.upiVerified = false;
        user.bankAccount = null;
        user.bankVerified = false;
        saveDB();
        return send(res, 200, {
          success: true,
          message: '✓ PayPal email saved — payouts will be sent in USD',
          paypalEmail: email,
          note: `Payouts convert at ~₹${(1/INR_TO_USD).toFixed(0)}/USD. Minimum withdrawal ₹850 (~$10) for PayPal.`,
          user: publicUser(user),
          profileStatus: profileStatus(user),
        });
      }

      // ── Save verified UPI to profile ──
      if (method === 'POST' && url === '/v1/customer/save-upi') {
        const b = await getBody(req);
        const upiId = (b.upiId || '').trim();
        if (!upiId) return send(res, 400, { error: 'UPI ID required' });
        user.upiId = upiId;
        user.payoutMode = 'upi';
        user.bankAccount = null;
        user.payoutVerified = true;
        saveDB();
        const ps = profileStatus(user);
        return send(res, 200, { success: true, user: publicUser(user), profileStatus: ps });
      }

      // request withdrawal — BLOCKED if profile incomplete
      if (method === 'POST' && url === '/v1/customer/request-withdrawal') {
        // Profile must be 100% complete before withdrawal
        const ps = profileStatus(user);
        if (!ps.complete) {
          return send(res, 400, {
            error: 'Complete your profile before requesting a withdrawal.',
            missing: ps.missing,
            profileIncomplete: true,
          });
        }
        if (!user.upiId && !user.bankAccount) return send(res, 400, { error: 'Add a verified UPI ID or bank account before withdrawing.' });

        const available = computeAvailableBalance(user.id);

        const minPaise = user.payoutMode === 'paypal' ? 85000 : 10000; // ₹850 for PayPal (~$10), ₹100 for UPI/bank
        if (available < minPaise) return send(res, 400, { error: `Minimum withdrawal is ₹${(minPaise/100).toFixed(0)}${user.payoutMode === 'paypal' ? ' (~$10) for PayPal payouts' : ''}. Your available balance is ₹${(available/100).toFixed(2)}.` });

        // Block if a pending request already exists
        const hasPending = db.withdrawalRequests.some(r => r.userId === user.id && r.status === 'pending');
        if (hasPending) return send(res, 400, { error: 'You already have a pending withdrawal request. Please wait for admin to review it before submitting a new one.' });

        const req2 = {
          id: uid('wr_'),
          userId: user.id,
          userName: user.name || user.email,
          userEmail: user.email,
          upiId: user.upiId,
          amountPaise: available,
          status: 'pending',
          requestedAt: Date.now(),
          reviewedAt: null,
          reviewNote: null,
        };
        db.withdrawalRequests.push(req2);
        saveDB();

        // Email admin about the new withdrawal request
        if (RESEND_API_KEY) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: LAUNCH_EMAIL_FROM,
              to: ['admin@waitjiai.in'],
              subject: `💸 Withdrawal request — ₹${(available/100).toFixed(2)} from ${user.name||user.email}`,
              html: `<p><b>New withdrawal request on WaitJI AI</b></p>
                <table style="border-collapse:collapse;font-size:14px">
                  <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Developer</td><td><b>${user.name||'—'}</b> (${user.email})</td></tr>
                  <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Amount</td><td><b>₹${(available/100).toFixed(2)}</b></td></tr>
                  <tr><td style="padding:6px 12px 6px 0;color:#6B7185">UPI ID</td><td><b>${user.upiId}</b></td></tr>
                  <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Request ID</td><td><code>${req2.id}</code></td></tr>
                  <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Requested at</td><td>${new Date().toLocaleString('en-IN')}</td></tr>
                </table>
                <p style="margin-top:16px"><a href="https://waitjiai.in/admin-login.html" style="background:#4F46E5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Review in Admin Panel →</a></p>`,
            }),
          }).catch(() => { /* email failure never blocks the request */ });
        }

        return send(res, 201, { request: req2, message: 'Withdrawal request submitted. Admin will review within 1–2 business days.' });
      }

      // get my withdrawal requests (history)
      if (method === 'GET' && url === '/v1/customer/withdrawals') {
        const mine = db.withdrawalRequests
          .filter(r => r.userId === user.id)
          .sort((a, b) => b.requestedAt - a.requestedAt);
        return send(res, 200, { withdrawals: mine });
      }

      // ── FEATURE: auto-payout toggle ──
      // When enabled, the daily runAutoPayoutSweep() will automatically request AND
      // approve a withdrawal once the earner's balance clears the minimum — no manual click needed.
      if (method === 'POST' && url === '/v1/customer/auto-payout') {
        const b = await getBody(req);
        user.autoPayoutEnabled = !!b.enabled;
        saveDB();
        return send(res, 200, {
          autoPayoutEnabled: user.autoPayoutEnabled,
          message: user.autoPayoutEnabled
            ? 'Auto-payout enabled. Once your balance clears the minimum, a withdrawal will be requested and paid automatically.'
            : 'Auto-payout disabled. You will need to request withdrawals manually.',
        });
      }
      if (method === 'GET' && url === '/v1/customer/auto-payout') {
        return send(res, 200, { autoPayoutEnabled: !!user.autoPayoutEnabled });
      }

      // ── FEATURE: dispute a fraud flag ──
      // A genuine earner who got flagged (e.g. a shared office IP triggering
      // ip_abuse, or a fast connection triggering impression_velocity) can now
      // explain themselves instead of having no recourse at all.
      if (method === 'POST' && url === '/v1/customer/dispute-flag') {
        const b = await getBody(req);
        if (!b.flagId || !b.message) return send(res, 400, { error: 'flagId and message are required' });
        const flag = db.fraudFlags.find(f => f.id === b.flagId && f.userId === user.id);
        if (!flag) return send(res, 404, { error: 'Fraud flag not found for your account' });
        const already = db.disputes.find(d => d.flagId === b.flagId && d.status === 'pending');
        if (already) return send(res, 400, { error: 'You already have a pending dispute for this flag.' });

        const dispute = {
          id: uid('disp_'), userId: user.id, flagId: b.flagId, message: b.message.slice(0, 1000),
          status: 'pending', createdAt: Date.now(), resolvedAt: null, adminNote: null,
        };
        db.disputes.push(dispute);
        saveDB();

        if (RESEND_API_KEY) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: LAUNCH_EMAIL_FROM, to: ['admin@waitjiai.in'],
              subject: `🚩 New fraud-flag dispute from ${user.name || user.email}`,
              html: `<p><b>Dispute filed</b></p><p>User: ${user.name||user.email}</p><p>Flag type: ${flag.type}</p><p>Their explanation: ${dispute.message}</p>`,
            }),
          }).catch(() => {});
        }
        return send(res, 201, { dispute, message: 'Dispute submitted. Admin will review within 1–2 business days.' });
      }
      if (method === 'GET' && url === '/v1/customer/disputes') {
        const mine = db.disputes.filter(d => d.userId === user.id).sort((a,b) => b.createdAt - a.createdAt);
        return send(res, 200, { disputes: mine });
      }

      // update UPI — already handled above but keeping for backward compat (legacy path)
      if (method === 'POST' && url === '/v1/customer/payout') {
        return send(res, 410, { error: 'This endpoint is deprecated. Use POST /v1/customer/request-withdrawal instead.' });
      }

    } // end customer block

    // ── Public pricing by country ──
    if (method === 'GET' && url.startsWith('/v1/public/pricing')) {
      const country = new URL('http://x'+url).searchParams.get('country') || 'IN';
      const pricing = GEO_PRICING[country] || GEO_PRICING['IN'];
      return send(res, 200, {
        country,
        currency: pricing.currency,
        symbol: pricing.symbol,
        spotlight: {
          minPaise: pricing.spotlight.min,
          recommendedPaise: pricing.spotlight.recommended,
          minDisplay: (pricing.spotlight.min / pricing.rate / 100).toFixed(0),
          recommendedDisplay: (pricing.spotlight.recommended / pricing.rate / 100).toFixed(0),
          minBudgetPaise: pricing.minBudgetSpotlight,
          minBudgetDisplay: (pricing.minBudgetSpotlight / pricing.rate / 100).toFixed(0),
        },
        stream: {
          minPaise: pricing.stream.min,
          recommendedPaise: pricing.stream.recommended,
          minDisplay: (pricing.stream.min / pricing.rate / 100).toFixed(0),
          recommendedDisplay: (pricing.stream.recommended / pricing.rate / 100).toFixed(0),
          minBudgetPaise: pricing.minBudgetStream,
          minBudgetDisplay: (pricing.minBudgetStream / pricing.rate / 100).toFixed(0),
        },
        note: `Prices shown in ${pricing.currency}. Charged in INR at current exchange rate (~${pricing.rate/100} ${pricing.currency}/INR).`,
        allCountries: Object.entries(GEO_PRICING).map(([code, p]) => ({
          code, label: p.label, currency: p.currency, symbol: p.symbol,
          spotlightMinDisplay: (p.spotlight.min / p.rate / 100).toFixed(0),
          streamMinDisplay: (p.stream.min / p.rate / 100).toFixed(0),
        })),
      });
    }

    // ── Validate discount code (public) ──

    if (method === 'POST' && url === '/v1/discount/validate') {
      const b = await getBody(req);
      const code = (b.code || '').trim().toUpperCase();
      if (!code) return send(res, 400, { error: 'Code is required' });
      const dc = (db.discountCodes || []).find(d => d.code === code && d.active);
      if (!dc) return send(res, 404, { error: 'Invalid or expired discount code' });
      if (dc.expiresAt && Date.now() > dc.expiresAt) return send(res, 400, { error: 'This discount code has expired' });
      if (dc.maxUses && dc.usedCount >= dc.maxUses) return send(res, 400, { error: 'This discount code has reached its usage limit' });
      return send(res, 200, {
        valid: true,
        code: dc.code,
        discountPct: dc.discountPct,
        description: dc.description || `${dc.discountPct}% off your campaign budget`,
      });
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
        const totalSpent = Object.values(db.campaigns).reduce((s, c) => s + (c.spentPaise||0), 0);
        const validClicks = db.clicks.filter(c => c.valid).length;
        const blockedClicks = db.clicks.filter(c => !c.valid).length;
        const sevenDaysAgo = Date.now() - 7 * 864e5;
        const dayAgo = Date.now() - 864e5;
        const activeUsers = users.filter(u => u.lastActiveAt && u.lastActiveAt > sevenDaysAgo && u.role !== 'admin').length;
        const totalEarnedPaise = db.impressions.reduce((s, i) => s + (i.earnedPaise||0), 0);
        const platformRevPaise = db.impressions.reduce((s, i) => s + (i.costPaise||0) - (i.earnedPaise||0), 0);
        const pendingWds = (db.withdrawalRequests||[]).filter(w => w.status==='pending');
        const spotImps = db.impressions.filter(i => db.campaigns[i.campaignId]?.adType==='spotlight').length;
        const streamImps = db.impressions.filter(i => db.campaigns[i.campaignId]?.adType==='stream').length;
        const extStats = await getExtensionStats();
        const fraudFlagsToday = db.fraudFlags.filter(f => f.ts > dayAgo).length;
        const geoBreakdown = {};
        db.impressions.forEach(i => { const c = i.country||'IN'; geoBreakdown[c] = (geoBreakdown[c]||0)+1; });
        const surfaceBreakdown = {};
        db.impressions.forEach(i => { const s = i.surface||'terminal'; surfaceBreakdown[s] = (surfaceBreakdown[s]||0)+1; });
        return send(res, 200, {
          summary: {
            totalImpressions: db.impressions.length,
            totalClicks: validClicks,
            blockedClicks,
            totalEarnedPaise,
            platformRevenuePaise: platformRevPaise,
            totalAdvertisers: advertisers.length,
            activeAdvertisers: advertisers.filter(u => Object.values(db.campaigns).some(c => c.advertiserId===u.id && c.status==='active')).length,
            totalEarners: customers.length,
            activeEarners: customers.filter(u => u.lastActiveAt && u.lastActiveAt > dayAgo).length,
            activeCampaigns: Object.values(db.campaigns).filter(c => c.status==='active').length,
            pendingReviewCampaigns: Object.values(db.campaigns).filter(c => c.status==='pending_review').length,
            pendingWithdrawals: pendingWds.length,
            pendingWithdrawalPaise: pendingWds.reduce((s,w) => s+(w.amountPaise||0), 0),
            fraudFlagsToday,
            fraudFlagsTotal: db.fraudFlags.length,
            uniqueDevelopers: new Set(db.impressions.map(i=>i.userId)).size,
            spotlightImpressions: spotImps,
            streamImpressions: streamImps,
            extensionInstalls: extStats.installCount,
          },
          geoBreakdown,
          surfaceBreakdown,
          // backward compat
          advertisers: advertisers.length,
          customers: customers.length,
          campaigns: Object.keys(db.campaigns).length,
          activeCampaigns: Object.values(db.campaigns).filter(c => c.status==='active').length,
          impressions: db.impressions.length,
          validClicks, blockedClicks,
          fraudFlags: db.fraudFlags.length,
          platformRevenueRupees: (platformRevPaise/100).toFixed(2),
          payoutsOwedRupees: (totalEarnedPaise/100).toFixed(2),
        });
      }

      // all advertisers
      // list all withdrawal requests (newest first), with optional ?status= filter
      if (method === 'GET' && url.startsWith('/v1/admin/withdrawals')) {
        const params = new URL('http://x'+url).searchParams;
        const statusFilter = params.get('status');
        let reqs = [...db.withdrawalRequests].sort((a, b) => b.requestedAt - a.requestedAt);
        if (statusFilter) reqs = reqs.filter(r => r.status === statusFilter);
        const enriched = reqs.map(r => ({
          ...r,
          userName: db.users[r.userId]?.name || '—',
          userEmail: db.users[r.userId]?.email || r.userEmail,
        }));
        const summary = {
          pending: db.withdrawalRequests.filter(r => r.status === 'pending').length,
          approved: db.withdrawalRequests.filter(r => r.status === 'approved').length,
          paid: db.withdrawalRequests.filter(r => r.status === 'paid').length,
          rejected: db.withdrawalRequests.filter(r => r.status === 'rejected').length,
          totalPendingPaise: db.withdrawalRequests.filter(r => r.status === 'pending').reduce((s, r) => s + r.amountPaise, 0),
        };
        return send(res, 200, { withdrawals: enriched, summary });
      }

      // approve a withdrawal request — auto-pays via Cashfree if configured
      if (method === 'POST' && url.match(/^\/v1\/admin\/withdrawals\/[^/]+\/approve$/)) {
        if (!requireScope(user, ['finance'], res)) return;
        const wid = url.split('/')[4];
        const wr = db.withdrawalRequests.find(r => r.id === wid);
        if (!wr) return send(res, 404, { error: 'Withdrawal request not found' });
        if (wr.status !== 'pending') return send(res, 400, { error: `Cannot approve — status is "${wr.status}"` });
        const b = await getBody(req);
        const result = await approveOneWithdrawal(wr, user.id, b.note || null);
        return send(res, 200, {
          withdrawal: wr,
          autoPaid: result.autoPaid,
          cashfreeTransferId: result.cashfreeTransferId,
          cashfreeError: result.cashfreeError,
          message: result.autoPaid ? 'Approved and auto-paid via Cashfree.' : result.cashfreeError ? `Approved (Cashfree error: ${result.cashfreeError} — please pay manually).` : 'Approved — Cashfree not configured, pay manually.',
        });
      }

      // approve ALL pending withdrawal requests for one user in a single click (admin.html "approve all for user" button)
      // Was previously dead — frontend called this but no handler existed, so the button silently did nothing.
      if (method === 'POST' && url === '/v1/admin/withdrawals/approve-all-for-user') {
        if (!requireScope(user, ['finance'], res)) return;
        const b = await getBody(req);
        if (!b.userId) return send(res, 400, { error: 'userId is required' });
        const pending = db.withdrawalRequests.filter(r => r.userId === b.userId && r.status === 'pending');
        if (pending.length === 0) return send(res, 200, { success: true, approved: 0, message: 'No pending withdrawals for this user.' });

        const results = [];
        for (const wr of pending) {
          const r = await approveOneWithdrawal(wr, user.id, b.note || null);
          results.push({ id: wr.id, amountPaise: wr.amountPaise, autoPaid: r.autoPaid, cashfreeError: r.cashfreeError });
        }
        const paidCount = results.filter(r => r.autoPaid).length;
        return send(res, 200, {
          success: true,
          approved: results.length,
          autoPaidCount: paidCount,
          results,
          message: `Approved ${results.length} withdrawal(s), ${paidCount} auto-paid.`,
        });
      }

      // reject a withdrawal request — requires a reason, sends email to earner explaining why
      if (method === 'POST' && url.match(/^\/v1\/admin\/withdrawals\/[^/]+\/reject$/)) {
        if (!requireScope(user, ['finance'], res)) return;
        const wid = url.split('/')[4];
        const wr = db.withdrawalRequests.find(r => r.id === wid);
        if (!wr) return send(res, 404, { error: 'Withdrawal request not found' });
        if (wr.status !== 'pending') return send(res, 400, { error: `Cannot reject — status is "${wr.status}"` });
        const b = await getBody(req);
        if (!b.reason) return send(res, 400, { error: 'Please provide a reason for rejection.' });
        wr.status = 'rejected';
        wr.reviewedAt = Date.now();
        wr.reviewNote = b.reason;
        saveDB();

        // Notify earner by email
        if (RESEND_API_KEY && db.users[wr.userId]?.email) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: LAUNCH_EMAIL_FROM,
              to: [db.users[wr.userId].email],
              subject: `❌ Withdrawal request of ₹${(wr.amountPaise/100).toFixed(2)} — action required`,
              html: `<p>Hi ${db.users[wr.userId].name||'there'},</p>
                <p>Your withdrawal request has been <b>rejected</b> for the following reason:</p>
                <blockquote style="border-left:3px solid #EF4444;padding:10px 16px;margin:16px 0;background:#FEE2E2;border-radius:0 8px 8px 0">${b.reason}</blockquote>
                <p>Your earnings balance has <b>not</b> been affected — you can resubmit once the issue is resolved.</p>
                <p>If you have questions, reply to this email or contact admin@waitjiai.in with request ID <code>${wr.id}</code>.</p>
                <p>— WaitJI AI Team</p>`,
            }),
          }).catch(() => {});
        }
        return send(res, 200, { withdrawal: wr, message: 'Rejected and earner notified with reason.' });
      }

      // advertiser detail profile
      if (method === 'GET' && url.match(/^\/v1\/admin\/advertisers\/[^/]+$/)) {
        const aid = url.split('/').pop();
        const target = db.users[aid];
        if (!target || target.role !== 'advertiser') return send(res, 404, { error: 'not found' });
        const camps = Object.values(db.campaigns).filter(c => c.advertiserId === aid);
        const allImps = db.impressions.filter(i => camps.some(c => c.id === i.campaignId));
        const allClks = db.clicks.filter(c => camps.some(camp => camp.id === c.campaignId) && c.valid);
        return send(res, 200, {
          user: publicUser(target),
          stats: {
            totalCampaigns: camps.length,
            activeCampaigns: camps.filter(c => c.status === 'active').length,
            totalSpentRupees: (camps.reduce((s, c) => s + c.spentPaise, 0) / 100).toFixed(2),
            totalImpressions: allImps.length,
            totalClicks: allClks.length,
            ctr: allImps.length ? (allClks.length / allImps.length * 100).toFixed(2) : '0.00',
          },
          campaigns: camps.map(c => ({
            id: c.id, adText: c.adText, adType: c.adType || 'spotlight',
            status: c.status, bidPaise: c.bidPaise,
            spentRupees: (c.spentPaise / 100).toFixed(2),
            budgetRupees: (c.budgetPaise / 100).toFixed(2),
            discountCode: c.discountCode || null,
            createdAt: c.createdAt,
          })),
        });
      }

      if (method === 'GET' && url === '/v1/admin/advertisers') {
        const advs = Object.values(db.users).filter(u => u.role === 'advertiser').map(u => {
          const camps = Object.values(db.campaigns).filter(c => c.advertiserId === u.id);
          const totalImps = camps.reduce((s,c) => s + db.impressions.filter(i => i.campaignId===c.id).length, 0);
          const totalClicks = camps.reduce((s,c) => s + db.clicks.filter(cl => cl.campaignId===c.id && cl.valid).length, 0);
          return {
            ...publicUser(u),
            company: u.company, industry: u.industry, website: u.website,
            totalCampaigns: camps.length,
            activeCampaigns: camps.filter(c=>c.status==='active').length,
            totalSpentPaise: camps.reduce((s,c) => s+(c.spentPaise||0), 0),
            totalImpressions: totalImps,
            totalClicks,
            ctr: totalImps ? (totalClicks/totalImps*100).toFixed(2) : '0.00',
            campaigns: camps.map(c=>({...c, impressions: db.impressions.filter(i=>i.campaignId===c.id).length, clicks: db.clicks.filter(cl=>cl.campaignId===c.id&&cl.valid).length})),
          };
        });
        return send(res, 200, { advertisers: advs });
      }

      // all customers — now with derived session/activity summary
      if (method === 'GET' && url === '/v1/admin/customers') {
        const sevenDaysAgo = Date.now() - 7 * 864e5;
        const dayAgo = Date.now() - 864e5;
        const custs = Object.values(db.users).filter(u => u.role === 'customer').map(u => {
          const imps = db.impressions.filter(i => i.userId === u.id);
          const flags = db.fraudFlags.filter(f => f.userId === u.id);
          const sessions7d = deriveSessions(imps.filter(i => i.ts > sevenDaysAgo));
          const totalSessionMin7d = sessions7d.reduce((s, x) => s + x.durationMin, 0);
          const adsShownToday = imps.some(i => i.ts > dayAgo);
          const lastImpression = imps.length ? Math.max(...imps.map(i => i.ts)) : null;
          const totalEarnedPaise = imps.reduce((s, i) => s + (i.earnedPaise||0), 0);
          const paidOutPaise = (db.withdrawalRequests||[])
            .filter(w => w.userId === u.id && (w.status === 'paid' || w.status === 'approved'))
            .reduce((s, w) => s + (w.amountPaise||0), 0);
          const pendingPaise = Math.max(0, totalEarnedPaise - paidOutPaise);
          const withdrawals = (db.withdrawalRequests||[])
            .filter(w => w.userId === u.id)
            .sort((a,b) => b.requestedAt - a.requestedAt)
            .slice(0, 5);
          return {
            ...publicUser(u),
            impressions: imps.length,
            earnedRupees: (totalEarnedPaise / 100).toFixed(2),
            pendingPaise,
            pendingRupees: (pendingPaise / 100).toFixed(2),
            paidOutRupees: (paidOutPaise / 100).toFixed(2),
            recentWithdrawals: withdrawals,
            fraudFlags: flags.length,
            sessions7d: sessions7d.length,
            totalSessionMin7d,
            adsShownToday,
            lastImpressionAt: lastImpression,
          };
        });
        return send(res, 200, { customers: custs });
      }

      // single-customer detail — session timeline + recent raw impressions, for the admin "View" drill-down
      if (method === 'GET' && url.match(/^\/v1\/admin\/customers\/[^/]+$/)) {
        const uidParam = url.split('/').pop();
        const target = db.users[uidParam];
        if (!target || target.role !== 'customer') return send(res, 404, { error: 'not found' });
        const imps = db.impressions.filter(i => i.userId === uidParam).sort((a, b) => b.ts - a.ts);
        const clk = db.clicks.filter(c => c.userId === uidParam).sort((a, b) => b.ts - a.ts);
        const sessions = deriveSessions(imps).slice(0, 30);
        const recentImpressions = imps.slice(0, 50).map(i => ({
          ts: i.ts, earnedPaise: i.earnedPaise, isHouseAd: !!i.isHouseAd,
          advertiser: db.campaigns[i.campaignId]?.advertiser || (i.isHouseAd ? 'WaitJI AI (house ad)' : 'Unknown'),
        }));
        return send(res, 200, {
          user: publicUser(target),
          totalImpressions: imps.length,
          totalClicks: clk.length,
          totalEarnedRupees: (imps.reduce((s, i) => s + (i.earnedPaise||0), 0) / 100).toFixed(2),
          sessions,
          recentImpressions,
        });
      }

      // ── Admin: send email to any audience ──────────────────────────────
      if (method === 'POST' && url === '/v1/admin/send-email') {
        if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin only' });
        const b = await getBody(req);
        const { subject, body: emailBody, audience, singleEmail } = b;
        if (!subject || !emailBody) return send(res, 400, { error: 'subject and body required' });
        if (!RESEND_API_KEY) return send(res, 503, { error: 'Resend not configured' });

        let recipients = [];
        if (audience === 'single' && singleEmail) {
          recipients = [singleEmail];
        } else if (audience === 'earners') {
          recipients = Object.values(db.users).filter(u => u.role === 'customer' && !u.banned).map(u => u.email);
        } else if (audience === 'advertisers') {
          recipients = Object.values(db.users).filter(u => u.role === 'advertiser' && !u.banned).map(u => u.email);
        } else if (audience === 'inactive-earners') {
          const cutoff = Date.now() - 14 * 864e5;
          recipients = Object.values(db.users).filter(u => u.role === 'customer' && !u.banned && (!u.lastActiveAt || u.lastActiveAt < cutoff)).map(u => u.email);
        } else if (audience === 'waitlist-not-joined') {
          const userEmails = new Set(Object.values(db.users).map(u => u.email.toLowerCase()));
          recipients = (db.waitlist || []).filter(e => !userEmails.has(e.email.toLowerCase())).map(e => e.email);
        } else if (audience === 'waitlist-all') {
          recipients = (db.waitlist || []).map(e => e.email);
        }

        if (!recipients.length) return send(res, 400, { error: 'No recipients found for this audience' });

        // Send in batches of 10 (Resend free tier limit)
        let sent = 0;
        const batches = [];
        for (let i = 0; i < recipients.length; i += 10) batches.push(recipients.slice(i, i + 10));
        for (const batch of batches) {
          try {
            await Promise.all(batch.map(email =>
              fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: LAUNCH_EMAIL_FROM,
                  to: [email],
                  subject,
                  html: emailBody + `<hr style="margin-top:32px;border:none;border-top:1px solid #eee;"><p style="font-size:11px;color:#999;">WaitJI AI · QivaLabs LLP · Udaipur, India · <a href="https://waitjiai.in">waitjiai.in</a></p>`,
                }),
              }).then(r => { if (r.ok) sent++; })
            ));
          } catch(e) { /* continue with next batch */ }
        }
        return send(res, 200, { success: true, sent, attempted: recipients.length });
      }

      // ── Admin: earner full ad log with geo ─────────────────────────────
      if (method === 'GET' && url.match(/^\/v1\/admin\/earners\/[^/]+\/adlog$/)) {
        if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin only' });
        const uidParam = url.split('/')[4];
        const target = db.users[uidParam];
        if (!target) return send(res, 404, { error: 'User not found' });
        const imps = db.impressions.filter(i => i.userId === uidParam).sort((a, b) => b.ts - a.ts);
        const clks = db.clicks.filter(c => c.userId === uidParam).sort((a, b) => b.ts - a.ts);
        const clickMap = {};
        clks.forEach(c => { clickMap[c.impressionId || c.campaignId + '_' + c.ts] = c; });
        const logs = imps.slice(0, 200).map(i => {
          const camp = db.campaigns[i.campaignId];
          return {
            id: i.id,
            ts: i.ts,
            date: new Date(i.ts).toLocaleString('en-IN'),
            adType: camp?.adType || i.adType || 'spotlight',
            adText: camp?.adText || i.adText || '—',
            advertiser: camp?.advertiser || (i.isHouseAd ? 'WaitJI (house ad)' : '—'),
            campaignId: i.campaignId,
            earnedPaise: i.earnedPaise || 0,
            isHouseAd: !!i.isHouseAd,
            country: i.country || 'IN',
            city: i.city || '—',
            surface: i.surface || 'terminal',
            clicked: !!i.clicked,
            valid: i.valid !== false,
          };
        });
        return send(res, 200, {
          user: publicUser(target),
          logs,
          summary: {
            totalImpressions: imps.length,
            totalClicks: clks.filter(c => c.valid).length,
            totalEarnedPaise: imps.reduce((s, i) => s + (i.earnedPaise || 0), 0),
            spotlight: imps.filter(i => db.campaigns[i.campaignId]?.adType === 'spotlight').length,
            stream: imps.filter(i => db.campaigns[i.campaignId]?.adType === 'stream').length,
            houseAds: imps.filter(i => i.isHouseAd).length,
            countries: [...new Set(imps.map(i => i.country || 'IN'))],
          },
        });
      }

      // ── Admin: advertiser full profile ─────────────────────────────────
      // all campaigns
      if (method === 'GET' && url === '/v1/admin/campaigns') {
        const allCamps = Object.values(db.campaigns).sort((a,b)=>b.createdAt-a.createdAt);
        return send(res, 200, { campaigns: allCamps });
      }


      if (method === 'POST' && url.match(/^\/v1\/advertiser\/campaigns\/[^/]+\/duplicate$/)) {
        const campId = url.split('/')[4];
        const camp = db.campaigns[campId];
        if (!camp || camp.advertiserId !== user.id) return send(res, 404, { error: 'Campaign not found' });
        const newCamp = {
          ...camp,
          id: uid('c_'),
          campaignName: (camp.campaignName || camp.adText) + ' (copy)',
          status: 'draft',
          spentPaise: 0,
          impressions: 0,
          clicks: 0,
          createdAt: Date.now(),
        };
        db.campaigns[newCamp.id] = newCamp;
        saveDB();
        auditLog(user.id, 'campaign_duplicate', { original: campId, copy: newCamp.id });
        return send(res, 201, { campaign: newCamp, message: 'Campaign duplicated as draft — review and launch when ready.' });
      }

      // ── Advertiser: reach estimator ──────────────────────────────────

      // ── Admin: FULL earner detail (everything an admin needs) ────────
      if (method === 'GET' && url.match(/^\/v1\/admin\/earners\/[^/]+\/full$/)) {
        const eid = url.split('/')[4];
        const u = db.users[eid];
        if (!u) return send(res, 404, { error: 'User not found' });

        const imps = db.impressions.filter(i => i.userId === eid);
        const realImps = imps.filter(i => !i.isReferralBonus);
        const refImps = imps.filter(i => i.isReferralBonus);
        const clicks = db.clicks.filter(c => c.userId === eid);
        const validClicks = clicks.filter(c => c.valid);
        const flags = db.fraudFlags.filter(f => f.userId === eid);
        const wds = db.withdrawalRequests.filter(w => w.userId === eid).sort((a,b)=>b.requestedAt-a.requestedAt);
        const logins = (db.loginLog||[]).filter(l => l.userId === eid).sort((a,b)=>b.ts-a.ts).slice(0,50);
        const sess = (db.sessions||{})[eid] || null;

        const totalEarnedPaise = imps.reduce((s,i)=>s+(i.earnedPaise||0),0);
        const paidOutPaise = wds.filter(w=>['paid','approved'].includes(w.status)).reduce((s,w)=>s+(w.amountPaise||0),0);
        const pendingWdPaise = wds.filter(w=>w.status==='pending').reduce((s,w)=>s+(w.amountPaise||0),0);
        const availablePaise = Math.max(0, totalEarnedPaise - paidOutPaise - pendingWdPaise);

        // Derive sessions from impression gaps (>15 min = new session)
        const sorted = [...realImps].sort((a,b)=>a.ts-b.ts);
        const sessions = [];
        let cur = null;
        for (const i of sorted) {
          if (!cur || i.ts - cur.end > 15*60_000) {
            if (cur) sessions.push(cur);
            cur = { start: i.ts, end: i.ts, impressions: 1, earnedPaise: i.earnedPaise||0, surfaces: {}, adTypes: {} };
          } else {
            cur.end = i.ts; cur.impressions++; cur.earnedPaise += (i.earnedPaise||0);
          }
          const sf = i.surface || 'terminal'; cur.surfaces[sf] = (cur.surfaces[sf]||0)+1;
          const at = i.adType || 'spotlight'; cur.adTypes[at] = (cur.adTypes[at]||0)+1;
        }
        if (cur) sessions.push(cur);
        const sessionList = sessions.reverse().slice(0,40).map(s => ({
          start: s.start, end: s.end,
          durationMin: Math.max(1, Math.round((s.end - s.start)/60000)),
          impressions: s.impressions,
          earnedPaise: s.earnedPaise,
          earnedRupees: (s.earnedPaise/100).toFixed(2),
          surfaces: s.surfaces, adTypes: s.adTypes,
        }));
        const totalActiveMin = sessions.reduce((s,x)=>s+Math.max(1,Math.round((x.end-x.start)/60000)),0);

        // Ad breakdown — what ads were shown
        const adBreakdown = {};
        realImps.forEach(i => {
          const key = i.advertiserName || db.campaigns[i.campaignId]?.advertiser || 'House ad';
          if (!adBreakdown[key]) adBreakdown[key] = { impressions:0, clicks:0, earnedPaise:0, adType: i.adType||'spotlight', adText: i.adText||'' };
          adBreakdown[key].impressions++;
          adBreakdown[key].earnedPaise += (i.earnedPaise||0);
          if (i.clicked) adBreakdown[key].clicks++;
        });

        // Surface + geo + adType breakdowns
        const bySurface={}, byGeo={}, byAdType={}, byHour={};
        realImps.forEach(i=>{
          bySurface[i.surface||'terminal']=(bySurface[i.surface||'terminal']||0)+1;
          byGeo[i.country||'IN']=(byGeo[i.country||'IN']||0)+1;
          byAdType[i.adType||'spotlight']=(byAdType[i.adType||'spotlight']||0)+1;
          const h=new Date(i.ts).getHours(); byHour[h]=(byHour[h]||0)+1;
        });

        // 30-day daily activity
        const dayMs=864e5, daily=[];
        for(let d=29;d>=0;d--){
          const ds=new Date(Date.now()-d*dayMs); ds.setHours(0,0,0,0);
          const de=new Date(ds); de.setHours(23,59,59,999);
          const di=realImps.filter(i=>i.ts>=ds.getTime()&&i.ts<=de.getTime());
          daily.push({
            date: ds.toISOString().slice(0,10),
            label: ds.toLocaleDateString('en-IN',{month:'short',day:'numeric'}),
            impressions: di.length,
            clicks: validClicks.filter(c=>c.ts>=ds.getTime()&&c.ts<=de.getTime()).length,
            earnedPaise: di.reduce((s,i)=>s+(i.earnedPaise||0),0),
          });
        }

        const lastImp = realImps.length ? Math.max(...realImps.map(i=>i.ts)) : null;
        const hourAgo = Date.now()-3600000, dayAgo = Date.now()-864e5;

        return send(res, 200, {
          user: {
            ...publicUser(u),
            userId: u.id,
            createdAt: u.createdAt,
            lastLoginAt: u.lastLoginAt || null,
            loginCount: u.loginCount || 0,
            referredBy: u.referredBy || null,
            referralCount: Object.values(db.users).filter(x=>x.referredBy===u.id).length,
          },
          earnings: {
            totalEarnedPaise, totalEarnedRupees: (totalEarnedPaise/100).toFixed(2),
            paidOutPaise, paidOutRupees: (paidOutPaise/100).toFixed(2),
            pendingWdPaise, pendingWdRupees: (pendingWdPaise/100).toFixed(2),
            availablePaise, availableRupees: (availablePaise/100).toFixed(2),
            referralEarnedPaise: refImps.reduce((s,i)=>s+(i.earnedPaise||0),0),
          },
          activity: {
            totalImpressions: realImps.length,
            referralImpressions: refImps.length,
            totalClicks: clicks.length,
            validClicks: validClicks.length,
            invalidClicks: clicks.length - validClicks.length,
            ctr: realImps.length ? (validClicks.length/realImps.length*100).toFixed(2) : '0.00',
            totalSessions: sessions.length,
            totalActiveMinutes: totalActiveMin,
            totalActiveHours: (totalActiveMin/60).toFixed(1),
            avgSessionMin: sessions.length ? Math.round(totalActiveMin/sessions.length) : 0,
            avgImpsPerSession: sessions.length ? Math.round(realImps.length/sessions.length) : 0,
            impressionsLastHour: realImps.filter(i=>i.ts>hourAgo).length,
            impressionsLast24h: realImps.filter(i=>i.ts>dayAgo).length,
            lastImpressionAt: lastImp,
            lastImpressionAgo: lastImp ? Math.round((Date.now()-lastImp)/60000)+' min ago' : 'never',
            status: lastImp && lastImp>hourAgo ? 'active' : lastImp && lastImp>dayAgo ? 'idle' : lastImp ? 'inactive' : 'never_connected',
            liveSession: sess ? { startedAt: sess.start, lastSeen: sess.lastSeen, impressions: sess.impressions, isLive: Date.now()-sess.lastSeen < 15*60_000 } : null,
          },
          breakdowns: { bySurface, byGeo, byAdType, byHour },
          adBreakdown: Object.entries(adBreakdown).map(([name,v])=>({
            advertiser: name, ...v,
            earnedRupees: (v.earnedPaise/100).toFixed(2),
            ctr: v.impressions ? (v.clicks/v.impressions*100).toFixed(2) : '0.00',
          })).sort((a,b)=>b.impressions-a.impressions),
          sessions: sessionList,
          daily,
          withdrawals: wds,
          logins,
          fraudFlags: flags,
          recentImpressions: realImps.slice(-100).reverse().map(i=>({
            ts: i.ts, adType: i.adType||'spotlight', surface: i.surface||'terminal',
            country: i.country||'IN', earnedPaise: i.earnedPaise||0,
            clicked: !!i.clicked, advertiser: i.advertiserName || db.campaigns[i.campaignId]?.advertiser || 'House ad',
            adText: i.adText || db.campaigns[i.campaignId]?.adText || '',
          })),
        });
      }

      // ── Admin: login log (all users) ─────────────────────────────────
      if (method === 'GET' && url === '/v1/admin/login-log') {
        const logs = (db.loginLog||[]).slice(-200).reverse();
        return send(res, 200, { logs, total: (db.loginLog||[]).length });
      }

      // ── Admin: live sessions (who is active right now) ───────────────
      if (method === 'GET' && url === '/v1/admin/live-sessions') {
        const now = Date.now();
        const live = Object.entries(db.sessions||{})
          .filter(([, s]) => now - s.lastSeen < 15*60_000)
          .map(([uid, s]) => ({
            userId: uid,
            email: db.users[uid]?.email || '—',
            name: db.users[uid]?.name || '—',
            startedAt: s.start,
            lastSeen: s.lastSeen,
            durationMin: Math.max(1, Math.round((s.lastSeen - s.start)/60000)),
            impressions: s.impressions || 0,
            idleSec: Math.round((now - s.lastSeen)/1000),
          }))
          .sort((a,b)=>b.lastSeen-a.lastSeen);
        return send(res, 200, { live, count: live.length });
      }

      // ── Admin: audit log ─────────────────────────────────────────────
      if (method === 'GET' && url === '/v1/admin/audit-log') {
        db.auditLog = db.auditLog || [];
        const logs = db.auditLog.slice(-100).reverse();
        return send(res, 200, { logs });
      }

      // ── Admin: IP block list ──────────────────────────────────────────
      if (method === 'GET' && url === '/v1/admin/ip-block') {
        db.ipBlockList = db.ipBlockList || [];
        return send(res, 200, { blocked: db.ipBlockList });
      }
      if (method === 'POST' && url === '/v1/admin/ip-block') {
        const b = await getBody(req);
        if (!b.ip) return send(res, 400, { error: 'ip required' });
        db.ipBlockList = db.ipBlockList || [];
        if (!db.ipBlockList.find(x => x.ip === b.ip)) {
          db.ipBlockList.push({ ip: b.ip, reason: b.reason || 'Manual block', blockedAt: Date.now(), blockedBy: user.id });
        }
        auditLog(user.id, 'ip_block', { ip: b.ip, reason: b.reason });
        saveDB();
        return send(res, 201, { success: true });
      }
      if (method === 'DELETE' && url.match(/^\/v1\/admin\/ip-block\/.+$/)) {
        const blockIp = decodeURIComponent(url.split('/').pop());
        db.ipBlockList = (db.ipBlockList || []).filter(x => x.ip !== blockIp);
        auditLog(user.id, 'ip_unblock', { ip: blockIp });
        saveDB();
        return send(res, 200, { success: true });
      }

      // ── Admin: GST invoice for advertiser campaign ────────────────────
      if (method === 'GET' && url.match(/^\/v1\/admin\/campaigns\/[^/]+\/invoice$/)) {
        if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin only' });
        const campId = url.split('/')[4];
        const camp = db.campaigns[campId];
        if (!camp) return send(res, 404, { error: 'Campaign not found' });
        const adv = db.users[camp.advertiserId];
        const spentRs = (camp.spentPaise || 0) / 100;
        // IMPORTANT: only charge/show GST if QivaLabs LLP actually has a GSTIN.
        // Charging GST on an invoice without a valid GSTIN is not legally permitted
        // in India — set QIVALABS_GSTIN in env once registered to switch this on.
        const isGstRegistered = !!QIVALABS_GSTIN;
        const gst = isGstRegistered ? spentRs * 0.18 : 0;
        const total = spentRs + gst;
        return send(res, 200, {
          invoice: {
            invoiceNo: 'WAITJI-' + campId.slice(-8).toUpperCase(),
            date: new Date().toISOString().slice(0, 10),
            seller: { name: 'QivaLabs LLP', gstin: isGstRegistered ? QIVALABS_GSTIN : 'Not GST registered', address: 'Udaipur, Rajasthan', pan: 'AABFQ4385M' },
            buyer: { name: adv?.company || adv?.name || 'Advertiser', email: adv?.email || '', gstin: adv?.gstin || 'N/A' },
            items: [{ desc: `Ad campaign: ${camp.adText?.slice(0, 40)}`, hsn: '998361', rate: spentRs, qty: 1, amount: spentRs }],
            subtotal: spentRs,
            cgst: isGstRegistered ? gst / 2 : 0,
            sgst: isGstRegistered ? gst / 2 : 0,
            igst: 0,
            gstApplicable: isGstRegistered,
            total,
            campaign: { id: campId, impressions: camp.impressions || 0, adType: camp.adType },
          },
        });
      }



      // ── Admin: extension health check per earner ─────────────────────
      if (method === 'GET' && url.match(/^\/v1\/admin\/earners\/[^/]+\/health$/)) {
        if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin only' });
        const eid = url.split('/')[4];
        const target = db.users[eid];
        if (!target) return send(res, 404, { error: 'User not found' });
        const imps = db.impressions.filter(i => i.userId === eid);
        const lastImp = imps.length ? Math.max(...imps.map(i => i.ts)) : null;
        const hourAgo = Date.now() - 3600000;
        const dayAgo = Date.now() - 864e5;
        return send(res, 200, {
          userId: eid,
          lastImpressionAt: lastImp,
          lastImpressionAgo: lastImp ? Math.round((Date.now() - lastImp) / 60000) + ' min ago' : 'never',
          activeLastHour: imps.filter(i => i.ts > hourAgo).length > 0,
          activeLastDay: imps.filter(i => i.ts > dayAgo).length > 0,
          impressionsLastHour: imps.filter(i => i.ts > hourAgo).length,
          impressionsLastDay: imps.filter(i => i.ts > dayAgo).length,
          status: lastImp && lastImp > hourAgo ? 'active' : lastImp && lastImp > dayAgo ? 'idle' : 'disconnected',
        });
      }

      // single-campaign detailed stats — daily breakdown + unique users reached
      if (method === 'GET' && url.match(/^\/v1\/admin\/campaigns\/[^/]+\/stats$/)) {
        const cid = url.split('/')[4];
        const c = db.campaigns[cid];
        if (!c) return send(res, 404, { error: 'not found' });
        const imps = db.impressions.filter(i => i.campaignId === cid);
        const clk = db.clicks.filter(c2 => c2.campaignId === cid);
        const uniqueUsers = new Set(imps.map(i => i.userId)).size;
        return send(res, 200, {
          campaign: c,
          daily: dailyBreakdown([cid]),
          uniqueUsersReached: uniqueUsers,
          totalImpressions: imps.length,
          validClicks: clk.filter(x => x.valid).length,
          invalidClicks: clk.filter(x => !x.valid).length,
          ctr: imps.length ? (clk.filter(x => x.valid).length / imps.length * 100).toFixed(2) : '0.00',
        });
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
          // Scheduling: if the advertiser set a future start date, land the campaign in
          // 'scheduled' instead of 'active' — the scheduler (see runScheduledCampaignSweep)
          // flips it to 'active' automatically once that time arrives.
          if (c.scheduledStartAt && c.scheduledStartAt > Date.now()) {
            c.status = 'scheduled';
          } else {
            c.status = 'active';
          }
          auditLog(user.id, 'campaign_approved', { campId: cid, adText: c.adText?.slice(0,40), advertiserId: c.advertiserId });
        } else if (b.status === 'rejected') {
          if (c.paymentId && !c.refunded) {
            try {
              if (c.paymentRail === 'paypal') {
                const token = await paypalToken();
                const rr = await fetch(`${PAYPAL_BASE}/v2/payments/captures/${c.paymentId}/refund`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ note_to_payer: (b.reason || 'Campaign rejected — policy review').slice(0, 255) }),
                });
                if (!rr.ok) throw new Error('PayPal refund failed: ' + (await rr.text()).slice(0, 200));
              } else {
                await razorpayApi('POST', `/payments/${c.paymentId}/refund`, { notes: { reason: b.reason || 'Campaign rejected — policy review' } });
              }
              c.refunded = true;
            } catch (e) {
              saveDB();
              return send(res, 502, { error: 'Refund failed: ' + e.message + '. Campaign NOT marked rejected — retry once the payment gateway issue is resolved.' });
            }
          }
          c.status = 'rejected';
          c.rejectReason = b.reason || null;
          auditLog(user.id, 'campaign_rejected', { campId: cid, reason: b.reason, advertiserId: c.advertiserId });
        } else if (b.status === 'paused' && c.status === 'active') {
          c.status = 'paused';
          auditLog(user.id, 'campaign_paused', { campId: cid, advertiserId: c.advertiserId });
        }
        saveDB();
        return send(res, 200, { campaign: c });
      }

      // ── HOUSE ADS: manage the zero-advertiser fallback ──
      // ── Discount codes CRUD ──
      if (method === 'GET' && url === '/v1/admin/discount-codes') {
        return send(res, 200, { codes: db.discountCodes || [] });
      }
      if (method === 'POST' && url === '/v1/admin/discount-codes') {
        if (!requireScope(user, ['finance'], res)) return;
        const b = await getBody(req);
        if (!b.code || !b.discountPct) return send(res, 400, { error: 'code and discountPct required' });
        const code = b.code.trim().toUpperCase().replace(/\s+/g, '');
        if ((db.discountCodes || []).find(d => d.code === code)) return send(res, 400, { error: 'Code already exists' });
        const dc = {
          id: uid('dc_'), code,
          discountPct: Math.min(100, Math.max(1, Number(b.discountPct))),
          description: b.description || '',
          maxUses: b.maxUses ? Number(b.maxUses) : null,
          usedCount: 0,
          expiresAt: b.expiresAt ? new Date(b.expiresAt).getTime() : null,
          active: true,
          createdAt: Date.now(),
        };
        db.discountCodes ||= [];
        db.discountCodes.push(dc);
        saveDB();
        return send(res, 201, { code: dc });
      }
      if (method === 'PATCH' && url.match(/^\/v1\/admin\/discount-codes\/[^/]+$/)) {
        const dcId = url.split('/').pop();
        const dc = (db.discountCodes || []).find(d => d.id === dcId);
        if (!dc) return send(res, 404, { error: 'not found' });
        const b = await getBody(req);
        if (b.active !== undefined) dc.active = !!b.active;
        if (b.maxUses !== undefined) dc.maxUses = b.maxUses ? Number(b.maxUses) : null;
        if (b.expiresAt !== undefined) dc.expiresAt = b.expiresAt ? new Date(b.expiresAt).getTime() : null;
        if (b.description !== undefined) dc.description = b.description;
        saveDB();
        return send(res, 200, { code: dc });
      }
      if (method === 'DELETE' && url.match(/^\/v1\/admin\/discount-codes\/[^/]+$/)) {
        const dcId = url.split('/').pop();
        db.discountCodes = (db.discountCodes || []).filter(d => d.id !== dcId);
        saveDB();
        return send(res, 200, { deleted: true });
      }

      if (method === 'GET' && url === '/v1/admin/house-ads') {
        return send(res, 200, { houseAds: db.houseAds || [] });
      }
      if (method === 'POST' && url === '/v1/admin/house-ads') {
        const b = await getBody(req);
        if (!b.text || !b.url) return send(res, 400, { error: 'text and url required' });
        const ad = { id: uid('house_'), text: b.text, url: b.url, active: b.active !== false, createdAt: Date.now() };
        db.houseAds.push(ad);
        auditLog(user.id, 'house_ad_created', { text: (ad.text||'').slice(0,40) });
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

      // ── FEATURE: list fraud-flag disputes for admin review ──
      if (method === 'GET' && url === '/v1/admin/disputes') {
        const list = db.disputes.slice().sort((a,b) => b.createdAt - a.createdAt).map(d => {
          const flag = db.fraudFlags.find(f => f.id === d.flagId);
          const disputeUser = db.users[d.userId];
          return { ...d, userEmail: disputeUser?.email || d.userId, flagType: flag?.type || 'unknown', flagDetail: flag?.detail || '', flagSeverity: flag?.severity || 'unknown' };
        });
        return send(res, 200, {
          disputes: list,
          pendingCount: list.filter(d => d.status === 'pending').length,
        });
      }

      // ── FEATURE: resolve a dispute (uphold the flag, or clear it — clearing removes the flag entirely) ──
      if (method === 'POST' && url.match(/^\/v1\/admin\/disputes\/[^/]+\/resolve$/)) {
        const did = url.split('/')[4];
        const dispute = db.disputes.find(d => d.id === did);
        if (!dispute) return send(res, 404, { error: 'Dispute not found' });
        if (dispute.status !== 'pending') return send(res, 400, { error: `Already resolved — status is "${dispute.status}"` });
        const b = await getBody(req);
        if (!['upheld', 'cleared'].includes(b.decision)) return send(res, 400, { error: 'decision must be "upheld" or "cleared"' });

        dispute.status = b.decision;
        dispute.resolvedAt = Date.now();
        dispute.adminNote = b.note || null;

        if (b.decision === 'cleared') {
          db.fraudFlags = db.fraudFlags.filter(f => f.id !== dispute.flagId);
        }
        auditLog(user.id, 'dispute_resolved', { disputeId: did, decision: b.decision, userId: dispute.userId });
        saveDB();

        const disputeUser = db.users[dispute.userId];
        if (RESEND_API_KEY && disputeUser?.email) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: LAUNCH_EMAIL_FROM, to: [disputeUser.email],
              subject: b.decision === 'cleared' ? '✅ Your fraud-flag dispute was upheld — flag removed' : 'Your fraud-flag dispute was reviewed',
              html: b.decision === 'cleared'
                ? `<p>Hi ${disputeUser.name||'there'},</p><p>We reviewed your dispute and cleared the flag from your account. Sorry for the friction — thanks for the explanation.</p><p>— WaitJI AI Team</p>`
                : `<p>Hi ${disputeUser.name||'there'},</p><p>We reviewed your dispute, but the flag remains on your account.${b.note ? ' Note: ' + b.note : ''}</p><p>If you believe this is wrong, reply to this email.</p><p>— WaitJI AI Team</p>`,
            }),
          }).catch(() => {});
        }
        return send(res, 200, { dispute, message: `Dispute ${b.decision}.` });
      }

      // ── FEATURE: founder-level revenue dashboard ──
      // Separate from the operational admin panels (which show per-user/per-campaign
      // detail) — this answers the founder question "how is the business doing"
      // in one call: gross revenue, payouts issued, margin, active campaign count.
      if (method === 'GET' && url === '/v1/admin/revenue-dashboard') {
        const allCampaigns = Object.values(db.campaigns);
        const grossRevenuePaise = allCampaigns.reduce((s, c) => s + (c.spentPaise || 0), 0);
        const totalPayoutsPaise = db.payouts.filter(p => p.status === 'paid').reduce((s, p) => s + p.amountPaise, 0);
        const pendingPayoutsPaise = db.withdrawalRequests.filter(r => r.status === 'pending').reduce((s, r) => s + r.amountPaise, 0);
        const grossMarginPaise = grossRevenuePaise - totalPayoutsPaise;
        const activeCampaigns = allCampaigns.filter(c => c.status === 'active').length;
        const scheduledCampaigns = allCampaigns.filter(c => c.status === 'scheduled').length;

        // Last-30-day revenue trend (daily), useful for a lightweight "is this growing" read
        const dayMs = 864e5;
        const days = [];
        for (let i = 29; i >= 0; i--) {
          const dayStart = Date.now() - i * dayMs;
          const dayEnd = dayStart + dayMs;
          const dayImps = db.impressions.filter(im => im.ts >= dayStart && im.ts < dayEnd && !im.isHouseAd);
          const dayRevenuePaise = dayImps.reduce((s, im) => s + (im.costPaise || 0), 0);
          days.push({ date: new Date(dayStart).toISOString().slice(0,10), revenueRupees: (dayRevenuePaise/100).toFixed(2) });
        }

        return send(res, 200, {
          grossRevenueRupees: (grossRevenuePaise/100).toFixed(2),
          totalPayoutsRupees: (totalPayoutsPaise/100).toFixed(2),
          pendingPayoutsRupees: (pendingPayoutsPaise/100).toFixed(2),
          grossMarginRupees: (grossMarginPaise/100).toFixed(2),
          grossMarginPct: grossRevenuePaise > 0 ? ((grossMarginPaise/grossRevenuePaise)*100).toFixed(1) : '0.0',
          activeCampaigns, scheduledCampaigns,
          totalAdvertisers: Object.values(db.users).filter(u => u.role === 'advertiser').length,
          totalEarners: Object.values(db.users).filter(u => u.role === 'customer').length,
          dailyTrend: days,
        });
      }

      // ban / unban user (with optional reason — e.g. "ad policy violation", "nudity")
      if (method === 'PATCH' && url.match(/^\/v1\/admin\/users\/[^/]+$/)) {
        if (!requireScope(user, ['moderation'], res)) return;
        const uidToBan = url.split('/').pop();
        const target = db.users[uidToBan];
        if (!target) return send(res, 404, { error: 'not found' });
        const b = await getBody(req);
        if (typeof b.banned === 'boolean') {
          target.banned = b.banned;
          target.banReason = b.banned ? (b.reason || 'Not specified') : null;
          target.bannedAt = b.banned ? Date.now() : null;
          auditLog(user.id, b.banned ? 'user_ban' : 'user_unban', { targetId: uidToBan, email: target.email, reason: b.reason });
        }
        if (b.role === 'advertiser' || b.role === 'customer') {
          auditLog(user.id, 'user_role_change', { targetId: uidToBan, email: target.email, newRole: b.role });
          target.role = b.role;
        }
        saveDB();
        return send(res, 200, { user: publicUser(target) });
      }

      // ── FEATURE: role-based admin sub-accounts ──
      if (method === 'GET' && url === '/v1/admin/sub-admins') {
        const subs = Object.values(db.users)
          .filter(u => u.role === 'admin' && u.id !== 'admin')
          .map(u => ({ id: u.id, email: u.email, name: u.name, adminScope: u.adminScope || 'full', createdAt: u.createdAt, banned: u.banned }));
        return send(res, 200, { subAdmins: subs, isFullAdmin: isFullAdmin(user) });
      }
      if (method === 'POST' && url === '/v1/admin/sub-admins') {
        if (!requireFullAdmin(user, res)) return; // only a full admin can create other admin accounts
        const b = await getBody(req);
        if (!b.email || !b.password) return send(res, 400, { error: 'email and password are required' });
        if (Object.values(db.users).some(u => u.email === b.email.toLowerCase())) return send(res, 400, { error: 'A user with this email already exists' });
        const validScopes = ['support', 'finance', 'moderation']; // support: view-only; finance: can approve payouts; moderation: can ban/review campaigns
        const scopes = Array.isArray(b.scopes) ? b.scopes.filter(s => validScopes.includes(s)) : [];
        if (scopes.length === 0) return send(res, 400, { error: `scopes must include at least one of: ${validScopes.join(', ')}` });

        const subId = uid('subadmin_');
        db.users[subId] = {
          id: subId, email: b.email.toLowerCase(), passwordHash: hashPassword(b.password),
          role: 'admin', adminScope: scopes, name: b.name || b.email, createdAt: Date.now(), banned: false,
        };
        auditLog(user.id, 'sub_admin_created', { subAdminId: subId, email: b.email, scopes });
        saveDB();
        return send(res, 201, { subAdmin: { id: subId, email: b.email, adminScope: scopes } });
      }
      if (method === 'DELETE' && url.match(/^\/v1\/admin\/sub-admins\/[^/]+$/)) {
        if (!requireFullAdmin(user, res)) return;
        const subId = url.split('/').pop();
        const target = db.users[subId];
        if (!target || target.role !== 'admin' || subId === 'admin') return send(res, 404, { error: 'Sub-admin not found' });
        delete db.users[subId];
        auditLog(user.id, 'sub_admin_removed', { subAdminId: subId, email: target.email });
        saveDB();
        return send(res, 200, { success: true });
      }
    } // ← closes `if (url.startsWith('/v1/admin'))` — this brace was MISSING (was
      //   incorrectly closing ~230 lines earlier), which had silently ejected every
      //   route below this point out of the admin-auth gate. See fix notes.

    // ── Public: list active jobs (for careers.html) ──
    if (method === 'GET' && url === '/v1/public/jobs') {
      const jobs = (db.jobs || [])
        .filter(j => j.active)
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      return send(res, 200, { jobs, total: jobs.length });
    }

    // ── CAREERS: public submit application ──
    if (method === 'POST' && url === '/v1/careers/apply') {
      const b = await getBody(req);
      const { name, email, phone, role, coverLetter, resumeBase64, resumeName, resumeType } = b;
      if (!name || !email || !role) return send(res, 400, { error: 'name, email, and role are required' });
      if (!resumeBase64) return send(res, 400, { error: 'Resume is required' });
      if (resumeBase64.length > 5 * 1024 * 1024 * 1.4) return send(res, 400, { error: 'Resume must be under 5MB' }); // base64 ~1.37x

      // Upload resume to Supabase Storage
      let resumeUrl = null;
      try {
        const fileExt = (resumeName || 'resume.pdf').split('.').pop().toLowerCase();
        const fileName = `resumes/${Date.now()}_${uid()}.${fileExt}`;
        const fileBuffer = Buffer.from(resumeBase64, 'base64');
        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/careers/${fileName}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY}`,
              'apikey': SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY,
              'Content-Type': resumeType || 'application/pdf',
              'x-upsert': 'true',
            },
            body: fileBuffer,
          }
        );
        if (uploadRes.ok) {
          resumeUrl = `${SUPABASE_URL}/storage/v1/object/public/careers/${fileName}`;
        } else {
          const errText = await uploadRes.text().catch(()=>'');
          console.error('Supabase storage upload failed:', uploadRes.status, errText);
          // Fallback: store base64 inline (smaller resumes only)
          resumeUrl = `data:${resumeType||'application/pdf'};base64,${resumeBase64.slice(0,100)}...`;
        }
      } catch(e) {
        console.error('Resume upload error:', e.message);
      }

      const application = {
        id: uid('app_'),
        name: name.trim(),
        email: email.toLowerCase().trim(),
        phone: (phone||'').trim(),
        role,
        coverLetter: (coverLetter||'').trim().slice(0, 2000),
        resumeUrl,
        resumeName: resumeName || 'resume.pdf',
        status: 'new',
        appliedAt: Date.now(),
        notes: '',
        ip,
      };
      db.careers.push(application);
      saveDB();

      // Email admin
      if (RESEND_API_KEY) {
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: LAUNCH_EMAIL_FROM,
            to: ['admin@waitjiai.in'],
            subject: `💼 New application — ${role} — ${name}`,
            html: `<p><b>New job application on WaitJI AI</b></p>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Name</td><td><b>${name}</b></td></tr>
                <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Email</td><td>${email}</td></tr>
                <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Phone</td><td>${phone||'—'}</td></tr>
                <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Role</td><td><b>${role}</b></td></tr>
                <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Cover letter</td><td>${(coverLetter||'—').slice(0,300)}</td></tr>
                <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Resume</td><td><a href="${resumeUrl||'#'}">Download CV</a></td></tr>
              </table>
              <p style="margin-top:16px"><a href="https://waitjiai.in/admin.html" style="background:#2A7A4F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">View in Admin Panel →</a></p>`,
          }),
        }).catch(()=>{});
      }

      // Confirmation email to applicant
      if (RESEND_API_KEY) {
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: LAUNCH_EMAIL_FROM,
            to: [email],
            subject: `✅ Application received — ${role} at WaitJI AI`,
            html: `<p>Hi ${name},</p>
              <p>We've received your application for <b>${role}</b> at WaitJI AI. Our team will review it and get back to you within 3–5 business days.</p>
              <p>In the meantime, feel free to install our VS Code extension and start earning while you code!</p>
              <p>— Rajamuddin & the WaitJI AI Team<br>QivaLabs LLP, Udaipur</p>`,
          }),
        }).catch(()=>{});
      }

      return send(res, 201, { success: true, applicationId: application.id, message: 'Application received! We will get back to you within 3–5 business days.' });
    }

    // ── ADMIN: Jobs CRUD ──
    if (method === 'GET' && url === '/v1/admin/jobs') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });
      const jobs = (db.jobs || []).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      return send(res, 200, { jobs });
    }
    if (method === 'POST' && url === '/v1/admin/jobs') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });
      const b = await getBody(req);
      if (!b.title) return send(res, 400, { error: 'title is required' });
      const job = {
        id: uid('job_'),
        title: b.title.trim(),
        type: b.type || 'Full-time',
        location: b.location || 'Remote',
        tags: b.tags || [],
        description: (b.description || '').trim(),
        requirements: (b.requirements || '').trim(),
        active: b.active !== false,
        createdAt: Date.now(),
        order: (db.jobs || []).length,
      };
      db.jobs = db.jobs || [];
      db.jobs.push(job);
      saveDB();
      return send(res, 201, { job });
    }
    if (method === 'PATCH' && url.match(/^\/v1\/admin\/jobs\/[^/]+$/)) {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });
      const jobId = url.split('/').pop();
      const job = (db.jobs || []).find(j => j.id === jobId);
      if (!job) return send(res, 404, { error: 'Job not found' });
      const b = await getBody(req);
      if (b.title !== undefined) job.title = b.title.trim();
      if (b.type !== undefined) job.type = b.type;
      if (b.location !== undefined) job.location = b.location;
      if (b.tags !== undefined) job.tags = b.tags;
      if (b.description !== undefined) job.description = b.description.trim();
      if (b.requirements !== undefined) job.requirements = b.requirements.trim();
      if (b.active !== undefined) job.active = !!b.active;
      if (b.order !== undefined) job.order = Number(b.order);
      job.updatedAt = Date.now();
      saveDB();
      return send(res, 200, { job });
    }
    if (method === 'DELETE' && url.match(/^\/v1\/admin\/jobs\/[^/]+$/)) {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });
      const jobId = url.split('/').pop();
      db.jobs = (db.jobs || []).filter(j => j.id !== jobId);
      saveDB();
      return send(res, 200, { deleted: true });
    }

    // ── CAREERS: admin list all applications ──
    if (method === 'GET' && url.startsWith('/v1/admin/careers')) {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });
      const params = new URL('http://x'+url).searchParams;
      const statusFilter = params.get('status');
      let apps = [...(db.careers||[])].sort((a,b) => b.appliedAt - a.appliedAt);
      if (statusFilter) apps = apps.filter(a => a.status === statusFilter);
      return send(res, 200, {
        applications: apps,
        summary: {
          total: db.careers.length,
          new: db.careers.filter(a=>a.status==='new').length,
          reviewing: db.careers.filter(a=>a.status==='reviewing').length,
          shortlisted: db.careers.filter(a=>a.status==='shortlisted').length,
          rejected: db.careers.filter(a=>a.status==='rejected').length,
          hired: db.careers.filter(a=>a.status==='hired').length,
        }
      });
    }

    // ── CAREERS: admin update application status/notes ──
    if (method === 'PATCH' && url.match(/^\/v1\/admin\/careers\/[^/]+$/)) {
      const user = auth(req);
      if (!user || user.role !== 'admin') return send(res, 403, { error: 'admin access required' });
      const appId = url.split('/').pop();
      const app = (db.careers||[]).find(a => a.id === appId);
      if (!app) return send(res, 404, { error: 'Application not found' });
      const b = await getBody(req);
      if (b.status) app.status = b.status;
      if (b.notes !== undefined) app.notes = b.notes;
      app.updatedAt = Date.now();
      saveDB();
      return send(res, 200, { application: app });
    }

    // ── public bidding stats (for homepage live bidding section) ──
    if (method === 'GET' && url === '/v1/public/bidding-stats') {
      const allActive = Object.values(db.campaigns).filter(c => c.status === 'active');

      const spotlight = allActive
        .filter(c => !c.adType || c.adType === 'spotlight')
        .sort((a, b) => b.bidPaise - a.bidPaise)
        .map(c => ({
          advertiser: c.advertiser, adText: c.adText, bidPaise: c.bidPaise, targetingCategory: c.targetingCategory, adType: 'spotlight',
          remainingImpressions: c.bidPaise > 0 ? Math.max(0, Math.floor(((c.budgetPaise || 0) - (c.spentPaise || 0)) / c.bidPaise * 1000)) : 0,
        }));

      const stream = allActive
        .filter(c => c.adType === 'stream')
        .sort((a, b) => b.bidPaise - a.bidPaise)
        .map(c => ({
          advertiser: c.advertiser, adText: c.adText, bidPaise: c.bidPaise, targetingCategory: c.targetingCategory, adType: 'stream',
          remainingImpressions: c.bidPaise > 0 ? Math.max(0, Math.floor(((c.budgetPaise || 0) - (c.spentPaise || 0)) / c.bidPaise * 1000)) : 0,
        }));

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

      // top bid floor for each type
      const spotlightTopBid = spotlight[0]?.bidPaise || 0;
      const streamTopBid = stream[0]?.bidPaise || 0;

      return send(res, 200, {
        activeCampaignsCount: allActive.length,
        spotlight, stream,
        spotlightTopBidRupees: (spotlightTopBid / 100).toFixed(0),
        streamTopBidRupees: (streamTopBid / 100).toFixed(0),
        todaySpentRupees: (todayBucket.spentPaise / 100).toFixed(2),
        todayImpressions: todayBucket.impressions,
        dailyBidding,
        updatedAt: Date.now(),
      });
    }

    // ── FEATURE: public ADVERTISER leaderboard (opt-in, Kickbacks.ai-style social proof) ──
    // Named distinctly from /v1/public/leaderboard (which is the pre-existing DEVELOPER
    // earnings leaderboard) to avoid a route collision — both existing at the same path
    // would have silently made this one permanently unreachable dead code.
    if (method === 'GET' && url === '/v1/public/advertiser-leaderboard') {
      const entries = Object.values(db.campaigns)
        .filter(c => c.showOnLeaderboard && (c.status === 'active' || c.status === 'completed'))
        .map(c => {
          const impressions = db.impressions.filter(i => i.campaignId === c.id).length;
          const clicks = db.clicks.filter(cl => cl.campaignId === c.id && cl.valid).length;
          return {
            campaignId: c.id,
            companyName: c.companyName || c.advertiser || 'Advertiser',
            brandIconUrl: c.brandIconUrl || null,
            adText: c.adText,
            url: c.url,
            impressions, clicks,
            adType: c.adType,
          };
        })
        .filter(e => e.impressions > 0) // don't show zero-activity entries — nothing to be proud of yet
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 25);
      return send(res, 200, { leaderboard: entries, updatedAt: Date.now() });
    }

    // ── public stats (for website ticker) ──
    // /vsix — redirects to the latest extension VSIX so users can do:
    // curl -L https://waitjiai-backend.onrender.com/vsix -o waitji.vsix && code --install-extension waitji.vsix
    // Or even better, point waitjiai.in/vsix → this via a Vercel rewrite (add to vercel.json)
    if (method === 'GET' && url === '/vsix') {
      res.writeHead(302, { Location: 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/WaitJiai/vsextensions/waitji-ai/latest/vspackage' });
      res.end();
      return;
    }

    if (method === 'GET' && url === '/v1/stats') {
      const totalEarned = db.impressions.reduce((s, i) => s + (i.earnedPaise||0), 0);
      const totalUsers = Object.values(db.users).filter(u => u.role === 'customer').length;
      return send(res, 200, {
        totalImpressions: db.impressions.length,
        activeCampaigns: Object.values(db.campaigns).filter(c => c.status === 'active').length,
        totalPaidRupees: Math.floor(totalEarned / 100),
        totalUsers,
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

// Derives "sessions" from a user's raw impression timestamps. We have no
// explicit login/logout event from the extension — but the background
// poller pings every ~90s while VS Code is open, so consecutive impressions
// less than SESSION_GAP_MS apart are treated as one continuous coding
// session, and any larger gap starts a new session. This is an honest
// approximation, not a tracked session ID — documented as such in the UI.
const SESSION_GAP_MS = 6 * 60 * 1000; // 6 min — tolerates a couple of missed poller ticks
function deriveSessions(impressions) {
  if (!impressions.length) return [];
  const sorted = [...impressions].sort((a, b) => a.ts - b.ts);
  const sessions = [];
  let cur = { startTs: sorted[0].ts, endTs: sorted[0].ts, impressions: 1, earnedPaise: sorted[0].earnedPaise || 0, adsShown: 1 };
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].ts - cur.endTs;
    if (gap > SESSION_GAP_MS) {
      sessions.push(cur);
      cur = { startTs: sorted[i].ts, endTs: sorted[i].ts, impressions: 1, earnedPaise: sorted[i].earnedPaise || 0, adsShown: 1 };
    } else {
      cur.endTs = sorted[i].ts;
      cur.impressions += 1;
      cur.earnedPaise += sorted[i].earnedPaise || 0;
      cur.adsShown += 1;
    }
  }
  sessions.push(cur);
  return sessions.reverse().map(s => ({
    ...s,
    durationMin: Math.max(1, Math.round((s.endTs - s.startTs) / 60000)),
  }));
}

// Builds a daily (last N days) breakdown of impressions/clicks/spend for a
// given set of campaign IDs — shared by admin campaign-detail and the
// advertiser's own stats view.
function dailyBreakdown(campaignIds, days = 14) {
  const dayMs = 864e5;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = today.getTime() - i * dayMs;
    buckets.push({ date: new Date(start).toISOString().slice(0, 10), start, end: start + dayMs, impressions: 0, validClicks: 0, invalidClicks: 0, spentPaise: 0 });
  }
  const idSet = new Set(campaignIds);
  const findBucket = ts => buckets.find(b => ts >= b.start && ts < b.end);
  db.impressions.forEach(i => {
    if (!idSet.has(i.campaignId)) return;
    const b = findBucket(i.ts);
    if (b) { b.impressions++; b.spentPaise += i.costPaise || 0; }
  });
  db.clicks.forEach(c => {
    if (!idSet.has(c.campaignId)) return;
    const b = findBucket(c.ts);
    if (!b) return;
    if (c.valid) { b.validClicks++; b.spentPaise += c.costPaise || 0; }
    else b.invalidClicks++;
  });
  return buckets.map(b => ({ date: b.date, impressions: b.impressions, validClicks: b.validClicks, invalidClicks: b.invalidClicks, spentRupees: (b.spentPaise / 100).toFixed(2) }));
}

// ── Profile completeness check ──────────────────────────────────────────────
// Returns an object describing what's complete and what's missing.
// Withdrawal is BLOCKED unless all 5 fields are verified.
function profileStatus(user) {
  const checks = {
    name:    { done: !!(user.name && user.name.trim().length >= 2),      label: 'Full name' },
    phone:   { done: !!(user.phone && /^[6-9]\d{9}$/.test(user.phone)), label: 'Phone number (10 digit)' },
    email:   { done: !!(user.emailVerified),                              label: 'Email verified' },
    payout:  { done: !!(user.payoutVerified),                             label: 'UPI or bank account verified' },
  };
  const complete = Object.values(checks).every(c => c.done);
  const missing = Object.entries(checks).filter(([,v]) => !v.done).map(([,v]) => v.label);
  return { complete, checks, missing };
}

function publicUser(u) {
  const ps = profileStatus(u);
  const payoutMethod = u.payoutMode === 'paypal' && u.paypalEmail
    ? { type: 'paypal', paypalEmail: u.paypalEmail }
    : u.payoutMode === 'bank' && u.bankAccount
    ? { type: 'bank', last4: decrypt(u.bankAccount.accountNumber)?.slice(-4), bankIfsc: u.bankAccount.ifsc, bankName: u.bankAccount.accountHolder }
    : u.upiId ? { type: 'upi', upiId: u.upiId } : null;
  return {
    id: u.id, email: u.email, phone: u.phone || '', role: u.role,
    name: u.name, company: u.company, upiId: u.upiId,
    provider: u.provider || 'email',
    emailVerified: !!u.emailVerified, phoneVerified: !!u.phoneVerified,
    banned: u.banned, banReason: u.banReason || null,
    lastActiveAt: u.lastActiveAt || null, createdAt: u.createdAt,
    payoutVerified: !!u.payoutVerified, payoutMode: u.payoutMode || null,
    bankVerified: !!u.bankVerified,
    bankAccount: u.bankAccount || null,   // full object: {accountNumber, ifsc, accountHolder}
    upiNameAtBank: u.upiNameAtBank || '',
    payoutMethod,
    profileStatus: ps,
  };
}

// ── Shared balance calculation (used by manual withdrawal request + auto-payout sweep) ──
function computeAvailableBalance(userId) {
  const imps = db.impressions.filter(i => i.userId === userId);
  const total = imps.reduce((s, i) => s + (i.earnedPaise || 0), 0);
  const alreadyPaidOrPending = db.withdrawalRequests
    .filter(r => r.userId === userId && ['pending', 'approved', 'paid'].includes(r.status))
    .reduce((s, r) => s + r.amountPaise, 0);
  return total - alreadyPaidOrPending;
}

// ── FEATURE: Campaign auto-scheduling ──────────────────────────────────────────
// Runs every 5 minutes. Flips 'scheduled' campaigns to 'active' once their
// scheduledStartAt passes, and 'active' campaigns to 'completed' once their
// scheduledEndAt passes — so advertisers can set a date range once and walk away.
async function runCampaignScheduleSweep() {
  try {
    const now = Date.now();
    let changed = false;
    for (const c of Object.values(db.campaigns)) {
      if (c.status === 'scheduled' && c.scheduledStartAt && c.scheduledStartAt <= now) {
        c.status = 'active';
        changed = true;
        auditLog('system', 'campaign_auto_started', { campId: c.id, advertiserId: c.advertiserId });
      } else if (c.status === 'active' && c.scheduledEndAt && c.scheduledEndAt <= now) {
        c.status = 'completed';
        changed = true;
        auditLog('system', 'campaign_auto_ended', { campId: c.id, advertiserId: c.advertiserId });
      }
    }
    if (changed) saveDB();
  } catch (e) { console.error('runCampaignScheduleSweep error:', e.message); }
}

// ── FEATURE: Zero-impression alert ─────────────────────────────────────────────
// Runs hourly. If a campaign has been active for 6+ hours with zero impressions
// (almost always a targeting mismatch — geo/time/IDE filters excluding everyone),
// emails the advertiser once so they don't silently think the product is broken.
async function runZeroImpressionAlertSweep() {
  if (!RESEND_API_KEY) return; // best-effort feature only — no email configured, nothing to do
  try {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const now = Date.now();
    let changed = false;
    for (const c of Object.values(db.campaigns)) {
      if (c.status !== 'active') continue;
      if (c.zeroImpressionAlertSentAt) continue; // already alerted once for this campaign
      if (now - c.createdAt < SIX_HOURS) continue;
      const hasImpressions = db.impressions.some(i => i.campaignId === c.id);
      if (hasImpressions) continue;

      const advertiser = db.users[c.advertiserId];
      if (!advertiser?.email) continue;

      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: LAUNCH_EMAIL_FROM,
          to: [advertiser.email],
          subject: `⚠️ Your campaign "${c.campaignName || c.adText.slice(0,30)}" hasn't served any impressions yet`,
          html: `<p>Hi ${advertiser.name || 'there'},</p>
            <p>Your campaign has been live for over 6 hours but hasn't shown to any developers yet. This is almost always caused by targeting that's too narrow — for example a country, time-of-day, or IDE filter that excludes everyone in your current audience.</p>
            <p><b>What to check:</b></p>
            <ul>
              <li>Geo targeting — is your selected country matching where your intended developers actually are?</li>
              <li>Time-of-day targeting — if set to a narrow window, try "all" temporarily</li>
              <li>Bid amount — bids below the recommended minimum may lose every auction</li>
            </ul>
            <p>Reply to this email or reach admin@waitjiai.in if you'd like us to take a look with you.</p>
            <p>— WaitJI AI Team</p>`,
        }),
      }).catch(() => {});

      c.zeroImpressionAlertSentAt = now;
      changed = true;
    }
    if (changed) saveDB();
  } catch (e) { console.error('runZeroImpressionAlertSweep error:', e.message); }
}

// ── FEATURE: Auto-payout scheduling ────────────────────────────────────────────
// Runs daily. For earners who've opted in (autoPayoutEnabled=true) and have a
// verified payout method, automatically creates AND approves a withdrawal once
// their available balance clears the minimum — no manual "request withdrawal"
// click needed. Reuses the exact same approval path (approveOneWithdrawal) as
// the admin's manual approve button, so Cashfree/PayPal payout logic is identical.
async function runAutoPayoutSweep() {
  try {
    let changed = false;
    for (const user of Object.values(db.users)) {
      if (user.role !== 'customer' || !user.autoPayoutEnabled) continue;
      if (!user.upiId && !user.bankAccount && !user.paypalEmail) continue;
      const ps = profileStatus(user);
      if (!ps.complete) continue;

      const hasPending = db.withdrawalRequests.some(r => r.userId === user.id && r.status === 'pending');
      if (hasPending) continue; // don't stack requests — let the existing one clear first

      const available = computeAvailableBalance(user.id);
      const minPaise = user.payoutMode === 'paypal' ? 85000 : 10000;
      if (available < minPaise) continue;

      const wr = {
        id: uid('wr_'), userId: user.id, userName: user.name || user.email, userEmail: user.email,
        upiId: user.upiId, amountPaise: available, status: 'pending',
        requestedAt: Date.now(), reviewedAt: null, reviewNote: null, autoRequested: true,
      };
      db.withdrawalRequests.push(wr);
      changed = true;
      await approveOneWithdrawal(wr, 'system-auto-payout', 'Auto-payout — requested and approved automatically per your settings.');
    }
    if (changed) saveDB();
  } catch (e) { console.error('runAutoPayoutSweep error:', e.message); }
}

// ── FEATURE: weekly performance report email ───────────────────────────────────
// Runs weekly. Sends every advertiser with at least one campaign a summary of
// the last 7 days — impressions, valid clicks, spend, CTR — so they don't have
// to remember to check the dashboard. This is the "inbox, not login" feature
// aimed at advertisers like agencies who won't check a dashboard on their own.
async function runWeeklyReportSweep() {
  if (!RESEND_API_KEY) return;
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const advertisers = Object.values(db.users).filter(u => u.role === 'advertiser');

    for (const adv of advertisers) {
      const camps = Object.values(db.campaigns).filter(c => c.advertiserId === adv.id);
      if (camps.length === 0) continue;
      const campIds = new Set(camps.map(c => c.id));
      const weekImps = db.impressions.filter(i => campIds.has(i.campaignId) && i.ts >= weekAgo);
      const weekClicks = db.clicks.filter(c => campIds.has(c.campaignId) && c.valid && c.ts >= weekAgo);
      if (weekImps.length === 0) continue; // nothing happened this week — don't send a noisy empty report

      const spentPaise = weekImps.reduce((s, i) => s + (i.costPaise || 0), 0) + weekClicks.reduce((s, c) => s + (c.costPaise || 0), 0);
      const ctr = weekImps.length ? ((weekClicks.length / weekImps.length) * 100).toFixed(2) : '0.00';
      const activeCampCount = camps.filter(c => c.status === 'active').length;

      if (!adv.email) continue;
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: LAUNCH_EMAIL_FROM,
          to: [adv.email],
          subject: `📊 Your WaitJI AI weekly report — ${weekImps.length} impressions this week`,
          html: `<p>Hi ${adv.name || 'there'},</p>
            <p>Here's how your campaigns performed over the last 7 days:</p>
            <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
              <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Impressions</td><td><b>${weekImps.length.toLocaleString('en-IN')}</b></td></tr>
              <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Valid clicks</td><td><b>${weekClicks.length}</b></td></tr>
              <tr><td style="padding:6px 12px 6px 0;color:#6B7185">CTR</td><td><b>${ctr}%</b></td></tr>
              <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Spend this week</td><td><b>₹${(spentPaise/100).toFixed(2)}</b></td></tr>
              <tr><td style="padding:6px 12px 6px 0;color:#6B7185">Active campaigns</td><td><b>${activeCampCount}</b></td></tr>
            </table>
            <p><a href="https://waitjiai.in/advertiser.html" style="background:#4F46E5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">View full dashboard →</a></p>
            <p style="color:#9198B8;font-size:12px;margin-top:20px">You're getting this because you have active or recent campaigns on WaitJI AI.</p>`,
        }),
      }).catch(() => {});
    }
  } catch (e) { console.error('runWeeklyReportSweep error:', e.message); }
}


(async () => {
  await loadDB();
  seed();
  // Background schedulers for the new automation features. Staggered slightly on
  // startup so they don't all fire in the same tick.
  runCampaignScheduleSweep();
  setInterval(runCampaignScheduleSweep, 5 * 60 * 1000);       // every 5 min
  setTimeout(() => { runZeroImpressionAlertSweep(); setInterval(runZeroImpressionAlertSweep, 60 * 60 * 1000); }, 30 * 1000); // hourly, first run after 30s
  setTimeout(() => { runAutoPayoutSweep(); setInterval(runAutoPayoutSweep, 24 * 60 * 60 * 1000); }, 60 * 1000); // daily, first run after 60s
  setTimeout(() => { runWeeklyReportSweep(); setInterval(runWeeklyReportSweep, 7 * 24 * 60 * 60 * 1000); }, 90 * 1000); // weekly, first run after 90s
  server.listen(PORT, () => console.log(`WaitJI AI API v3 running on port ${PORT} (storage: ${pgAvailable ? 'Postgres' : 'LOCAL DISK — NOT PERSISTENT'})`));
})();
