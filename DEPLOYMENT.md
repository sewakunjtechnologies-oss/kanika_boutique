# Deployment Runbook

This project has three runtime pieces:

- Dashboard: Next.js app.
- Backend API: Express app for REST, Socket.IO, uploads, and Meta webhook ingestion.
- Worker: BullMQ process for webhook jobs and maintenance jobs.

## Required Services

- Node.js 20+
- PostgreSQL database
- Redis instance
- Persistent media storage
  - Current implementation uses local filesystem uploads under `uploads/`.
  - For a real production host, use persistent disk or migrate storage to S3, Cloudinary, or Supabase Storage before relying on uploaded product/payment media.

## Install

```bash
npm ci
npm run db:generate
```

## Build

```bash
npm run build:backend
NEXT_PUBLIC_BACKEND_URL=https://your-backend.example.com npm run build:dashboard
```

Or build everything:

```bash
NEXT_PUBLIC_BACKEND_URL=https://your-backend.example.com npm run build
```

## Database

Run migrations before starting the app:

```bash
npm run db:migrate:deploy
npm run db:generate
```

Create the first production admin only after setting `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`:

```bash
SEED_ADMIN_EMAIL="admin@example.com" SEED_ADMIN_PASSWORD="strong-password-here" npm run db:seed
```

## Backend API Process

Required command:

```bash
NODE_ENV=production npm run start:backend
```

The backend exposes:

- `GET /health`
- `GET /webhook/whatsapp`
- `POST /webhook/whatsapp`
- `/api/*`

In production, embedded workers are disabled by default. Keep `START_EMBEDDED_WORKERS=false` and run the worker command below as a separate service.

## Worker Process

Required command:

```bash
NODE_ENV=production npm run start:worker
```

The worker connects to Postgres and Redis on startup, starts the WhatsApp webhook queue worker, and schedules maintenance jobs for expired reservations and stale conversation cleanup.

## Dashboard

Set this on the dashboard host:

```bash
NEXT_PUBLIC_BACKEND_URL=https://your-backend.example.com
```

Build/start:

```bash
npm run build:dashboard
npm run start --workspace=@kda/dashboard
```

For Vercel, set `NEXT_PUBLIC_BACKEND_URL` in the Vercel project env and let Vercel run `npm run build --workspace=@kda/dashboard`.

## Required Production Environment

Backend API and worker:

```bash
NODE_ENV=production
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
META_APP_SECRET=
META_ACCESS_TOKEN=
META_PHONE_NUMBER_ID=
META_WEBHOOK_VERIFY_TOKEN=
PUBLIC_BACKEND_URL=
PUBLIC_DASHBOARD_URL=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
META_GRAPH_API_VERSION=v23.0
COOKIE_SECURE=true
COOKIE_SAME_SITE=none
COOKIE_DOMAIN=
START_EMBEDDED_WORKERS=false
ORDER_RESERVATION_MINUTES=120
BUSINESS_NAME=Kanika Designs
UPI_ID=
DEFAULT_SHIPPING_FEE=100
```

Dashboard:

```bash
NODE_ENV=production
NEXT_PUBLIC_BACKEND_URL=
```

Seed only:

```bash
SEED_ADMIN_EMAIL=
SEED_ADMIN_PASSWORD=
```

Optional:

```bash
META_APP_ID=
META_WABA_ID=
PRINT_PROVIDER=manual
PRINTNODE_API_KEY=
PRINTNODE_PRINTER_ID=
INVOICE_PRINTER_ID=
LABEL_PRINTER_ID=
RECEIPT_PRINTER_ID=
AUTO_PRINT_ON_PAYMENT_APPROVAL=false
CHATBOT_ENABLE_AI_IMAGE_MATCHING=false
CHATBOT_DEBUG=false
LOG_LEVEL=info
```

Printing notes:

- `PRINT_PROVIDER=manual` generates a PDF and returns the PDF URL from print routes. This is safe for demos and for deployments without printer credentials.
- `PRINT_PROVIDER=printnode` sends the generated PDF to PrintNode when `PRINTNODE_API_KEY` and the matching printer ID are configured. PDF generation remains the fallback if PrintNode is unavailable.

Cookie notes:

- If backend and dashboard are on different site domains, such as Render and Vercel, use `COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true`.
- Leave `COOKIE_DOMAIN` blank for host-only API cookies unless both apps share a parent domain such as `api.example.com` and `dashboard.example.com`.
- If both apps share a parent domain and you want the dashboard middleware to see the cookie, set `COOKIE_DOMAIN=.example.com`.

## Meta Webhook Setup

Callback URL:

```text
https://your-backend.example.com/webhook/whatsapp
```

Verify token:

```text
META_WEBHOOK_VERIFY_TOKEN
```

Subscribe to:

- `messages`
- `smb_message_echoes`
- `smb_app_state_sync`
- `history`

The webhook verifies `x-hub-signature-256`, enqueues the payload, and returns `200` before job processing.

## Smoke Test Checklist

1. Run `npm run db:migrate:deploy`.
2. Run `npm run db:generate`.
3. Seed admin with `SEED_ADMIN_PASSWORD`.
4. Start backend API.
5. Start worker.
6. Open `https://your-backend.example.com/health`; confirm DB is `up` and Redis is `up`.
7. Open dashboard URL.
8. Log in with seeded admin.
9. Upload a test product image and confirm it appears in inventory.
10. In Meta dashboard, verify webhook with `https://your-backend.example.com/webhook/whatsapp`.
11. Send a WhatsApp text message and confirm it appears in conversations.
12. Send a product image and confirm the bot replies with confirmation, choices, or clearer-photo fallback.
13. Create a test order through chat.
14. Send a payment screenshot and confirm order moves to payment review, not auto-approved.
15. Approve/reject from dashboard and confirm status/stock behavior.

## Final Checks

```bash
npm run typecheck
npm run test
NEXT_PUBLIC_BACKEND_URL=https://your-backend.example.com npm run build
npm run lint --workspaces --if-present
```
