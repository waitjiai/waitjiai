#!/usr/bin/env node
/**
 * backfill-users-from-supabase.js
 *
 * PROBLEM: The Sept 9 incident (see server.js line ~352 comment) overwrote
 * the kv_store blob with a near-empty db.users, wiping ~87 real profiles.
 * The real identities are safe in Supabase Auth (127 confirmed there) — only
 * the app-side profile (role, name, createdAt, etc.) is missing. The existing
 * /v1/auth/exchange route WOULD recreate each profile automatically, but only
 * the next time that specific user logs in / the extension reconnects — too
 * slow to rely on before a deadline.
 *
 * WHAT THIS DOES: fetches every user from Supabase Auth (paginated, via the
 * admin API + service_role key), and for each one NOT already present in
 * db.users, inserts a minimal profile — the same shape /v1/auth/exchange
 * would have created on first login. Existing profiles are left untouched
 * (no overwrite of real data that already made it back in).
 *
 * SAFE BY DESIGN:
 *   - Read-only against Supabase (GET only).
 *   - Only ADDS missing users to db.users, never deletes or overwrites.
 *   - Prints a dry-run diff first; only writes to Postgres with --commit.
 *   - Uses the same catastrophic-loss-guarded save path conceptually, but
 *     since this only ever increases user count, that guard is a non-issue.
 *
 * USAGE:
 *   node backfill-users-from-supabase.js              # dry run, prints plan
 *   node backfill-users-from-supabase.js --commit      # actually writes
 *
 * REQUIRED ENV: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tqfjdhneycntoasahstt.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMMIT = process.argv.includes('--commit');

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required.');
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_KEY is required (Supabase dashboard → Settings → API → service_role key).');
  process.exit(1);
}

async function fetchAllSupabaseUsers() {
  let page = 1;
  const perPage = 200;
  const all = [];
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Supabase admin users fetch failed (${r.status}): ${text}`);
    }
    const data = await r.json();
    const users = data.users || data; // API shape varies slightly by version
    if (!users || !users.length) break;
    all.push(...users);
    if (users.length < perPage) break;
    page++;
  }
  return all;
}

function buildMinimalProfile(sbUser) {
  const profileId = 'sb_' + sbUser.id;
  const meta = sbUser.user_metadata || {};
  return {
    id: profileId,
    supabaseId: sbUser.id,
    email: sbUser.email,
    phone: sbUser.phone || null,
    role: meta.role === 'advertiser' ? 'advertiser' : 'customer',
    name: meta.name || meta.full_name || meta.user_name || '',
    company: meta.company || '',
    avatarUrl: meta.avatar_url || meta.picture || null,
    upiId: meta.upiId || '',
    provider: (sbUser.app_metadata && sbUser.app_metadata.provider) || 'email',
    emailVerified: !!sbUser.email_confirmed_at,
    phoneVerified: !!sbUser.phone_confirmed_at,
    createdAt: sbUser.created_at ? new Date(sbUser.created_at).getTime() : Date.now(),
    banned: false,
    loginCount: 0,
    _backfilled: true,          // marks this row so you can identify backfilled profiles later
    _backfilledAt: Date.now(),
  };
}

async function main() {
  console.log(COMMIT ? '=== RUNNING IN COMMIT MODE ===' : '=== DRY RUN (pass --commit to write) ===');

  console.log('Fetching all users from Supabase Auth...');
  const sbUsers = await fetchAllSupabaseUsers();
  console.log(`Found ${sbUsers.length} users in Supabase Auth.`);

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(`SELECT value FROM kv_store WHERE key = 'db'`);
  if (!rows.length) {
    console.error('FATAL: no kv_store row found — nothing to backfill into.');
    process.exit(1);
  }
  const db = rows[0].value;
  db.users ||= {};

  const before = Object.keys(db.users).length;
  console.log(`Current db.users in Postgres: ${before}`);

  const toAdd = [];
  for (const sbUser of sbUsers) {
    const profileId = 'sb_' + sbUser.id;
    if (!db.users[profileId]) {
      toAdd.push(buildMinimalProfile(sbUser));
    }
  }

  console.log(`\nMissing profiles to backfill: ${toAdd.length}`);
  toAdd.slice(0, 10).forEach(u => console.log(`  + ${u.email} (${u.id})`));
  if (toAdd.length > 10) console.log(`  ... and ${toAdd.length - 10} more`);

  if (!toAdd.length) {
    console.log('\nNothing to do — every Supabase user already has a profile.');
    await pool.end();
    return;
  }

  if (!COMMIT) {
    console.log(`\nDry run complete. Re-run with --commit to write ${toAdd.length} profiles into Postgres.`);
    await pool.end();
    return;
  }

  for (const u of toAdd) db.users[u.id] = u;

  await pool.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ('db', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(db)]
  );

  console.log(`\nDone. db.users: ${before} -> ${before + toAdd.length}`);
  await pool.end();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
