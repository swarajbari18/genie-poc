# Component 4 — Inbound Reply Capture
## Implementation Plan (standalone)

**Written:** 2026-05-26
**Component status:** Code-complete for the core handler; **end-to-end test BLOCKED on Postmark account verification** (in progress, ~1 day). This plan documents the full component so whoever finishes it can verify, harden, and close the known gaps without re-deriving context.
**Depends on:** Components 1–3 (auth + service email, upload + dashboard, send via Postmark) — all built and tested.
**Reference plan:** `plans/component-01-02-03-auth/implementation-plan.md` (same structure and conventions).

> **Convention:** implementation *notes* (the "as-built" walkthrough, like component-01's notes) are written by whoever implements/verifies this — not here. This file is the plan: every table, every manual step, every code seam, and every done-criterion.

---

## 0. What This Component Does (and does not)

**Does:** when the counterparty replies to a contract email, Postmark receives it at the user's service address (`{slug}-{token}@mail.usetend.in`), parses it (body + attachments as base64), and POSTs structured JSON to our webhook. The backend deduplicates, stores the raw payload, links the reply to the originating contract, stores any PDF attachment in GCS, records the reply in the contract thread, and moves the contract to `replied`. The thread page then shows the reply with a downloadable attachment.

**Does NOT (deferred to later components):**
- The *user replying back* / multi-round negotiation → **Component 5**.
- Live dashboard update without refresh (SSE) → **Component 6**. Until then, the dashboard reflects `replied` on the next page load.
- Intra-domain "received contract" inbox (Genie-user → Genie-user) → **Component 7**. For now, an inbound email that doesn't match a sent contract is stored but not surfaced as a new contract.
- AI diff/analysis → **Component 8**. The handler calls a no-op `triggerAiPipeline` stub.

---

## 1. System Architecture (inbound slice)

```
COUNTERPARTY                POSTMARK                       CLOUD RUN (Hono backend)
────────────                ────────                       ────────────────────────
replies to                  MX: mail.usetend.in →          POST /webhooks/postmark/inbound
alice-x7k2@mail.usetend.in  inbound.postmarkapp.com          │
   │                          │                              ├─ verify Basic Auth (else 401)
   └───────── email ─────────►│ parses email →               ├─ INSERT inbound_emails
                              │ POSTs JSON                    │    ON CONFLICT (message_id) DO NOTHING
                              │ (Basic Auth on URL)           │    └─ 0 rows → 200 {note:"duplicate"}
                              └──────────────────────────────►├─ return 200 fast
                                                              └─ processInbound() async:
                                                                   ├─ OriginalRecipient → local-part → user
                                                                   ├─ In-Reply-To → match outbound msg → contractId
                                                                   ├─ decode PDF attachments → GCS
                                                                   ├─ INSERT contract_threads (inbound)
                                                                   ├─ UPDATE contracts.status = 'replied'
                                                                   ├─ UPDATE inbound_emails.processed = true
                                                                   └─ triggerAiPipeline() [stub]

NeonDB              inbound_emails (raw ledger) · contract_threads (inbound row) · contracts (status)
GCS                 contracts/{userId}/{contractId}/reply-{ts}.pdf   (matched)
                    inbound/{userId}/{messageId}.pdf                 (unmatched fallback)
```

**Why return 200 before processing:** Postmark retries any non-200 up to 10 times. We persist the raw payload synchronously (so we never lose it), acknowledge with 200, then process asynchronously. A processing failure is recorded on the `inbound_emails` row (`processing_error`), not surfaced to Postmark as a retryable error — otherwise a deterministic bug would loop 10×.

---

## 2. Prerequisites & Manual Steps

Everything here is a one-time human action. None of it is code. **The whole component is untestable end-to-end until §2.1 completes.**

### 2.1 Postmark account verification (CURRENT BLOCKER)

- [ ] Postmark account approved for sending/receiving (under review as of 2026-05-26).
- [ ] Server created (e.g. "Genie POC"); note the **Server API Token**.
- [ ] Until approved, Postmark restricts sending to your own confirmed address and may hold inbound — so a real reply round-trip cannot be exercised. Outbound send (Component 3) was tested within those limits.

### 2.2 Sending domain (outbound, needed so replies are addressed correctly)

- [ ] Postmark → **Sender Signatures → Add Domain** → `mail.usetend.in`.
- [ ] Add the DKIM and Return-Path DNS records Postmark shows. Wait for "Verified".

### 2.3 Inbound configuration

- [ ] Postmark → **Server → Settings → Inbound**.
- [ ] Set the **Inbound Domain** to `mail.usetend.in`.
- [ ] Set the **Inbound Webhook URL** to `https://{BACKEND_URL}/webhooks/postmark/inbound`.
- [ ] Put **Basic Auth credentials directly in the URL** Postmark calls, i.e. `https://{user}:{pass}@{BACKEND_URL}/webhooks/postmark/inbound`, where `{user}`/`{pass}` are `POSTMARK_INBOUND_WEBHOOK_USER` / `POSTMARK_INBOUND_WEBHOOK_PASS` from the backend env. Postmark sends these as the HTTP `Authorization: Basic …` header, which the handler checks.
- [ ] Enable **"Include raw email content"** only if needed for debugging (larger payloads); not required for this component.

### 2.4 DNS records for `mail.usetend.in`

```
# Inbound routing — REQUIRED for this component
mail.usetend.in.                MX  10  inbound.postmarkapp.com.

# Outbound DKIM + return-path (from Postmark, §2.2)
{selector}._domainkey.mail.usetend.in.  TXT  "k=rsa; p={KEY_FROM_POSTMARK}"
pm-bounces.mail.usetend.in.     CNAME  pm.mtasv.net.
mail.usetend.in.                TXT  "v=spf1 a mx include:spf.mtasv.net ~all"
```

- [ ] Add the MX record (this is what routes replies to Postmark). Allow up to 24h propagation; confirm in the Postmark dashboard.

### 2.5 Local end-to-end testing (tunnel)

The webhook must be reachable from Postmark's servers, so `localhost` won't work. Expose the local backend:

```bash
cloudflared tunnel --url http://localhost:8080
# → prints a public https URL, e.g. https://random-words.trycloudflare.com
```

- [ ] Temporarily point the Postmark inbound webhook URL at `https://{tunnel}/webhooks/postmark/inbound` (with Basic Auth in the URL).
- [ ] Remember to point it back to the real Cloud Run URL after local testing.

### 2.6 Secrets already in place (from Component 1)

`POSTMARK_SERVER_API_TOKEN`, `POSTMARK_INBOUND_WEBHOOK_USER`, `POSTMARK_INBOUND_WEBHOOK_PASS`, `GCS_BUCKET_NAME`, `DATABASE_URL_POOLED`. No new env vars are introduced by this component.

---

## 3. Database — Tables This Component Touches

No schema change is required for Component 4 (the tables exist from Component 1). For reference, the columns this component reads/writes:

### `inbound_emails` — raw webhook ledger (idempotency + debug)
Written first, synchronously. The dedup key is `postmark_message_id` (unique). Fields set on receipt: `postmark_message_id`, `to_address` (= `OriginalRecipient`), `from_address`, `subject`, `raw_payload` (the entire Postmark JSON). Fields set after processing: `processed=true`, `thread_entry_id`, `processed_at`; or `processing_error` on failure.

### `contract_threads` — one row per email
This component inserts the **inbound** row: `direction='inbound'`, `postmark_message_id` (= webhook `MessageID`), `in_reply_to_message_id`, `from_address`, `to_address`, `subject`, `body_text`, `body_html`, `attachments` (jsonb array of `{filename, contentType, storageKey, sizeBytes}`), `email_date` (from the email `Date`, not insert time). Matched to a contract via `contract_id`.

### `contracts` — status transition
On a successful match: `status → 'replied'`, `updated_at = now()`. Indexes `(user_id, status)` already support the dashboard grouping that will show it under "Needs Attention".

> **No migration needed.** The `origin`/`received` additions belong to Component 7, not here.

---

## 4. Inbound Flow — Step by Step

1. Postmark POSTs `POST /webhooks/postmark/inbound`.
2. **Auth:** compare the `Authorization` header to `Basic base64(user:pass)`. Mismatch → `401` (and Postmark will retry, which is fine — a misconfigured URL should be noticed).
3. **Idempotency:** `INSERT inbound_emails … ON CONFLICT (postmark_message_id) DO NOTHING RETURNING id`. Zero rows → already seen → `200 {ok:true, note:"duplicate"}`, stop.
4. **Acknowledge fast:** return `200 {ok:true}`; kick off `processInbound(inboundId, payload)` without awaiting it.
5. **Resolve user:** `OriginalRecipient` → split on `@` → local-part (lowercased) → `getServiceEmailByLocalPart` → `{userId}`. No match → log + discard (still marked handled).
6. **Match contract:** read the `In-Reply-To` header, normalize it (see §5), look up `contract_threads.postmark_message_id = inReplyTo` → `contractId`.
7. **Attachments:** for each attachment with a PDF content type, base64-decode and upload to GCS at `contracts/{userId}/{contractId}/reply-{ts}.pdf` (matched) or `inbound/{userId}/{messageId}.pdf` (unmatched fallback). Collect `{filename, contentType, storageKey, sizeBytes}`.
8. **Thread row:** insert the inbound `contract_threads` row with the attachment metadata.
9. **Status:** if matched, `UPDATE contracts SET status='replied'`. If unmatched, log a warning (Component 7 will later turn this into a received contract).
10. **Mark processed:** `inbound_emails.processed=true`, `thread_entry_id`, `processed_at`.
11. **AI stub:** call `triggerAiPipeline(contractId, attachments)` (no-op until Component 8).

### Postmark inbound payload — fields we rely on

```ts
{
  From: string                       // "John Doe <john@company.com>"
  FromFull: { Email, Name, MailboxHash }
  OriginalRecipient: string          // "alice-x7k2@mail.usetend.in" — ROUTING KEY
  Subject: string
  MessageID: string                  // Postmark's id — our idempotency key + thread msg id
  Date: string
  TextBody: string
  HtmlBody: string
  Headers: Array<{ Name, Value }>    // includes "In-Reply-To" — used to link the contract
  Attachments: Array<{ Name, Content (base64), ContentType, ContentLength }>
}
```

---

## 5. CRITICAL — `In-Reply-To` ↔ `MessageID` matching (verify FIRST)

This is the single most likely thing to silently break the whole component, so it must be the first thing checked once Postmark is live.

**The mechanism:** on send (Component 3) we store Postmark's API-returned `MessageID` (a bare UUID, e.g. `a1b2c3d4-…`) in `contract_threads.postmark_message_id`. When the counterparty replies, their mail client sets `In-Reply-To` to the **email `Message-ID:` header** of our message — which Postmark generates as `<{MessageID}@{domain}>`, e.g. `<a1b2c3d4-…@mail.usetend.in>` or `<…@mtasv.net>`.

**The current code** (`webhooks.ts`) does `?.replace(/<|>/g, '')?.trim()`. That strips the angle brackets but **leaves the `@domain` suffix**, so it tries to match `a1b2c3d4-…@mail.usetend.in` against the stored bare UUID `a1b2c3d4-…` → **no match even on round 2**, and the contract never moves to `replied`.

**What to do (decide during verification, by inspecting a real payload):**
1. Send a contract to a real mailbox, reply, and capture the raw `In-Reply-To` value from the `inbound_emails.raw_payload` (`Headers`).
2. If it contains `@domain`, normalize before matching — strip `< >`, then take the part before the first `@`:
   ```ts
   const inReplyTo = rawHeader?.replace(/[<>]/g, '').split('@')[0].trim()
   ```
   …**or** store the full `Message-ID` header form on the outbound row and match on that. Pick one representation and use it consistently on both send and match.
3. Re-test until a reply reliably flips the contract to `replied`.

> Every multi-round chain (Component 5) rides on this. Get it right here, once.

---

## 6. Known Gaps / Hardening (close as part of this component)

1. **Reply-attachment download is missing.** `GET /api/contracts/:id/download-url` only signs `contract.storageKey` (the *original* PDF). Reply attachments live in `contract_threads.attachments[].storageKey` and have no download path. **Add** an endpoint that signs an arbitrary `storageKey` *after verifying it belongs to a contract owned by the requesting user* — e.g. `GET /api/contracts/:id/attachment?key=…` that (a) loads the contract scoped to `user.id`, (b) confirms the `key` appears in one of that contract's thread rows, (c) returns a 15-min–1-hr signed URL. Never sign an arbitrary user-supplied key without the ownership check (path-traversal / IDOR risk).
2. **Attachment filter is PDF-only.** Non-PDF attachments are silently dropped (`att.ContentType?.includes('pdf')`). That's acceptable for the POC; log dropped attachments so it's visible during testing.
3. **`emailDate` parsing.** `new Date(payload.Date)` can yield `Invalid Date` for odd header formats; guard with a fallback to `now()`.
4. **Unmatched inbound** currently writes a `contract_threads` row with `contract_id='unknown'`. That's a placeholder until Component 7. Keep the raw payload (we do) so those can be reprocessed later; do not delete them.
5. **Body display safety.** `body_html` is attacker-controlled; if the thread page renders HTML, sanitize it (or render `body_text` only) to avoid stored XSS.

---

## 7. Frontend — Thread View

The contract detail page (`frontend/src/pages/contracts/[id].astro`) fetches `GET /api/contracts/:id`, which returns `{ contract, threads }` (threads ordered by `email_date` desc). For this component the page must:

- Render each thread entry with direction (outbound/inbound), `from`/`to`, `subject`, timestamp, and a body preview (prefer `body_text`).
- For an inbound entry with attachments, show a **"Download attachment"** action that calls the new reply-attachment endpoint (§6.1) and opens the signed URL.
- Show the contract's current `status` badge; when `replied`, surface it prominently ("Counterparty replied").

No live update here — that's Component 6. Until then the page shows the latest state on load/refresh.

---

## 8. Build / Verify Order (done-criteria)

The handler exists; these steps finish and prove the component.

### Step 1 — Static review against this plan
Confirm `webhooks.ts` matches §4 and is mounted at `/webhooks` in `app.ts`.
**Done:** route reachable; `curl -XPOST` without auth → `401`.

### Step 2 — Fix the In-Reply-To normalization (§5)
**Done:** a unit-level check (or a manual `psql`-seeded outbound row + a crafted payload) shows a reply matches its contract.

### Step 3 — Add the reply-attachment download endpoint (§6.1)
**Done:** requesting an attachment key that belongs to another user's contract → `404`/`403`; a valid key → working signed URL.

### Step 4 — Idempotency proof (no Postmark needed)
POST the same captured payload JSON twice with valid Basic Auth.
**Done:** first → `{ok:true}`; second → `{ok:true, note:"duplicate"}`; exactly one `inbound_emails` row; one `contract_threads` row.

### Step 5 — Real round-trip (REQUIRES Postmark §2.1)
With the tunnel (§2.5): send a contract (Component 3) to a real external mailbox, reply with a PDF attached.
**Done within ~30s:** `inbound_emails.processed=true`; inbound `contract_threads` row with the attachment; `contracts.status='replied'`; reply PDF at `contracts/{userId}/{contractId}/reply-{ts}.pdf`; thread page shows the reply and downloads the attachment.

### Step 6 — Unmatched inbound behaves
Send an email directly to a service address that is NOT a reply.
**Done:** stored in `inbound_emails`; thread row with `contract_id='unknown'`; no crash; warning logged. (Becomes a received contract in Component 7.)

### Step 7 — Point webhook back to production
**Done:** Postmark inbound URL set to the Cloud Run URL; a production reply flips status to `replied`.

---

## 9. End-to-End Test Checklist

- [ ] **I1 — Auth required:** POST without/with wrong Basic Auth → `401`.
- [ ] **I2 — Raw stored first:** any accepted POST creates an `inbound_emails` row with full `raw_payload` before processing.
- [ ] **I3 — Idempotent:** duplicate `MessageID` → `{note:"duplicate"}`, single stored row.
- [ ] **I4 — User routing:** `OriginalRecipient` local-part resolves to the correct user; unknown local-part is discarded cleanly.
- [ ] **I5 — Contract match:** a real reply links to the originating contract (depends on §5 fix).
- [ ] **I6 — Attachment stored:** reply PDF lands at the matched GCS key; metadata recorded on the thread row.
- [ ] **I7 — Status:** matched contract → `replied`; visible on dashboard under "Needs Attention" after refresh.
- [ ] **I8 — Download:** reply attachment downloads via a signed URL; another user cannot download it.
- [ ] **I9 — Unmatched:** non-reply inbound is stored without error and not shown as a contract reply.
- [ ] **I10 — Failure isolation:** a forced processing error records `processing_error` and still returns `200` (no Postmark retry storm).

---

## 10. What NOT to Build in Component 4

- **User reply / negotiation loop** → Component 5.
- **SSE live updates** → Component 6 (until then, refresh to see `replied`).
- **Received-contract inbox / intra-domain** → Component 7 (unmatched inbound stays a placeholder row).
- **AI diff/analysis** → Component 8 (`triggerAiPipeline` stays a stub).
- **Non-PDF attachment handling, rate limiting, webhook-replay UI** → out of POC scope.
