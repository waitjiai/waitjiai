/**
 * lib/ops.js — Developer/Technician panel backend logic.
 *
 * DESIGN NOTE (important, read before changing): the Sept 9/11 incidents both
 * came from re-shipping the ENTIRE app-state blob on every write. This module
 * deliberately does NOT repeat that pattern:
 *   - Every 15 min: a LIGHTWEIGHT snapshot (just counts + sizes, a few
 *     hundred bytes) — cheap enough to run forever.
 *   - Once every 24h: a FULL blob backup (the actual db JSON) — expensive,
 *     so it's rate-limited to once/day and old ones are pruned.
 * This gives you point-in-time visibility (via lightweight snapshots) AND a
 * real daily restore point (via full backups), without recreating the
 * bandwidth problem that caused the original outage.
 */

async function ensureOpsTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_snapshots (
      id BIGSERIAL PRIMARY KEY,
      taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind TEXT NOT NULL CHECK (kind IN ('light', 'full')),
      user_count INT,
      campaign_count INT,
      withdrawal_count INT,
      size_bytes INT,
      data JSONB  -- only populated for kind='full'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ops_snapshots_taken_at ON ops_snapshots (taken_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_error_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      route TEXT,
      method TEXT,
      message TEXT,
      stack TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ops_error_log_ts ON ops_error_log (ts)`);
}

// ── Snapshots ────────────────────────────────────────────────────────────
async function takeLightSnapshot(pool, db) {
  const userCount = Object.keys(db.users || {}).length;
  const campaignCount = Object.keys(db.campaigns || {}).length;
  const withdrawalCount = (db.withdrawalRequests || []).length;
  await pool.query(
    `INSERT INTO ops_snapshots (kind, user_count, campaign_count, withdrawal_count, size_bytes)
     VALUES ('light', $1, $2, $3, NULL)`,
    [userCount, campaignCount, withdrawalCount]
  );
}

async function takeFullSnapshot(pool, db) {
  const json = JSON.stringify(db);
  const userCount = Object.keys(db.users || {}).length;
  const campaignCount = Object.keys(db.campaigns || {}).length;
  const withdrawalCount = (db.withdrawalRequests || []).length;
  await pool.query(
    `INSERT INTO ops_snapshots (kind, user_count, campaign_count, withdrawal_count, size_bytes, data)
     VALUES ('full', $1, $2, $3, $4, $5)`,
    [userCount, campaignCount, withdrawalCount, Buffer.byteLength(json), json]
  );
  // Prune: keep only the last 14 full backups — this is the expensive kind.
  await pool.query(`
    DELETE FROM ops_snapshots WHERE kind = 'full' AND id NOT IN (
      SELECT id FROM ops_snapshots WHERE kind = 'full' ORDER BY taken_at DESC LIMIT 14
    )
  `);
}

async function pruneLightSnapshots(pool) {
  // Keep 30 days of lightweight snapshots (every 15 min ≈ 2880/day — plenty for trend graphs).
  await pool.query(`DELETE FROM ops_snapshots WHERE kind = 'light' AND taken_at < now() - interval '30 days'`);
}

/**
 * Call this once at boot, then on an interval. Handles both the frequent
 * light snapshot and the once-a-day full backup internally, so callers only
 * need a single 15-min interval.
 */
async function runSnapshotTick(pool, db) {
  try {
    await takeLightSnapshot(pool, db);
    const { rows } = await pool.query(
      `SELECT taken_at FROM ops_snapshots WHERE kind = 'full' ORDER BY taken_at DESC LIMIT 1`
    );
    const last = rows[0] ? new Date(rows[0].taken_at).getTime() : 0;
    if (Date.now() - last > 23 * 60 * 60 * 1000) {
      await takeFullSnapshot(pool, db);
    }
    await pruneLightSnapshots(pool);
  } catch (e) {
    console.error('ops snapshot tick failed:', e.message);
  }
}

async function getSnapshotSummary(pool) {
  const { rows: light } = await pool.query(
    `SELECT taken_at, user_count, campaign_count, withdrawal_count FROM ops_snapshots
     WHERE kind = 'light' ORDER BY taken_at DESC LIMIT 50`
  );
  const { rows: full } = await pool.query(
    `SELECT id, taken_at, user_count, campaign_count, size_bytes FROM ops_snapshots
     WHERE kind = 'full' ORDER BY taken_at DESC LIMIT 14`
  );
  return { recentLight: light, fullBackups: full };
}

/** Restore db from a specific full snapshot id — returns the parsed JSON, caller decides what to do with it. */
async function loadFullSnapshot(pool, snapshotId) {
  const { rows } = await pool.query(`SELECT data FROM ops_snapshots WHERE id = $1 AND kind = 'full'`, [snapshotId]);
  if (!rows.length) return null;
  return rows[0].data;
}

// ── Error log ────────────────────────────────────────────────────────────
async function logError(pool, { route, method, message, stack }) {
  try {
    await pool.query(
      `INSERT INTO ops_error_log (route, method, message, stack) VALUES ($1, $2, $3, $4)`,
      [route || null, method || null, (message || '').slice(0, 2000), (stack || '').slice(0, 4000)]
    );
    // keep table bounded — cheap periodic trim
    await pool.query(`DELETE FROM ops_error_log WHERE id NOT IN (SELECT id FROM ops_error_log ORDER BY ts DESC LIMIT 2000)`);
  } catch (e) {
    console.error('ops logError failed (non-fatal):', e.message);
  }
}

async function getRecentErrors(pool, limit = 30) {
  const { rows } = await pool.query(`SELECT id, ts, route, method, message FROM ops_error_log ORDER BY ts DESC LIMIT $1`, [limit]);
  return rows;
}

// ── Health checks ────────────────────────────────────────────────────────
async function checkHealth({ pool, supabaseUrl, supabaseServiceKey, requiredEnvVars }) {
  const checks = [];

  // 1. Postgres / Neon reachability
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.push({ name: 'Neon Postgres', status: 'up', detail: `responded in ${Date.now() - start}ms` });
  } catch (e) {
    checks.push({ name: 'Neon Postgres', status: 'down', detail: e.message });
  }

  // 2. Supabase Auth reachability
  // NOTE: /auth/v1/health is not available on all Supabase project versions
  // and can 404 even when Auth is fully healthy. /auth/v1/settings is the
  // stable, always-present GoTrue endpoint — use that instead.
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: supabaseServiceKey || '' } });
    checks.push({ name: 'Supabase Auth', status: r.ok ? 'up' : 'degraded', detail: `HTTP ${r.status}` });
  } catch (e) {
    checks.push({ name: 'Supabase Auth', status: 'down', detail: e.message });
  }

  // 3. Required env vars present (catches the exact "silent bad config" class of bug)
  const missing = (requiredEnvVars || []).filter(k => !process.env[k]);
  checks.push({
    name: 'Required environment variables',
    status: missing.length ? 'down' : 'up',
    detail: missing.length ? `Missing: ${missing.join(', ')}` : 'All present',
  });

  return checks;
}

// ── AI summary (optional — only runs if OPENAI_API_KEY is set) ────────
let lastAISummary = null;
let lastAISummaryAt = 0;
const AI_SUMMARY_MIN_INTERVAL_MS = 5 * 60 * 1000; // don't burn tokens more than once per 5 min

async function getAISummary({ apiKey, health, errors, force }) {
  if (!apiKey) return { text: 'AI summary disabled — set OPENAI_API_KEY to enable.', cached: false };
  if (!force && lastAISummary && Date.now() - lastAISummaryAt < AI_SUMMARY_MIN_INTERVAL_MS) {
    return { text: lastAISummary, cached: true };
  }
  const prompt = `You are a terse on-call SRE assistant for a small Node/Postgres backend called WaitJI AI. Given this health-check output and recent error log, write a 2-4 sentence plain-English status summary a non-technical founder can read at a glance. Call out anything genuinely broken; say "all clear" if nothing is wrong. Do not pad with pleasantries.

HEALTH CHECKS:
${JSON.stringify(health, null, 2)}

RECENT ERRORS (last ${errors.length}):
${JSON.stringify(errors.slice(0, 10), null, 2)}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    lastAISummary = text || 'No summary generated.';
    lastAISummaryAt = Date.now();
    return { text: lastAISummary, cached: false };
  } catch (e) {
    return { text: `AI summary failed: ${e.message}`, cached: false };
  }
}

module.exports = {
  ensureOpsTables,
  runSnapshotTick,
  getSnapshotSummary,
  loadFullSnapshot,
  logError,
  getRecentErrors,
  checkHealth,
  getAISummary,
};
