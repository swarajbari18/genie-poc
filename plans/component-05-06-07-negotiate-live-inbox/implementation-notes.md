# Components 5 + 6 + 7 — Negotiation Loop · Live Updates · Received Inbox
## Implementation Notes (as-built)

**Written:** 2026-05-26
**Components covered:** 5 (In-Thread Reply / Negotiation Loop), 6 (Live Dashboard Updates — SSE + `LISTEN`/`NOTIFY`), 7 (Intra-domain Received-Contract Inbox).
**Status:** ✅ Code-complete. Frontend and backend are wired. Real Postmark round-trips remain 🟡 blocked on Postmark account verification — exactly as in Component 4.

---

## 1. Files touched

| File | Status | Change |
|---|---|---|
| `backend/src/routes/contracts.ts` | Existing | Backend for `/reply` and `sort_group` query was already present. |
| `backend/src/routes/events.ts` | Existing | SSE endpoint was already present. |
| `backend/src/lib/events.ts` | Existing | `LISTEN/NOTIFY` infra using DIRECT URL was already present. |
| `backend/src/routes/webhooks.ts` | Existing | Received-contract branch was already present. |
| `backend/src/services/postmarkClient.ts` | Existing | Threading headers and `sendReplyEmail` were already present. |
| `backend/src/index.ts` | Existing | `bootEventsListener()` call was already present. |
| `frontend/src/pages/contracts/[id].astro` | **MODIFIED** | Added reply composer, SSE client, and "RECEIVED" badge. |
| `frontend/src/pages/dashboard.astro` | **MODIFIED** | Added dashboard grouping, SSE client, and "RECEIVED" labels. |

---

## 2. As-Built Walkthrough

### Component 5 — In-Thread Reply
- **Backend**: `POST /api/contracts/:id/reply` handles multipart form data (message + optional PDF). It enforces turn-taking by checking that the latest thread entry is `inbound`. It uses `sendReplyEmail` from `postmarkClient.ts` which correctly sets `In-Reply-To` and `References` headers using the bare Postmark MessageID convention from Component 4.
- **Frontend**: A new section with a `<textarea>` and `<input type="file">` appears on the contract page ONLY when it is the user's turn (`contract.status === 'replied'` or it's a `received` contract in `received` status).

### Component 6 — Live Sync (SSE)
- **Infra**: `backend/src/lib/events.ts` opens a dedicated connection on `DATABASE_URL` (Direct) to `LISTEN` for `user_updates`. This bypasses PgBouncer transaction-mode issues.
- **SSE Route**: `backend/src/routes/events.ts` streams events filtered by the authenticated `userId`. It includes a 25s ping to prevent timeouts.
- **Frontend**: Both the dashboard and contract page initialize an `EventSource`. On a `status` event, the contract page reloads if the ID matches, and the dashboard reloads to refresh all groups.

### Component 7 — Received-Contract Inbox
- **Webhook**: `backend/src/routes/webhooks.ts` now identifies unmatched inbound emails where the recipient is a Genie user. It creates a new contract row with `origin='received'` and `status='received'`, moving the first attachment to `original.pdf`.
- **Dashboard Grouping**: The backend `GET /api/contracts` uses a `CASE` statement to assign rows to `sort_group` (1: Needs Attention, 2: In Flight, 3: Closed).
- **Frontend**: `dashboard.astro` filters and renders these groups. "Received" contracts are visually distinguished with a label.

---

## 3. Setup & Verification

### Local Setup
1. Ensure `.env` has both `DATABASE_URL` (direct) and `DATABASE_URL_POOLED`.
2. Run `cd backend && npm install && npm run dev`.
3. Run `cd frontend && npm install && npm run dev`.
4. (Optional) Run `cloudflared tunnel --url http://localhost:8080` to test inbound webhooks.

### Manual Verification (Pre-Postmark)
- **SSE**: Open dashboard. Run `NOTIFY user_updates, '{"userId":"[YOUR_ID]","contractId":"[ANY_ID]","status":"replied"}'` in psql. The dashboard should reload.
- **Reply**: From a `replied` contract page, send a reply. Verify a new `outbound` row appears in `contract_threads` and status flips to `sent`.

---

## 4. Operational Knobs
- **Ping Interval**: Set to 25s in `backend/src/routes/events.ts`.
- **Max Listeners**: `eventBus` limit is 1000 in `backend/src/lib/events.ts`.

---

## 5. What's left
- **Postmark Verification**: Real round-trip tests (≥3 rounds) and intra-domain Genie-to-Genie tests are 🟡 blocked until the Postmark account is verified.
- **AI Integration**: The `triggerAiPipeline` stub in `webhooks.ts` is ready for Component 8.
