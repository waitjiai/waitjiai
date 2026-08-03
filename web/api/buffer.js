/**
 * WaitJI AI — Buffer GraphQL API Proxy
 * New Buffer API (2026) uses GraphQL at https://api.buffer.com
 * Deploy to: waitjiai.in/api/buffer.js (Vercel)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No token' });

  const { action } = req.query;

  const gql = async (query, variables = {}) => {
    const r = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables })
    });
    const data = await r.json();
    if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
    return data.data;
  };

  try {

    // ── GET CHANNELS ─────────────────────────────────────────
    if (action === 'channels') {
      const data = await gql(`
        query GetChannels {
          account {
            organizations {
              id
              name
              channels {
                id
                name
                service
                serviceId
                avatar
              }
            }
          }
        }
      `);
      // Flatten all channels from all orgs
      const channels = [];
      data?.account?.organizations?.forEach(org => {
        (org.channels || []).forEach(ch => {
          channels.push({
            id: ch.id,
            service: ch.service,
            username: ch.name,
            formatted_username: ch.name,
            formatted_service: ch.service,
            avatar: ch.avatar,
            organizationId: org.id,
          });
        });
      });
      return res.status(200).json(channels);
    }

    // ── GET ORG ID (needed for creating posts) ────────────────
    if (action === 'org') {
      const data = await gql(`
        query { account { organizations { id name } } }
      `);
      const orgs = data?.account?.organizations || [];
      return res.status(200).json(orgs);
    }

    // ── CREATE POST ───────────────────────────────────────────
    if (action === 'create' && req.method === 'POST') {
      const { text, channel_ids, scheduled_at } = req.body;
      if (!text || !channel_ids?.length) {
        return res.status(400).json({ error: 'text and channel_ids required' });
      }

      const variables = {
        input: {
          text,
          channelIds: channel_ids,
          ...(scheduled_at ? { scheduledAt: scheduled_at } : {})
        }
      };

      const data = await gql(`
        mutation CreatePost($input: PostInput!) {
          createPost(input: $input) {
            id
            status
            text
            scheduledAt
          }
        }
      `, variables);

      return res.status(200).json(data?.createPost || { success: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('Buffer proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
