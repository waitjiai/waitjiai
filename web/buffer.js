/**
 * WaitJI AI — Buffer API Proxy
 * Deploy this to Vercel as /api/buffer.js
 * Handles CORS so the marketing agent can call Buffer from browser
 */

export default async function handler(req, res) {
  // ── CORS headers ──────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;
  const token = req.headers.authorization?.replace('Bearer ', '') || req.body?.token;

  if (!token) {
    return res.status(401).json({ error: 'No Buffer token provided' });
  }

  try {
    // ── GET PROFILES ─────────────────────────────────────────
    if (action === 'profiles' && req.method === 'GET') {
      const r = await fetch('https://api.buffer.com/1/profiles.json', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      });

      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }

      const data = await r.json();
      return res.status(200).json(data);
    }

    // ── CREATE UPDATE (queue post) ────────────────────────────
    if (action === 'create' && req.method === 'POST') {
      const { text, profile_ids, scheduled_at, now } = req.body;

      if (!text || !profile_ids?.length) {
        return res.status(400).json({ error: 'text and profile_ids required' });
      }

      const body = new URLSearchParams();
      body.append('text', text);
      profile_ids.forEach(id => body.append('profile_ids[]', id));

      if (scheduled_at && !now) {
        body.append('scheduled_at', scheduled_at);
        body.append('now', 'false');
      } else {
        body.append('now', 'true');
      }

      const r = await fetch('https://api.buffer.com/1/updates/create.json', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString()
      });

      const data = await r.json();
      if (!r.ok || data.code) {
        return res.status(r.status).json({ error: data.message || 'Buffer API error', data });
      }

      return res.status(200).json(data);
    }

    // ── GET QUEUE (check scheduled posts) ────────────────────
    if (action === 'queue' && req.method === 'GET') {
      const { profile_id } = req.query;
      const r = await fetch(`https://api.buffer.com/1/profiles/${profile_id}/updates/pending.json`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('Buffer proxy error:', e);
    return res.status(500).json({ error: e.message });
  }
}
