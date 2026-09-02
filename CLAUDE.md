# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WaitJI AI ("WaitJI AI") — an ad marketplace that pays Indian/international developers (in UPI/bank/PayPal) for viewing sponsored messages shown during Claude Code's "thinking" pauses inside VS Code (and the Claude Code CLI status line). Three parts, deployed independently:

- **`backend/`** — the API (Node.js, deployed to Render as `waitjiai-backend.onrender.com`).
- **`extension/`** — the VS Code extension published to the Marketplace as `WaitJiai.waitji-ai` (shows the ad in the status bar and optionally in the Claude Code CLI status line).
- **`web/`** — the marketing site + advertiser/customer/admin dashboards, static HTML/JS deployed to Vercel (`web/vercel.json`).

## Commands

Backend:
```bash
cd backend && npm install    # only dependency is `pg`
npm start                    # node server.js
```
There is no build step, linter, or test suite for the backend, web, or extension — none are configured in this repo. Do not invent test/lint commands.

Extension:
```bash
cd extension && npm install
npm run compile              # tsc -p ./  (outputs to extension/out)
npm run watch                # tsc -watch -p ./
```
Packaging (`vsce package`) is not scripted here; `vscode:prepublish` just runs `compile`.

Web (`web/`): plain static HTML/CSS/JS, no package.json, no build — files are served/deployed as-is by Vercel.

## Backend architecture (`backend/server.js`)

This is a **single ~4000-line file**, no framework (raw `http.createServer`), no router library. Routes are matched by hand with `if (method === 'GET' && url === '/v1/...')` chains inside one big request handler — search for the route string (e.g. `grep -n "url === '/v1/customer"` ) rather than expecting separate route files. Dynamic segments use `url.match(/^\/v1\/admin\/campaigns\/[^/]+\/stats$/)`.

**State**: the entire app state lives in one in-memory object `db` (`db.users`, `db.campaigns`, `db.impressions`, `db.clicks`, `db.fraudFlags`, `db.payouts`, `db.withdrawalRequests`, `db.discountCodes`, `db.waitlist`, `db.disputes`, `db.apiKeys`, `db.houseAds`, `db.auditLog`, `db.sessions`, etc.). `loadDB()`/`saveDB()` persist this as **one JSON blob** in a Postgres `kv_store` table (Neon) — there is no relational schema, no migrations, and no per-entity queries. If `DATABASE_URL` is unset it falls back to a local `data.json` file, which is explicitly called out as **non-persistent on Render** (wiped every deploy/restart) — never treat that fallback as production-safe. `saveDB()` debounces writes (300ms) so call it after mutating `db`, don't assume synchronous persistence.

**Auth**: two independent auth paths, both accepted wherever advertiser routes call `authAdvertiser(req)`:
- Session token: Supabase handles signup/login/OAuth; the frontend exchanges a Supabase access token via `POST /v1/auth/exchange` for a WaitJI-issued HS256 JWT (hand-rolled `signToken`/`verifyToken`, not a library). `auth(req)` reads `Authorization: Bearer <token>`.
- API key: `X-WaitJI-Api-Key` header for advertisers/agents doing programmatic campaign management (`apiKeyAuth(req)`), gated by `apiTermsAccepted` for writes.

Roles are `customer` (developers earning), `advertiser`, and `admin`. Admins can be **full** or **scoped sub-admins** (`db.users[id].adminScope`) — use `requireFullAdmin()` / `requireScope()` to gate money-moving or destructive admin routes; view-only admin routes are open to any admin.

**Money**: all amounts are stored as **paise (integer INR cents)**, never floats/rupees, to avoid rounding bugs — convert only at display time (`(paise/100).toFixed(2)`). Non-INR advertiser pricing is derived from `GEO_PRICING` (hardcoded exchange rates + PPP adjustment per country, see comments in that block for the pricing logic). Payouts to developers go out via **Cashfree** (Indian UPI/bank) or **PayPal** (international) — `approveOneWithdrawal()` is the single shared code path for both single and bulk withdrawal approval; don't duplicate that logic in a new endpoint.

**Fraud detection**: `validateClick()`/`validateImpression()` apply velocity/cadence/IP/CTR heuristics (thresholds in the `FRAUD` const) before an impression/click is billed to an advertiser or credited to a developer — invalid ones are flagged (`flagFraud`) but not paid. A `critical` severity flag auto-bans the user. Any new billable event must go through equivalent validation, not just get appended to `db.impressions`/`db.clicks` directly.

**Required env vars with no insecure fallback** (server refuses to boot / seed without them — do not reintroduce defaults for these): `JWT_SECRET`, `ENCRYPT_KEY`, and `ADMIN_PASSWORD` (only required on first boot when no admin exists yet). `ENCRYPT_KEY` drives AES-256-GCM `encrypt()`/`decrypt()` used for sensitive fields like bank account numbers — always store those encrypted (`enc:` prefix), never plaintext, and decrypt only at the point of use (e.g. building a Cashfree payout).

**Background sweeps**: several `setInterval`-driven jobs started at the bottom of the file (campaign scheduling, zero-impression alerts, auto-payouts, weekly advertiser email reports) — these run in-process, so a route handler must never assume it's the only thing touching `db` at a given moment.

## Extension architecture (`extension/src/extension.ts`)

Single-file VS Code extension (no framework). Two integration surfaces:
1. **VS Code status bar** — always active; shows a spinner + ad text driven by `startAdDisplay()`, triggered by a `FileSystemWatcher` on `**/.claude/**` (proxy for "Claude Code is active").
2. **Claude Code CLI status line** — opt-in; edits the user's own `~/.claude/settings.json` `statusLine` command to point at a bundled script (`assets/statusline.mjs`), capturing whatever was there before (`statusline-prev.json`) so `restoreStatusLine()` can put it back exactly. Never touches files belonging to the Claude Code extension itself — only the user's own settings file, and always reversibly.

Impressions/clicks are only credited after the **backend** confirms billing (`res.billed`) — the extension never credits earnings locally without a server round-trip.

## Web (`web/`)

Plain static HTML pages, each talking directly to the backend API via `fetch`. No shared JS bundler/framework — shared logic (if any) is copy-pasted per page or lives in small standalone scripts. `admin.html`/`admin-login.html` are explicitly no-indexed and no-cache via `web/vercel.json` headers. `web/blog/*.html` are individual static posts, not generated from a CMS.
