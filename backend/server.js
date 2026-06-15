const http = require('http');
const crypto = require('crypto');

// ── In-memory store ──────────────────────────────────────────────────────────
const campaigns = new Map([
  ['c1', { id:'c1', advertiser:'Razorpay', adText:'Razorpay · India ka #1 payment gateway', url:'https://razorpay.com', bidPerKImpressionsPaise:12000, budgetPaise:500000, spentPaise:0, status:'active' }],
  ['c2', { id:'c2', advertiser:'Zerodha',  adText:'Zerodha Kite · Commission-free trading', url:'https://zerodha.com',  bidPerKImpressionsPaise:9500,  budgetPaise:300000, spentPaise:0, status:'active' }],
  ['c3', { id:'c3', advertiser:'AWS India', adText:'AWS India · Free credits pao',           url:'https://aws.amazon.com/in', bidPerKImpressionsPaise:8000, budgetPaise:200000, spentPaise:0, status:'active' }],
]);
const impressions  = [];
const userEarnings = new Map();

// ── Router ───────────────────────────────────────────────────────────────────
function router(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSON helper
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // Body parser
  const body = () => new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    return json(200, { status:'ok', version:'1.0.0', port: process.env.PORT });
  }

  if (method === 'GET' && url === '/') {
    return json(200, { message:'WaitJai API is running!', endpoints:['/health','/v1/ads/active','/v1/impression','/v1/campaigns','/v1/stats'] });
  }

  if (method === 'GET' && url === '/v1/ads/active') {
    const ads = [...campaigns.values()]
      .filter(c => c.status === 'active')
      .sort((a,b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise)
      .map(c => ({ id:c.id, text:c.adText, url:c.url, advertiser:c.advertiser, cpmPaise:c.bidPerKImpressionsPaise }));
    return json(200, { ads, servedAt:Date.now() });
  }

  if (method === 'POST' && url === '/v1/impression') {
    return body().then(b => {
      const campaign = campaigns.get(b.adId);
      if (!campaign) return json(404, { error:'Ad not found' });
      const earnPaise = Math.floor(campaign.bidPerKImpressionsPaise / 1000 / 2);
      impressions.push({ id:crypto.randomUUID(), userId:b.userId||'anon', adId:b.adId, earnedPaise:earnPaise, ts:Date.now() });
      if (b.userId && b.userId !== 'anon') {
        const e = userEarnings.get(b.userId) || { totalPaise:0, pendingPaise:0 };
        e.totalPaise += earnPaise; e.pendingPaise += earnPaise;
        userEarnings.set(b.userId, e);
      }
      json(200, { success:true, earnedPaise, earnedRupees:(earnPaise/100).toFixed(4) });
    });
  }

  if (method === 'GET' && url === '/v1/campaigns') {
    return json(200, { campaigns:[...campaigns.values()].sort((a,b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise) });
  }

  if (method === 'POST' && url === '/v1/campaigns') {
    return body().then(b => {
      if (!b.advertiser || !b.adText || !b.url) return json(400, { error:'Missing fields' });
      const c = { id:crypto.randomUUID(), ...b, spentPaise:0, status:'pending', createdAt:Date.now() };
      campaigns.set(c.id, c);
      json(201, { campaign:c });
    });
  }

  if (method === 'GET' && url.startsWith('/v1/user/')) {
    const userId = url.split('/')[3];
    const e = userEarnings.get(userId) || { totalPaise:0, pendingPaise:0 };
    return json(200, { userId, ...e });
  }

  if (method === 'GET' && url === '/v1/stats') {
    return json(200, {
      totalImpressions: impressions.length,
      activeCampaigns:  [...campaigns.values()].filter(c => c.status==='active').length,
      totalEarnedByDevsRupees: (impressions.reduce((s,i) => s+i.earnedPaise, 0)/100).toFixed(2),
    });
  }

  json(404, { error:'Route not found', url });
}

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
const server = http.createServer(router);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WaitJai API running on 0.0.0.0:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

server.on('error', err => {
  console.error('Server error:', err.message);
  process.exit(1);
});
