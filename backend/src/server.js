const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// In-memory store
const campaigns = new Map();
const impressions = [];
const userEarnings = new Map();

// Seed demo campaigns
const demoCampaigns = [
  { id: 'c1', advertiser: 'Razorpay', adText: 'Razorpay · India ka #1 payment gateway', url: 'https://razorpay.com', bidPerKImpressionsPaise: 12000, budgetPaise: 500000, spentPaise: 0, status: 'active' },
  { id: 'c2', advertiser: 'Zerodha', adText: 'Zerodha Kite · Commission-free trading', url: 'https://zerodha.com', bidPerKImpressionsPaise: 9500, budgetPaise: 300000, spentPaise: 0, status: 'active' },
  { id: 'c3', advertiser: 'AWS India', adText: 'AWS India · Free credits pao', url: 'https://aws.amazon.com/in', bidPerKImpressionsPaise: 8000, budgetPaise: 200000, spentPaise: 0, status: 'active' },
];
demoCampaigns.forEach(c => campaigns.set(c.id, c));

// GET active ads
app.get('/v1/ads/active', (req, res) => {
  const active = Array.from(campaigns.values())
    .filter(c => c.status === 'active')
    .sort((a, b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise)
    .slice(0, 10)
    .map(c => ({ id: c.id, text: c.adText, url: c.url, advertiser: c.advertiser, cpmPaise: c.bidPerKImpressionsPaise }));
  res.json({ ads: active, servedAt: Date.now() });
});

// POST impression
app.post('/v1/impression', (req, res) => {
  const { userId, adId, deviceId } = req.body;
  const campaign = campaigns.get(adId);
  if (!campaign) return res.status(404).json({ error: 'Ad not found' });

  const earnPaise = Math.floor(campaign.bidPerKImpressionsPaise / 1000 / 2);
  impressions.push({ id: crypto.randomUUID(), userId: userId || 'anon', adId, deviceId, earnedPaise: earnPaise, timestamp: Date.now() });

  if (userId && userId !== 'anon') {
    const e = userEarnings.get(userId) || { userId, totalPaise: 0, pendingPaise: 0, paidPaise: 0 };
    e.totalPaise += earnPaise;
    e.pendingPaise += earnPaise;
    userEarnings.set(userId, e);
  }
  res.json({ success: true, earnedPaise, earnedRupees: (earnPaise / 100).toFixed(4) });
});

// GET campaigns
app.get('/v1/campaigns', (req, res) => {
  const list = Array.from(campaigns.values()).sort((a, b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise);
  res.json({ campaigns: list });
});

// POST new campaign
app.post('/v1/campaigns', (req, res) => {
  const { advertiser, adText, url, bidPerKImpressionsPaise, budgetPaise } = req.body;
  if (!advertiser || !adText || !url) return res.status(400).json({ error: 'Missing fields' });
  const campaign = { id: crypto.randomUUID(), advertiser, adText, url, bidPerKImpressionsPaise: parseInt(bidPerKImpressionsPaise), budgetPaise: parseInt(budgetPaise), spentPaise: 0, status: 'pending', createdAt: Date.now() };
  campaigns.set(campaign.id, campaign);
  res.status(201).json({ campaign });
});

// GET user earnings
app.get('/v1/user/:userId/earnings', (req, res) => {
  const e = userEarnings.get(req.params.userId);
  res.json(e || { userId: req.params.userId, totalPaise: 0, pendingPaise: 0 });
});

// GET stats
app.get('/v1/stats', (req, res) => {
  res.json({
    totalImpressions: impressions.length,
    activeCampaigns: Array.from(campaigns.values()).filter(c => c.status === 'active').length,
    totalEarnedByDevsRupees: (impressions.reduce((s, i) => s + i.earnedPaise, 0) / 100).toFixed(2),
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '0.1.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`WaitJai API running on :${PORT}`));
