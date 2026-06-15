// AdWait.in Backend API
// Stack: Node.js + Express + SQLite (dev) / PostgreSQL (prod)
// Deploy: Railway / Render

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// ─── In-memory DB (swap for Postgres in prod) ─────────────────────────────
interface Campaign {
  id: string;
  advertiser: string;
  adText: string;
  url: string;
  bidPerKImpressionsPaise: number; // paise
  budgetPaise: number;
  spentPaise: number;
  targetingCategory: string;
  status: 'pending' | 'active' | 'paused' | 'exhausted';
  createdAt: number;
}

interface Impression {
  id: string;
  userId: string;
  adId: string;
  deviceId: string;
  timestamp: number;
  earnedPaise: number;
}

interface UserEarning {
  userId: string;
  totalPaise: number;
  pendingPaise: number;
  paidPaise: number;
  upiId: string;
}

const campaigns: Map<string, Campaign> = new Map();
const impressions: Impression[] = [];
const userEarnings: Map<string, UserEarning> = new Map();

// Seed demo campaigns
const demoCampaigns: Campaign[] = [
  {
    id: 'c1',
    advertiser: 'Razorpay',
    adText: 'Razorpay · India ka #1 payment gateway',
    url: 'https://razorpay.com',
    bidPerKImpressionsPaise: 12000,
    budgetPaise: 500000,
    spentPaise: 124000,
    targetingCategory: 'all',
    status: 'active',
    createdAt: Date.now() - 86400000,
  },
  {
    id: 'c2',
    advertiser: 'Zerodha',
    adText: 'Zerodha Kite · Commission-free trading',
    url: 'https://zerodha.com',
    bidPerKImpressionsPaise: 9500,
    budgetPaise: 300000,
    spentPaise: 81000,
    targetingCategory: 'all',
    status: 'active',
    createdAt: Date.now() - 72000000,
  },
  {
    id: 'c3',
    advertiser: 'AWS India',
    adText: 'AWS India · ₹28,000 free credits pao',
    url: 'https://aws.amazon.com/in',
    bidPerKImpressionsPaise: 8000,
    budgetPaise: 200000,
    spentPaise: 52000,
    targetingCategory: 'backend',
    status: 'active',
    createdAt: Date.now() - 36000000,
  },
];
demoCampaigns.forEach(c => campaigns.set(c.id, c));

