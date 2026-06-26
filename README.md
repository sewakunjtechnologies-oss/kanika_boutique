# Kanika Design Automation — WhatsApp Order System

Production-ready WhatsApp order automation for a single-number Indian boutique. Bot handles order inquiries automatically; the owner replies to personal chats from the WhatsApp Business app on the same number (via Meta's **Coexistence** feature).

## Architecture

Monorepo (npm workspaces):

```
apps/
  backend/      Express + TypeScript — webhook, bot logic, REST API, Socket.IO, workers
  dashboard/    Next.js 14 + Tailwind + shadcn-style UI — admin panel
packages/
  db/           Prisma schema + generated client + seed
  shared/       Cross-package zod schemas + constants
```

**Stack:** Node 20 · TypeScript strict · Express · Next.js 14 (App Router) · Prisma + Postgres 16 · Redis 7 + BullMQ · Meta Cloud API (Graph v23.0) · **Google Gemini 2.5 Pro** · Socket.IO · Android TCP print bridge · server-side session cookie + bcrypt auth · pino · zod · vitest.

## Prerequisites

- **Node 20+**, **Docker Desktop**, **Google AI Studio key** (https://aistudio.google.com/apikey), **Meta WhatsApp Business app**, **ngrok** (for webhook testing).

## Setup

```bash
npm install
cp .env.example .env       # fill in values — see below

npm run docker:up           # start Postgres + Redis
npm run db:generate         # Prisma client
npm run db:migrate:init     # only on a fresh DB
SEED_ADMIN_PASSWORD='set-a-strong-password' npm run db:seed
npm run db:migrate:deploy   # production/staging migration command

npm run dev                 # backend :3031, dashboard :3030
```

Visit **http://localhost:3030**, then log in with the seeded admin email and the password you supplied.

## Environment variables

| Variable | Required | Where to get |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | yes | Docker Compose defaults work |
| `META_APP_ID` | yes | Meta App Dashboard → Settings → Basic → App ID |
| `META_APP_SECRET` | yes | Meta App Dashboard → Settings → Basic → "Show" App Secret |
| `META_ACCESS_TOKEN` | yes | WhatsApp → API Setup → Temporary token (or System User permanent token) |
| `META_PHONE_NUMBER_ID` | yes | WhatsApp Manager → Phone Numbers → click number → "Phone number ID" |
| `META_WABA_ID` | yes | Business Manager → Settings → WhatsApp Accounts → ID |
| `META_WEBHOOK_VERIFY_TOKEN` | yes | Any random string — paste this same value into the Meta webhook config |
| `GEMINI_API_KEY` | yes | https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | no | Default `gemini-2.5-pro`. For lower cost: `gemini-2.5-flash` |
| `SESSION_SECRET` | yes | `openssl rand -base64 64` |
| `SESSION_COOKIE_NAME`, `SESSION_COOKIE_MAX_AGE_DAYS`, `SESSION_COOKIE_SAMESITE`, `SESSION_COOKIE_SECURE` | no | Defaults: `kda.sid`, `7`, auto same-site choice, secure in production |
| `JWT_SECRET` | no | Optional internal Socket.IO token secret. Defaults to `SESSION_SECRET` when blank |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | seed only | Required before creating the first admin user |
| `ORDER_RESERVATION_MINUTES` | no | How long unpaid pending orders reserve stock before expiry |
| `PRINT_AGENT_TOKEN` | optional | Required when Android print bridge is enabled |
| `BUSINESS_NAME`, `UPI_ID`, `DEFAULT_SHIPPING_FEE` | yes | Also editable from `/settings` in dashboard |

Empty strings are treated as missing (zod defaults apply).

## Meta webhook configuration

Point your Meta webhook **at the backend port (`BACKEND_PORT`, currently 3031)**, not the dashboard:

```
https://<your-ngrok>.ngrok-free.app/webhook/whatsapp
```

Run `ngrok http 3031`, copy the HTTPS URL, paste into Meta's webhook config. Use `META_WEBHOOK_VERIFY_TOKEN` from your `.env` as the verify token. Subscribe to these webhook fields:

- `messages`
- `smb_message_echoes` (Coexistence — owner's manual replies)
- `smb_app_state_sync` (Coexistence — contact sync)
- `history` (Coexistence — one-time history dump)

## Daily commands

```bash
npm run dev                 # backend + dashboard (color-coded, Ctrl+C kills both)
npm run dev:backend         # backend only
npm run dev:dashboard       # dashboard only
npm run docker:up / :down

npm run db:studio           # Prisma Studio at :5555
npm run db:seed             # re-run idempotent seed
npm run testai -- intent "kya yeh available hai"   # smoke-test Gemini
npm run -s send-test -w @kda/backend -- text +919876543210 "hi"
npm run -s sample -w @kda/backend -- text 919876543210       # signed local webhook test

cd apps/backend && npx vitest run   # state machine tests (13 cases)
```

## What's implemented

### Phase 1–4 (foundation)
- Monorepo + Prisma schema (9 models) + migrations
- Meta webhook ingestion with signature verification, BullMQ queue, dedup by `whatsappMessageId`
- Coexistence support: `smb_message_echoes` triggers 6h human takeover; `smb_app_state_sync` syncs contacts; `history` bulk-imports past chats
- WhatsApp send helpers with rate-limit retry, takeover guard, auto media download
- Gemini-based intent classifier (`ORDER_INTENT` / `PERSONAL_CHAT` / `UNKNOWN`), vision product matcher (with 0.6 confidence threshold), payment screenshot extractor

### Phase 5 — Bot state machine
- Pure transition function (13 unit tests cover happy path, cancel/menu/agent commands, OOS alternatives, payment loop)
- Orchestrator chains: takeover check → intent classify → state machine → execute actions (send text/buttons/list, run product match, create order, run payment extraction, notify dashboard)
- Audio/voice notes are always treated as PERSONAL_CHAT (no bot reply)
- Stock check before order creation; auto-suggest 3 alternatives by category + price proximity if OOS

### Phase 6 — Dashboard + auth
- Secure httpOnly `kda.sid` server-side session cookie (7-day TTL), bcrypt hashed password
- Session data is stored in Redis and mirrored to Postgres, so dashboard login survives backend restarts
- Dashboard restores `/api/auth/me` before redirecting unauthenticated users to `/login` with `?next=` preserved
- Seed creates the initial admin only when `SEED_ADMIN_PASSWORD` is provided.

### Phase 7 — Inventory
- `/inventory` list with image thumbs, search, total stock per product
- `/inventory/new` form: image upload (5 MB limit, jpg/png/webp/gif), dynamic variant rows, category dropdown
- `/inventory/[id]` edit + soft-delete

### Phase 8 — Orders
- `/orders` filterable by status, live updates via Socket.IO
- `/orders/[id]` detail: payment screenshot preview, AI-extracted amount/UTR/receiver with green/red badge, Approve/Reject/Dispatch/Reprint actions
- Approve flow: deducts stock atomically, sends WhatsApp confirmation, triggers print, transitions conversation to COMPLETED

### Phase 9 — Conversations
- `/conversations` 2-pane WhatsApp-like view
- Color-coded message bubbles: gray (INBOUND), blue (BOT), green (OWNER_MANUAL)
- Take over / release toggle + manual reply input
- Live updates via Socket.IO `/dashboard` namespace (auth via token fetched from `/api/auth/socket-token`)

### Phase 10 — Print
- Backend creates `PrintJob` records for online order labels, manual receipt slips, return slips, and test labels
- Android print bridge claims jobs and sends RAW TSPL commands directly to the 4BARCODE printer over TCP/Wi-Fi
- Manual "Print again" button on order/receipt detail creates explicit reprint jobs

### Phase 11 — Dashboard polish
- Home: 4 KPI cards (today's orders, pending verification, month revenue, low-stock variants) + recent orders table
- `/settings` page edits business name, UPI, shipping fee, working hours, all WhatsApp templates
- `/customers` + `/customers/[id]` with order history

### Phase 12 — Hardening
- `helmet` security headers, `cors` with credentials, `express-rate-limit` (20 req/min) on auth endpoints
- Graceful shutdown: drains Socket.IO → BullMQ worker → queue → Redis → Prisma
- pino-http access logs (health endpoint excluded from noise), pino-pretty in dev
- Health endpoint pings DB + Redis

## Deployment

| Component | Platform | Notes |
|---|---|---|
| Backend (`@kda/backend`) | Railway / Render / Docker | Postgres + Redis as add-ons. Set all env vars. `npm run db:migrate:deploy && npm run build && npm start` |
| Dashboard (`@kda/dashboard`) | Vercel | Set `NEXT_PUBLIC_BACKEND_URL` to your backend's public URL |
| Meta webhook | Point at backend's public URL `/webhook/whatsapp` |
| Android print bridge | Shop Android phone | Polls Render, claims `PrintJob`s, sends TSPL RAW commands to the Wi-Fi printer |
| Postgres backups | Use Railway/Render's nightly backup add-on |

For production auth, set `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, `SESSION_COOKIE_MAX_AGE_DAYS=7`, and use `SESSION_COOKIE_SAMESITE=none` while the dashboard and API are on different site domains.

Backend Docker build:

```bash
docker build -f apps/backend/Dockerfile -t kanika-backend .
docker run --env-file .env.production -p 3001:3001 kanika-backend
```

Health check endpoint: `GET /health` returns DB and Redis status and should be used by the host load balancer.

Uploads are currently stored on the backend filesystem under `uploads/`. That is acceptable for a single local demo machine only. For production with containers or autoscaling, migrate product/payment media storage to S3, Cloudinary, or another persistent object store before relying on uploaded files.

## Project conventions

- TypeScript strict everywhere, no `any`, zod-validated env + API inputs
- Prisma migrations for every schema change, never raw SQL
- Comments only where WHY is non-obvious
- WhatsApp `wamid` is the dedup key for inbound messages
