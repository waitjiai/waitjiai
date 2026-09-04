# WaitJI AI — Earn UPI income while Claude Code thinks

**India's first AI ad marketplace for VS Code developers.**

While Claude Code is processing your request (those 5–30 second pauses), WaitJI AI shows one quiet sponsored message — in the "Thinking…" spinner and terminal status line. You earn 65% of the ad revenue, paid directly to your UPI account or bank. Nothing about how you code changes.

---

## ⚡ Install in one command

Paste this in your Mac/Linux terminal:

```bash
curl -L https://waitjiai.in/vsix -o waitji.vsix && code --install-extension waitji.vsix
```

Or search **WaitJI AI** in the VS Code Extensions panel.

---

## 💰 Two ad placements — you earn from both

| Placement | Where it shows | Developer earns |
|---|---|---|
| **★ Spotlight** | Inside Claude Code's "Thinking…" spinner | ₹520 per 1,000 impressions |
| **◎ Stream** | Terminal status line during CLI sessions | ₹195 per 1,000 impressions |

Both run independently. Higher advertiser bids = more you earn.

---

## 🚀 How to get started

**Step 1 — Install the extension**

```bash
curl -L https://waitjiai.in/vsix -o waitji.vsix && code --install-extension waitji.vsix
```

**Step 2 — Create a free account**

Go to [waitjiai.in](https://www.waitjiai.in) → Sign up as Developer

**Step 3 — Connect your account**

Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → run:

```
WaitJI AI: Connect Your Account
```

Enter your User ID from your dashboard.

**Step 4 — Enable ad placements**

```
WaitJI AI: Enable Terminal Status Line Ads
```

Accept the prompt. Ads start appearing within ~90 seconds.

**Step 5 — Withdraw earnings**

Dashboard at [waitjiai.in/customer.html](https://www.waitjiai.in/customer.html) — minimum ₹100, paid to your UPI or bank account.

---

## 🔧 Commands

| Command | What it does |
|---|---|
| `WaitJI AI: Connect Your Account` | Link your WaitJI account using your User ID |
| `WaitJI AI: Enable Terminal Status Line Ads` | Activates both Spotlight + Stream placements |
| `WaitJI AI: Disable Terminal Status Line Ads (Restore)` | Fully removes all changes — restores original settings |
| `WaitJI AI: Show Earnings Dashboard` | View session stats + link to full dashboard |
| `WaitJI AI: Toggle Ads On/Off` | Temporarily pause or resume ads |
| `WaitJI AI: Open waitjiai.in` | Opens the website |

---

## ⚙️ Settings

| Setting | Description | Default |
|---|---|---|
| `waitjiAi.userId` | Your WaitJI AI User ID (from your dashboard) | — |
| `waitjiAi.showAds` | Show or hide sponsored messages | `true` |
| `waitjiAi.apiEndpoint` | API endpoint override (advanced, do not change) | Production URL |

---

## 🔒 Privacy

This extension does **not** read, transmit, or store your code, file contents, terminal output, or keystrokes.

What it does send:
- Your User ID (to credit earnings)
- A timestamp when Claude Code enters "thinking" state (to time impressions)

What it never reads:
- Your code or files
- Claude Code's responses
- Any terminal output

Full details: [waitjiai.in/privacy.html](https://www.waitjiai.in/privacy.html)

**The extension is fully reversible.** Run `WaitJI AI: Disable Terminal Status Line Ads (Restore)` at any time to revert your `~/.claude/settings.json` exactly to what it was before install.

---

## 🛡️ How we show ads (technically, for the curious)

WaitJI AI uses two **officially documented and intentionally exposed** Claude Code settings:

- `spinnerVerbs` — customizes the words in the "Thinking…" spinner (Claude Code's own feature, used by many extensions for Star Wars/Dune themes etc.)
- `statusLine` — a command Claude Code runs to populate the terminal status line

No Anthropic extension files are patched or modified. No VS Code internal files are modified.

---

## 💼 For Advertisers

Reach Indian developers during high-attention AI wait-states.

- **Spotlight:** ₹800 per 1,000 impressions — inside Claude Code's thinking spinner
- **Stream:** ₹300 per 1,000 impressions — terminal status line
- Live bidding, fraud protection, 24h campaign review
- Pay with Razorpay (UPI, cards, netbanking)

Start a campaign: [waitjiai.in](https://www.waitjiai.in) → Advertise

---

## 📬 Support & Contact

- **Issues / Support:** [admin@waitjiai.in](mailto:admin@waitjiai.in)
- **Advertise:** [sales@waitjiai.in](mailto:sales@waitjiai.in)
- **Website:** [waitjiai.in](https://www.waitjiai.in)
- **Privacy:** [waitjiai.in/privacy.html](https://www.waitjiai.in/privacy.html)
- **Terms:** [waitjiai.in/terms.html](https://www.waitjiai.in/terms.html)

---

## ℹ️ About

Built by **QivaLabs LLP**, Udaipur, Rajasthan, India
LLPIN: ACV-6746 · DPIIT: DIPP247112

Not affiliated with Anthropic (Claude) or Microsoft (VS Code). "Claude Code" and "VS Code" are used to describe compatibility only.

---

*WaitJI AI — Your editor was already open. Now it pays.*
