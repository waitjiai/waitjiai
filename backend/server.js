const http = require('http');
const crypto = require('crypto');

const campaigns = new Map([
  ['c1', { id:'c1', advertiser:'Razorpay', adText:'Razorpay · India ka #1 payment gateway', url:'https://razorpay.com', bidPerKImpressionsPaise:12000, budgetPaise:500000, spentPaise:0, status:'active' }],
  ['c2', { id:'c2', advertiser:'Zerodha', adText:'Zerodha Kite · Commission-free trading', url:'https://zerodha.com', bidPerKImpressionsPaise:9500, budgetPaise:300000, spentPaise:0, status:'active' }],
  ['c3', { id:'c3', advertiser:'AWS India', adText:'AWS India · Free credits pao', url:'https://aws.amazon.com/in', bidPerKImpressionsPaise:8000, budgetPaise:200000, spentPaise:0, status:'active' }],
]);
const impressions = [];
const userEarnings = new Map();

function router(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = () => new Promise(resolve => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); });

  if (method === 'GET' && url === '/') return json(200, { message:'WaitJai API is running!', status:'ok' });
  if (method === 'GET' && url === '/health') return json(200, { status:'ok', version:'1.0.0' });
  if (method === 'GET' && url === '/v1/ads/active') {
    const ads = [...campaigns.values()].filter(c => c.status === 'active').sort((a,b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise).map(c => ({ id:c.id, text:c.adText, url:c.url, advertiser:c.advertiser, cpmPaise:c.bidPerKImpressionsPaise }));
    return json(200, { ads, servedAt:Date.now() });
  }
  if (method === 'POST' && url === '/v1/impression') {
    return body().then(b => {
      const campaign = campaigns.get(b.adId);
      if (!campaign) return json(404, { error:'Ad not found' });
      const earnPaise = Math.floor(campaign.bidPerKImpressionsPaise / 1000 / 2);
      impressions.push({ id:crypto.randomUUID(), userId:b.userId||'anon', adId:b.adId, earnedPaise:earnPaise, ts:Date.now() });
      json(200, { success:true, earnedPaise, earnedRupees:(earnPaise/100).toFixed(4) });
    });
  }
  if (method === 'GET' && url === '/v1/campaigns') return json(200, { campaigns:[...campaigns.values()] });
  if (method === 'GET' && url === '/v1/stats') return json(200, { totalImpressions:impressions.length, activeCampaigns:[...campaigns.values()].filter(c=>c.status==='active').length });
  json(404, { error:'Not found', url });
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(router);
server.listen(PORT, '0.0.0.0', () => console.log(`WaitJai API running on port ${PORT}`));
server.on('error', err => { console.error('Server error:', err.message); process.exit(1); });