// ─── Middleware ───────────────────────────────────────────────────────────────
const apiKey = (req: Request, res: Response, next: NextFunction) => {
  // For advertiser portal routes — check X-API-Key header
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ─── PUBLIC ROUTES (Extension calls these) ────────────────────────────────────

// GET /v1/ads/active — Return sorted active ads for extension
app.get('/v1/ads/active', (req: Request, res: Response) => {
  const active = Array.from(campaigns.values())
    .filter(c => c.status === 'active' && c.spentPaise < c.budgetPaise)
    .sort((a, b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise)
    .slice(0, 10)
    .map(c => ({
      id: c.id,
      text: c.adText,
      url: c.url,
      advertiser: c.advertiser,
      cpmPaise: c.bidPerKImpressionsPaise,
    }));

  res.json({ ads: active, servedAt: Date.now() });
});

// POST /v1/impression — Record an ad impression from extension
app.post('/v1/impression', (req: Request, res: Response) => {
  const { userId, adId, deviceId, timestamp } = req.body;

  if (!adId || !deviceId) {
    return res.status(400).json({ error: 'adId and deviceId required' });
  }

  const campaign = campaigns.get(adId);
  if (!campaign || campaign.status !== 'active') {
    return res.status(404).json({ error: 'Ad not found or inactive' });
  }

  // Calculate earnings (50% to developer)
  const costPaise = Math.floor(campaign.bidPerKImpressionsPaise / 1000);
  const earnPaise = Math.floor(costPaise / 2);

  // Record impression
  const imp: Impression = {
    id: crypto.randomUUID(),
    userId: userId || 'anonymous',
    adId,
    deviceId,
    timestamp: timestamp || Date.now(),
    earnedPaise: earnPaise,
  };
  impressions.push(imp);

  // Update campaign spend
  campaign.spentPaise += costPaise;
  if (campaign.spentPaise >= campaign.budgetPaise) {
    campaign.status = 'exhausted';
  }

  // Update user earnings
  if (userId && userId !== 'anonymous') {
    const existing = userEarnings.get(userId) ?? {
      userId,
      totalPaise: 0,
      pendingPaise: 0,
      paidPaise: 0,
      upiId: '',
    };
    existing.totalPaise += earnPaise;
    existing.pendingPaise += earnPaise;
    userEarnings.set(userId, existing);
  }

  res.json({
    success: true,
    impressionId: imp.id,
    earnedPaise: earnPaise,
    earnedRupees: (earnPaise / 100).toFixed(4),
  });
});

// POST /v1/click — Record ad click (billed at 50x CPM rate)
app.post('/v1/click', (req: Request, res: Response) => {
  const { userId, adId, deviceId } = req.body;
  if (!adId || !deviceId) return res.status(400).json({ error: 'Missing fields' });

  const campaign = campaigns.get(adId);
  if (!campaign) return res.status(404).json({ error: 'Ad not found' });

  // CPC = 50x CPM rate
  const clickCostPaise = campaign.bidPerKImpressionsPaise * 50;
  const earnPaise = Math.floor(clickCostPaise / 2);

  if (userId && userId !== 'anonymous') {
    const existing = userEarnings.get(userId) ?? { userId, totalPaise: 0, pendingPaise: 0, paidPaise: 0, upiId: '' };
    existing.totalPaise += earnPaise;
    existing.pendingPaise += earnPaise;
    userEarnings.set(userId, existing);
  }

  // Return the destination URL so extension can open it
  res.json({ success: true, earnedPaise: earnPaise, redirectUrl: campaign.url });
});

// GET /v1/user/:userId/earnings
app.get('/v1/user/:userId/earnings', (req: Request, res: Response) => {
  const { userId } = req.params;
  const earning = userEarnings.get(userId);
  if (!earning) return res.json({ userId, totalPaise: 0, pendingPaise: 0, paidPaise: 0 });
  res.json(earning);
});

// ─── ADVERTISER PORTAL ROUTES (need API key) ─────────────────────────────────

// GET /v1/campaigns — List all campaigns
app.get('/v1/campaigns', apiKey, (req: Request, res: Response) => {
  const list = Array.from(campaigns.values())
    .sort((a, b) => b.bidPerKImpressionsPaise - a.bidPerKImpressionsPaise);
  res.json({ campaigns: list, total: list.length });
});

// POST /v1/campaigns — Create new campaign
app.post('/v1/campaigns', apiKey, (req: Request, res: Response) => {
  const { advertiser, adText, url, bidPerKImpressionsPaise, budgetPaise, targetingCategory } = req.body;

  if (!advertiser || !adText || !url || !bidPerKImpressionsPaise || !budgetPaise) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (adText.length > 60) {
    return res.status(400).json({ error: 'adText max 60 characters' });
  }

  const campaign: Campaign = {
    id: crypto.randomUUID(),
    advertiser,
    adText,
    url,
    bidPerKImpressionsPaise: parseInt(bidPerKImpressionsPaise),
    budgetPaise: parseInt(budgetPaise),
    spentPaise: 0,
    targetingCategory: targetingCategory ?? 'all',
    status: 'pending', // Manual review → active
    createdAt: Date.now(),
  };

  campaigns.set(campaign.id, campaign);
  res.status(201).json({ campaign, message: 'Campaign created. Review ke baad 1-2 ghante mein live hoga.' });
});

// PATCH /v1/campaigns/:id — Update campaign status / bid
app.patch('/v1/campaigns/:id', apiKey, (req: Request, res: Response) => {
  const { id } = req.params;
  const campaign = campaigns.get(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { status, bidPerKImpressionsPaise, budgetPaise } = req.body;
  if (status) campaign.status = status;
  if (bidPerKImpressionsPaise) campaign.bidPerKImpressionsPaise = parseInt(bidPerKImpressionsPaise);
  if (budgetPaise) campaign.budgetPaise = parseInt(budgetPaise);

  res.json({ campaign });
});

// GET /v1/stats — Platform-wide stats
app.get('/v1/stats', apiKey, (req: Request, res: Response) => {
  const totalImpressions = impressions.length;
  const totalSpentPaise = impressions.reduce((s, i) => s + i.earnedPaise * 2, 0);
  const totalEarnedPaise = impressions.reduce((s, i) => s + i.earnedPaise, 0);
  const activeCampaigns = Array.from(campaigns.values()).filter(c => c.status === 'active').length;

  res.json({
    totalImpressions,
    activeCampaigns,
    totalSpentRupees: (totalSpentPaise / 100).toFixed(2),
    totalEarnedByDevsRupees: (totalEarnedPaise / 100).toFixed(2),
    uniqueDevices: new Set(impressions.map(i => i.deviceId)).size,
  });
});

// POST /v1/withdraw — Process withdrawal request
app.post('/v1/withdraw', apiKey, (req: Request, res: Response) => {
  const { userId, upiId } = req.body;
  const earning = userEarnings.get(userId);

  if (!earning || earning.pendingPaise < 10000) { // Min ₹100
    return res.status(400).json({ error: 'Minimum ₹100 required for withdrawal' });
  }

  // In prod: trigger Razorpay Payout API here
  const amountPaise = earning.pendingPaise;
  earning.paidPaise += amountPaise;
  earning.pendingPaise = 0;
  if (upiId) earning.upiId = upiId;

  res.json({
    success: true,
    withdrawnRupees: (amountPaise / 100).toFixed(2),
    message: `₹${(amountPaise / 100).toFixed(2)} aapke UPI (${upiId}) pe 2-3 din mein pahunchega.`,
    // In prod: include Razorpay payout_id here
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0', platform: 'AdWait.in' }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`AdWait.in API running on :${PORT}`);
  console.log(`Campaigns loaded: ${campaigns.size}`);
});

export default app;
