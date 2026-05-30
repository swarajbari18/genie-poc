# Components 5 + 6 + 7 — Negotiation Loop · Live Updates · Received Inbox
## Implementation Plan (standalone, bundled)

**Written:** 2026-05-26
**Components covered:** 5 (In-Thread Reply / Negotiation Loop), 6 (Live Dashboard Updates — SSE + `LISTEN`/`NOTIFY`), 7 (Intra-domain Received-Contract Inbox).
**Status:** ⬜ not started. Components 1–3 are built and tested; Component 4 (inbound capture) is code-complete but its *real* round-trip is **blocked on Postmark account verification** — see §1.3. That same blocker gates the real end-to-end tests for all three components here.
**Depends on:** Components 1–4. Read their plans/notes first — they are the ground truth this plan builds on:
- `plans/component-01-02-03-auth/implementation-plan.md` + notes (auth, service email, upload, dashboard, send, GCS).
- `plans/component-04-inbound/implementation-plan.md` + notes (the inbound webhook this plan extends).

> **Convention (same as Components 1–4):** this file is the **plan** — intent, seams, manual steps, done-criteria. The **implementation notes** (`implementation-notes.md` in this folder) are the *as-built* walkthrough and are written by whoever implements this, **not** here. §10 specifies exactly what those notes must contain.

---

## 0. Why these three are bundled into one plan

They are not three independent features — they interlock, and building them separately would mean building throwaway seams between them:

- **Component 6 (SSE) is the delivery channel for both 5 and 7.** A reply you send (5) and a contract someone sends you (7) are only interesting *live* if the dashboard updates without a refresh. Today the webhook already writes the new `status`, but nothing pushes it to an open browser (`approach.md` Principle 7, Issue 2).
- **Component 7 (received inbox) reuses Component 5's reply composer.** Once User B sees a received contract, the way B "responds" is the exact `POST /:id/reply` flow built in Component 5. Build 5 first and 7 gets its response path for free.
- **Both 5 and 7 call the same `notifyUser()` seam from Component 6.** The reply path (5), the inbound reply path (4), and the received-contract branch (7) each end with one `notifyUser(ownerId, {contractId, status})` call. Defining that seam once, in Component 6, avoids three ad-hoc versions.

**Build order within this bundle: 5 → 6 → 7.** Rationale: 5 is pure additive backend+frontend with no schema change and no new infra (lowest risk, closes the headline product gap); 6 introduces the one piece of new infrastructure (a dedicated DB connection for `LISTEN`) and the `notifyUser` seam that 7 depends on; 7 is the schema migration + the webhook branch that consumes both.

**The hard rule from `approach.md` still holds:** do not mark a component done until it works end-to-end in a browser with **real** data (real Postmark round-trip, two real Genie accounts) — not synthesized payloads. Component 4's notes used synthesized payloads *because Postmark was blocked*; that is a stopgap, not the bar for "done" here (see §1.3 and §10).

---

## 1. Prerequisites & Dependencies

### 1.1 What already exists (do not rebuild — extend)

Grounded in the current code, these are the seams you will touch:

| File | Today | What 5/6/7 do to it |
|---|---|---|
| `backend/src/routes/contracts.ts` | `/`, `/upload`, `/:id`, `/:id/send`, `/:id/download-url`, `/:id/attachment` | **C5:** add `POST /:id/reply`. **C7:** dashboard list query gains grouping (see §4.3). |
| `backend/src/services/postmarkClient.ts` | `sendContractEmail()` — fixed body, no threading headers | **C5:** add threading headers + optional attachment (extend or add `sendReplyEmail()`). |
| `backend/src/routes/webhooks.ts` | `processInbound()` — matched→reply; unmatched→placeholder `contract_id='unknown'` (lines ~206–233) | **C6:** add `notifyUser()` after the status write. **C7:** replace the unmatched branch with the received-contract path. |
| `backend/src/db/schema.ts` | `contractStatusEnum` (8 values), no `origin` column | **C7:** add `received` to the status enum, add `contractOriginEnum` + `origin` column. |
| `backend/src/index.ts` | bare `serve()` | **C6:** boot the `LISTEN` connection before/after `serve()`. |
| `backend/src/app.ts` | mounts contracts + webhooks; CORS allows `FRONTEND_URL` + `credentials:true` | **C6:** mount the SSE router at `/api/events`. CORS is already correct for `EventSource` with credentials. |
| `frontend/src/pages/contracts/[id].astro` | thread render + send form, **vanilla `<script>`** (no React island yet) | **C5:** reply composer. **C6:** live updates. **C7:** received-contract read view. |
| `frontend/src/pages/dashboard.astro` | flat list, `status` badge only | **C6:** live row updates. **C7:** "Received" group. |

### 1.2 New files this bundle introduces

- `backend/src/lib/events.ts` — **[C6]** the `LISTEN`/`NOTIFY` bus + in-process `EventEmitter`; exports `notifyUser()` and a boot function.
- `backend/src/routes/events.ts` — **[C6]** `GET /api/events` SSE endpoint.
- A Drizzle migration under `backend/drizzle/` — **[C7]** generated by `db:generate` for the `origin`/`received` additions.
- Frontend live-update logic on the dashboard + contract page — **[C6]** see §3.5 for the React-island-vs-vanilla-script decision.

### 1.3 The blocker that gates *real* tests (read this before promising "done")

`approach.md` → Known Risks, and Component 4's notes: **Postmark account verification is the critical path.** Until Postmark is approved and `mail.usetend.in` inbound is configured (Component 4 plan §2.1–2.5):
- Component 5's "counterparty receives a threaded reply and replies again" cannot be exercised for real.
- Component 6's "a real reply flips the dashboard live" cannot be exercised for real.
- Component 7's "User A sends to User B's service address and B sees it" cannot be exercised for real.

**You can still build and partially verify all three** against the database/GCS directly and a local tunnel (Component 4 plan §2.5, `cloudflared tunnel`). But per the explicit instruction for this bundle, the **implementation-notes.md must record the real end-to-end runs once Postmark clears** — not synthesized payloads (§10). If Postmark is still pending when you finish coding, mark the affected checklist items **🟡 blocked** and leave the exact commands ready to run, the way Component 4's notes did.

### 1.4 No new environment variables

Everything needed is already in `.env` (confirmed): `DATABASE_URL` (direct), `DATABASE_URL_POOLED`, `POSTMARK_SERVER_API_TOKEN`, `POSTMARK_INBOUND_WEBHOOK_USER/PASS`, `GCS_BUCKET_NAME`, `FRONTEND_URL`, `PUBLIC_API_URL`. **Component 6 specifically needs `DATABASE_URL` (the direct, non-pooled URL)** — see §3.1, the single most important infra detail in this plan.

---

## 2. Component 5 — In-Thread Reply / Negotiation Loop

**Goal:** the user can counter from inside the app — a written message plus, optionally, a revised PDF — and the exchange threads correctly so the counterparty's next reply still matches the contract. This is *our* side of each round; Component 4 already captures *their* side for unlimited rounds.

**No schema change. No new infra.** Pure additive backend endpoint + frontend composer.

### 2.1 Backend — `POST /api/contracts/:id/reply` (in `contracts.ts`)

Behind `requireAuth`. Multipart (`message` text, optional `file`). Steps:

1. **Ownership:** load the contract scoped to `user.id` (same pattern as `/:id/send`, contracts.ts:88). Miss → `404`.
2. **State guard:** only allow a reply when it is the user's turn — i.e. the latest thread entry is `inbound` (status is `replied`, or `received` for a Component 7 contract). Otherwise `409` (mirrors the `draft`-only guard on `/send`). The frontend also hides the composer, but the backend enforces (Principle 5).
3. **Find the message to thread against:** query the latest **inbound** `contract_threads` row for this contract — `where contractId = :id AND direction='inbound' ORDER BY emailDate DESC LIMIT 1`. Its `postmarkMessageId` is the bare-normalized id (see §2.2). This is the message our reply answers.
4. **Optional attachment:** if `file` present, validate PDF + ≤20 MB (reuse the `/upload` checks, contracts.ts:33–38), store to `contracts/{userId}/{contractId}/reply-{Date.now()}.pdf` via `contractsBucket.file(key).save(...)`. Collect `{filename, contentType, storageKey, sizeBytes}` — identical shape to the inbound attachment metadata.
5. **Send via Postmark:** call the extended client (§2.2) from the user's service address (`getServiceEmailByUserId`), with threading headers and the PDF if present. Capture the returned bare `MessageID`.
6. **Persist (one outbound thread row + status flip):**
   - `INSERT contract_threads` `direction='outbound'`, `postmarkMessageId = <bare MessageID from Postmark>`, `inReplyToMessageId = <the inbound row's postmarkMessageId from step 3>`, `fromAddress = service address`, `toAddress = contract.recipientEmail`, `subject = 'Re: ' + contract.subject`, `bodyText = message`, `attachments = [...]`, `emailDate = new Date()`.
   - `UPDATE contracts SET status='sent', updatedAt=now()` — the turn toggle: user replied → `sent` (awaiting counterparty). (No new enum value; reuses the existing toggle exactly as `approach.md` specifies.)
7. **Notify (Component 6 seam):** `notifyUser(user.id, { contractId, status: 'sent' })`. Until Component 6 lands this import won't exist — build 5 first, wire this one line when 6's `events.ts` exists, or stub `notifyUser` as a no-op in 5 and replace in 6. Prefer: build 5, add the call in 6 to avoid a dangling import.

### 2.2 Backend — threading headers in `postmarkClient.ts` (the matching-critical part)

The current `sendContractEmail()` (postmarkClient.ts:15–35) sets a fixed body and **no** `Headers`. Replies need three things; extend `sendContractEmail` with optional params or add a sibling `sendReplyEmail({ ..., inReplyToMessageId, references, bodyText, attachment? })`:

- `Subject: 'Re: ' + originalSubject`.
- `Headers: [{ Name: 'In-Reply-To', Value: '<{id}@{domain}>' }, { Name: 'References', Value: '<{id}@{domain}>' }]` — Postmark's `sendEmail` accepts a `Headers` array.
- The optional PDF in `Attachments` (same shape as the original send).

**The crux — get this right or round 4+ breaks (cross-ref Component 4 plan §5 and notes §2):**

- **What makes OUR matching work** is *not* the `In-Reply-To` we set on the outgoing reply. It is that we store **our outbound reply's bare Postmark `MessageID`** on the new outbound `contract_threads.postmarkMessageId`. When the counterparty replies to our reply, *their* client sets `In-Reply-To: <ourMessageId@domain>`; Component 4's `normalizeMessageId()` strips it to the bare UUID and matches our stored row. This already works — just make sure step 6 above stores the bare `MessageID` Postmark returns (it does return bare; `sendContractEmail` already uses `response.MessageID`).
- **What the `In-Reply-To`/`References` headers WE set are for** is the counterparty's *email client* keeping the exchange visually threaded. To point them at the right message you need the **inbound email's own `Message-ID` header** (what the counterparty's message advertised), not Postmark's assigned inbound id. Today the webhook stores only the *normalized Postmark* id on the inbound thread row (webhooks.ts:194, 211) and the raw `Message-ID` header is only in `inbound_emails.raw_payload.Headers`. **Decision for the implementer:** either (a) when sending the reply, reconstruct `<{storedInboundMessageId}@mail.usetend.in>` (good enough for the POC — most clients thread on it), or (b) extend the webhook to also persist the raw inbound `Message-ID` header on the thread row and use that. Pick (a) for the POC unless real testing shows clients don't thread; document the choice in the notes.

> Do **not** invent a second message-id representation. Component 4 settled on "bare UUID is canonical on both store and match." Stay consistent: store bare, match bare, and only dress it up as `<bare@domain>` at the moment you hand a header to an email client.

### 2.3 Frontend — reply composer on `contracts/[id].astro`

The page today renders the thread and a send-form using a **vanilla `<script define:vars>`** block (contracts/[id].astro:104–152) — no React island despite `@astrojs/react` being installed. **Match the shipped pattern: add the composer as another vanilla `<script>` + markup block** (lowest friction, consistent with the page). React is available if you prefer an island, but don't introduce hydration just for this — note the choice either way.

- Render the composer **only when it is the user's turn** — i.e. the latest thread entry is `inbound` (equivalently `status==='replied'` or `'received'`). The page already has `contract.status`; compute "latest is inbound" from `threads[0]` (threads come back `ORDER BY emailDate DESC`, so `threads[0]` is newest — see contracts.ts:73–76).
- Fields: a `<textarea name="message">` + an optional `<input type="file" accept="application/pdf">` + a Send button.
- On submit: `fetch(.../reply, { method:'POST', body: FormData, credentials:'include' })`. On success, reload (the page already uses `window.location.reload()` after send, contracts/[id].astro:125) — Component 6 will replace the reload with a live append, but a reload is the correct fallback for 5 in isolation.

### 2.4 Component 5 done-criteria (real, once Postmark is live)

1. From a `replied` contract: write a counter-message, attach a revised PDF, send.
2. Verify: a new **outbound** `contract_threads` row with a bare `postmarkMessageId` and the attachment in GCS at `contracts/{userId}/{contractId}/reply-{ts}.pdf`; `contracts.status='sent'`; the composer disappears (not your turn).
3. The counterparty receives a properly threaded `Re:` email **with the PDF attached**, in the same visual thread.
4. Counterparty replies again → Component 4 matches their `In-Reply-To` against *this* outbound message → thread continues, status → `replied`, composer reappears. **Repeat once more to prove 3+ rounds chain.**

---

## 3. Component 6 — Live Dashboard Updates (SSE + `LISTEN`/`NOTIFY`)

**Goal:** the dashboard and contract page update in ~1–2s when a reply (4/5) or a received contract (7) changes a row — no manual refresh. Replaces the "refresh after 20s" placeholder (Issue 2).

### 3.1 ⚠️ CRITICAL infra detail — `LISTEN` must use the DIRECT Neon URL, not the pooled one

This is the single most likely thing to silently break Component 6, and it is specific to this stack:

- `backend/src/db/client.ts` connects with `DATABASE_URL_POOLED` (the Neon **pooler** endpoint). Neon's pooler is **PgBouncer in transaction-pooling mode**, which **does not support session-level `LISTEN`** — a `LISTEN` issued there will not reliably receive notifications because the session isn't pinned to one backend.
- **Therefore `lib/events.ts` must open its own dedicated connection on `DATABASE_URL` (the DIRECT endpoint)** — the same URL `drizzle.config.ts` already uses for migrations, and the same one Better Auth's `pg` Pool uses. One long-lived direct connection per Cloud Run instance, used only for `LISTEN`.
- **`NOTIFY`** is a one-shot statement that takes effect on commit and is safe to issue over the pooled `db` connection (it doesn't need a pinned session). For symmetry and to avoid any pooler edge case, you may issue it over the same direct connection — implementer's call; document it.

> If you skip this and run `LISTEN` on the pooled URL, local single-instance dev may *appear* to work intermittently and then fail in production. Use the direct URL from the start.

### 3.2 Backend — `lib/events.ts`

- On boot, open one dedicated `postgres(DATABASE_URL, { max: 1 })` connection and call `sql.listen('user_updates', (payload) => emitter.emit('user_updates', JSON.parse(payload)))` (postgres-js `.listen()` keeps the line open and auto-reconnects).
- Maintain a module-level `EventEmitter` that the SSE route subscribes to.
- Export `notifyUser(userId: string, data: { contractId: string; status: string })` → runs `NOTIFY user_updates, '{json including userId}'`. The channel is shared (`user_updates`); the **payload carries `userId`** and the SSE route filters by it. (A per-user channel name is the alternative; a single channel + filter is simpler and fine at POC scale — document the choice.)
- Export `bootEventsListener()` to be called from `index.ts`.

### 3.3 Backend — `routes/events.ts` → `GET /api/events` (SSE)

- Behind `requireAuth` (the `better-auth.session` cookie rides along; CORS already allows credentials for `FRONTEND_URL`).
- Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Hono supports streaming responses (`return c.body(stream)` / `streamSSE` from `hono/streaming`).
- **On connect, per Principle 7:** the durable truth is the DB row, so the client refetches current state on (re)connect (§3.5). The server side just needs to start streaming; it does not have to replay history.
- Subscribe this request to the `events.ts` `EventEmitter`; for each event, **filter to `payload.userId === c.get('user').id`** and write `event: status\ndata: {json}\n\n`.
- Send a periodic `: ping\n\n` comment (e.g. every 25s) so Cloudflare/Cloud Run don't time out the idle connection.
- On client disconnect (`c.req.raw.signal` abort), remove the emitter listener — **no leak**: every open SSE connection holds a listener; not cleaning up leaks listeners across reconnects.

### 3.4 Backend — wire `index.ts` and the three `notifyUser` call sites

- `index.ts`: call `bootEventsListener()` once before/after `serve()` so the instance's `LISTEN` line is live for its whole lifetime.
- Add `notifyUser(ownerId, { contractId, status })` at exactly three points, all *after* the DB status write:
  1. End of `processInbound()` in `webhooks.ts`, in the **matched** branch (after `status='replied'`, ~webhooks.ts:227).
  2. The Component 5 reply path (§2.1 step 7), after `status='sent'`.
  3. The Component 7 received-contract branch (§4.2), after creating the `received` row — `notifyUser(recipientId, ...)`.

### 3.5 Frontend — live updates on dashboard + contract page

Two surfaces. The page today is server-rendered Astro with a vanilla `<script>`. Add a small client script (or a React island — your call, but **the shipped pattern is vanilla scripts**; pick one and be consistent):

- Open `new EventSource(`${apiUrl}/api/events`, { withCredentials: true })`.
- **On `onopen` (and reconnect): refetch current state** — dashboard refetches `GET /api/contracts`; contract page refetches `GET /api/contracts/:id`. This is the Principle-7 guarantee: a push dropped during a reconnect gap is invisible because every connect re-reads the truth.
- On each `status` event: on the dashboard, update the matching row's badge/group in place (match by `contractId`); on the contract page, if the event is for *this* contract, refetch and re-render the thread (so a Component 5/4 reply appears without a manual reload — this replaces the `window.location.reload()` fallback from §2.3).
- `EventSource` auto-reconnects on drop; combined with refetch-on-connect, the Cloud Run ~5–60min connection cap is seamless.

### 3.6 Component 6 done-criteria

1. Open the dashboard. Trigger a reply (Component 4) from another account (or, before Postmark, fire a manual `NOTIFY user_updates, '{"userId":"…","contractId":"…","status":"replied"}'` from a `psql`/direct-connection session).
2. Without refreshing, the row moves to "needs attention"/`replied` within ~1–2s.
3. DevTools → offline → online: the island reconnects and state is still correct (refetch-on-connect proven).
4. Scale-to-zero: with no dashboard open, Cloud Run reports 0 instances; opening the dashboard spins one up and SSE connects. (Verify in the Cloud Run console once deployed.)
5. **No listener leak:** open/close the dashboard 10× and confirm the backend isn't accumulating emitter listeners (log listener count, or watch memory).

> Develop against a manual `NOTIFY` while Postmark is pending; re-verify with a real reply once it clears.

---

## 4. Component 7 — Intra-domain Received-Contract Inbox

**Goal:** when a Genie user sends a contract to another Genie user's service address, the recipient sees it in-app as a received contract (Issue 1). Closes the gap where the unmatched-inbound branch (Component 4) drops the email into a `contract_id='unknown'` placeholder.

### 4.1 Schema migration (additive — the only schema change in this bundle)

In `backend/src/db/schema.ts`:
- Add `received` to `contractStatusEnum` (currently 8 values, schema.ts:36–45). **Postgres enums: new values must be appended** (`ALTER TYPE ... ADD VALUE`) — drizzle-kit handles this, but it cannot run inside a transaction with other DDL on some PG versions; if `db:push` complains, add the enum value in its own step.
- Add `export const contractOriginEnum = pgEnum('contract_origin', ['created','received'])`.
- Add `origin: contractOriginEnum('origin').notNull().default('created')` to `contracts` (schema.ts:87–133).
- Run `npm run db:generate` then `npm run db:push`. **`tablesFilter` in `drizzle.config.ts` already protects Better Auth's four tables** — confirm the generated migration touches only `contracts`/the enum and emits **no `DROP`**.

**Two existing-index facts that make this safe:**
- `contracts_postmark_msg_id_uidx` is a unique index on `postmark_message_id`. A received contract has `postmark_message_id = NULL`; Postgres allows multiple NULLs in a unique index, so multiple received contracts are fine.
- `recipient_name`/`recipient_email` follow the **counterparty convention**: for a `received` contract they hold the *sender's* details. No new column pair.

### 4.2 Backend — the received-contract branch in `processInbound()` (`webhooks.ts`)

Today (webhooks.ts:136–233) the flow is: resolve recipient user → normalize `In-Reply-To` → match `contract_threads.postmarkMessageId` → if matched, reply path; **if unmatched, write a placeholder row with `contract_id='unknown'`** (webhooks.ts:208–210, 228–233). Component 7 replaces *only the unmatched branch*:

- **Matched** (`In-Reply-To` resolves to one of *this user's* outbound threads) → unchanged Component 4 reply path.
- **Unmatched AND the `OriginalRecipient` resolves to a Genie user** (it does — we're inside `processInbound` past the `getServiceEmailByLocalPart` check, webhooks.ts:122) → **received-contract path:**
  1. Create a `contracts` row **owned by the recipient** (`serviceEmail.userId`): `origin='received'`, `status='received'`, `title` = the email subject (or attachment filename), `recipientName`/`recipientEmail` = the **sender** (`payload.FromFull`), `storageKey` = the stored attachment (see step 2), `originalFilename`, `mimeType`, `fileSizeBytes`, `subject`.
  2. The attachment is currently uploaded to `inbound/{userId}/{messageId}.pdf` for unmatched mail (webhooks.ts:174–176). For a received contract, upload (or copy) it to `contracts/{recipientId}/{newContractId}/original.pdf` so it behaves like any other contract's original. Generate the `newContractId` first so the key is known before insert.
  3. `INSERT contract_threads` `direction='inbound'` against the new contract id (instead of `'unknown'`), carrying the body + attachment metadata.
  4. `notifyUser(serviceEmail.userId, { contractId: newId, status: 'received' })` (Component 6 seam).
- **Genuinely unroutable mail** (no `In-Reply-To` match *and* — can't happen today since local-part already resolved; keep a defensive `else` that logs + keeps the `inbound/{userId}/{messageId}.pdf` fallback so nothing is lost). Do **not** delete the `inbound_emails` raw row — Component 4's notes rely on it for replay.

> **Distinguishing reply vs received is purely "did `In-Reply-To` match one of THIS user's outbound threads."** That logic already exists (webhooks.ts:137–149); you're just giving the no-match case a real home instead of a placeholder.

### 4.3 Backend — dashboard grouping (grounding correction)

`approach.md` describes a `sort_group` `CASE` query, **but the shipped `GET /api/contracts` does not implement it** — it is a plain Drizzle `findMany` ordered by `createdAt DESC` (contracts.ts:14–22). For Component 7's "Received" group you must choose:
- **(Recommended, per Principle 1)** replace the list query with the raw `sort_group` SQL from `approach.md` (Key Queries → Dashboard list), where `received` maps to group 1 ("needs attention"). Return rows pre-ordered; the frontend just breaks on `sort_group` change.
- **(Simpler)** keep `findMany` and group client-side by `status`. Acceptable for the POC but violates the "frontend receives, doesn't decide" principle.

Document which you chose and why. If you adopt the raw query, also surface `origin` in the response (the frontend uses it to label received contracts).

### 4.4 Frontend — Received group + received-contract view

- **Dashboard (`dashboard.astro`):** render a "Received" section for `origin==='received'` / `status==='received'` rows (driven by §4.3). Reuse the existing list markup.
- **Contract page (`contracts/[id].astro`):** a received contract renders read-first — sender (`recipientName`/`recipientEmail` = the sender), received date, the original PDF download (existing `/download-url`), and the thread. The **Component 5 reply composer appears** because the latest entry is inbound (it's B's turn) — this is how B counters back to A, threaded onto B's `received` contract.

### 4.5 Component 7 done-criteria (real — needs two Genie accounts + Postmark)

1. As User A, send a contract to **User B's service address** (`…@mail.usetend.in`).
2. As User B, the contract appears under "Received" **live** (via Component 6), PDF downloadable.
3. A new `contracts` row exists for B: `origin='received'`, `status='received'`, `recipient_*` = A's details, `original.pdf` at `contracts/{B}/{newId}/original.pdf`.
4. As User B, use the Component 5 composer to counter back to A; confirm A receives it as a threaded reply on A's contract.
5. **Regression:** an external (non-Genie) reply still follows the Component 4 reply path, not this branch — i.e. a reply to an existing sent contract still matches and flips to `replied`, and does NOT create a phantom received contract.

---

## 5. Cross-Component Build / Verify Order (the DAG)

Each step ends with a checkable done-criterion. Do not advance past a step whose criterion fails.

1. **C5 backend** — `POST /:id/reply` + Postmark threading headers. *Done:* unit/curl — a `replied` contract + a multipart reply creates an outbound thread row (bare `postmarkMessageId`), flips status to `sent`; non-owner → 404; not-your-turn → 409.
2. **C5 frontend** — reply composer (vanilla script). *Done:* composer shows only when latest entry is inbound; submitting reloads and shows the new outbound entry.
3. **C6 infra** — `lib/events.ts` on the **DIRECT** URL + `bootEventsListener()` in `index.ts`. *Done:* a manual `NOTIFY user_updates, '{...}'` from `psql` reaches the in-process emitter (log it).
4. **C6 SSE route** — `GET /api/events`. *Done:* `curl -N --cookie …` streams `: ping` and a `status` event after a manual `NOTIFY`; unauth → 401; disconnect removes the listener.
5. **C6 wiring** — add `notifyUser()` to the C4 matched branch and the C5 reply path. *Done:* a status change in either path emits exactly one event to the owning user only.
6. **C6 frontend** — `EventSource` + refetch-on-connect on dashboard + contract page. *Done:* §3.6 criteria 1–5.
7. **C7 schema** — `origin` enum/column + `received` status; `db:generate` + `db:push`. *Done:* migration touches only `contracts`/enum, **no DROP**, Better Auth tables untouched; `received`/`origin` queryable.
8. **C7 webhook branch** — received-contract path replaces the unmatched placeholder; `notifyUser(recipientId, …)`. *Done:* an inbound to a Genie address with no `In-Reply-To` match creates a `received` contract for that user (verified by seeding a direct payload over the tunnel) and emits a live event.
9. **C7 dashboard grouping + received view** — §4.3/§4.4. *Done:* received contracts appear under "Received"; opening one shows sender + download + composer.
10. **Full real round-trip (gated on Postmark §1.3)** — run §2.4, §3.6, §4.5 with real mailboxes/accounts. *Done:* all three components' real criteria pass; record in the notes (§10).

---

## 6. Security & Correctness Checklist (carry forward from Components 1–4)

- **Reply attachment storage** reuses the per-contract key scheme; download stays behind the existing `/:id/attachment` ownership+key-in-thread check (contracts.ts:164–204). Do **not** add a new "sign any key" path.
- **Reply endpoint** enforces ownership and turn server-side (Principle 5) — the hidden composer is UX only.
- **SSE filtering** must be by authenticated `user.id`, never a client-supplied id — otherwise one user could subscribe to another's events. Filter server-side in `routes/events.ts`.
- **`NOTIFY` payload** carries only `{userId, contractId, status}` — no document content, no PII beyond ids (Principle 6). The frontend refetches the real row through the authenticated API.
- **Body rendering** stays `bodyText` only (Astro auto-escapes); do not start rendering attacker-controlled `bodyHtml` (Component 4 notes §5).
- **Received-contract branch** must not let a crafted inbound forge a contract into *another* user's account — the owner is always `serviceEmail.userId` resolved from `OriginalRecipient`, never from the email body.

---

## 7. Known Risks (specific to this bundle)

- **Pooler vs `LISTEN`** (§3.1) — the top risk. Direct URL only for the listen connection.
- **Postmark verification** (§1.3) — gates every *real* test. Build against tunnel + manual `NOTIFY` meanwhile.
- **Multi-round matching** (§2.2) — store bare `MessageID` on the outbound reply row, or round 4+ silently stops matching. This is the same bug class Component 4 fixed; don't reintroduce it.
- **SSE behind Cloudflare/Cloud Run** — buffering/timeouts; mitigated by keep-alive pings + refetch-on-connect + `EventSource` auto-reconnect.
- **Listener leaks** — every SSE connect adds an emitter listener; the abort handler must remove it.
- **Enum migration ordering** — adding a value to `contract_status` may need its own non-transactional step (§4.1).
- **Dashboard query drift** — `approach.md` describes a `sort_group` query the code doesn't have (§4.3); decide explicitly rather than assuming it exists.

---

## 8. What NOT to build in this bundle

- **AI analysis (Component 8)** — `triggerAiPipeline` (webhooks.ts:258) stays a no-op stub. Do not start the diff/LLM pipeline; it builds *after* 5/6/7 are verified end-to-end.
- **A side-by-side version-history browser** — out of POC scope (`approach.md` Scope Boundary). Per-round documents accumulate as separate `reply-{ts}.pdf` objects and thread rows; that's enough.
- **WebSockets** — SSE only.
- **Per-user `LISTEN` channels / a message queue** — one shared channel + payload filter is the POC design.
- **Decoupling service addresses from `mail.usetend.in`** — explicitly out of scope (open-issues Issue 1 decision).
- **Reminders / notifications beyond the live dashboard** — out of scope.

---

## 9. Reference — files & endpoints after this bundle

```
backend/src/
  lib/events.ts          NEW [C6]  LISTEN (DIRECT url) + EventEmitter + notifyUser()
  routes/events.ts       NEW [C6]  GET /api/events (SSE, requireAuth, user-filtered)
  routes/contracts.ts    EDIT [C5] POST /:id/reply; [C7] dashboard grouping query
  routes/webhooks.ts     EDIT [C6] notifyUser in matched branch; [C7] received-contract branch
  services/postmarkClient.ts EDIT [C5] threading headers + optional attachment
  db/schema.ts           EDIT [C7] contract_origin enum, origin column, 'received' status
  index.ts               EDIT [C6] bootEventsListener()
  app.ts                 EDIT [C6] mount /api/events
  drizzle/               NEW [C7]  generated migration

frontend/src/pages/
  contracts/[id].astro   EDIT [C5] reply composer; [C6] live thread; [C7] received view
  dashboard.astro        EDIT [C6] live rows; [C7] Received group

New endpoint: POST /api/contracts/:id/reply   (C5, requireAuth, multipart)
New endpoint: GET  /api/events                (C6, requireAuth, SSE)
```

---

## 10. Instructions to the implementer — write `implementation-notes.md`

When you finish (or reach the Postmark blocker), write `implementation-notes.md` **in this folder**, modeled on `plans/component-04-inbound/implementation-notes.md`. It is the *as-built* record — what actually landed, not what was intended. It **must** contain these sections:

1. **Files touched** — a table: path → what changed → why (like Component 4 notes §1). Be honest about deviations from this plan and *why* you deviated.
2. **As-built walkthrough, per component (5, 6, 7)** — the actual flow that shipped: the `/reply` handler step-by-step; the `events.ts` connection/emitter and exactly which URL it uses (confirm DIRECT, §3.1); the SSE route's headers, filtering, ping, and cleanup; the webhook received-branch; the schema migration diff. Call out every decision this plan left to you (composer as vanilla-script vs React island §2.3/§3.5; In-Reply-To header strategy (a) vs (b) §2.2; shared-channel vs per-user §3.2; dashboard raw-query vs client grouping §4.3) and **which you chose and why.**
3. **Setup guide** — everything a teammate needs to run this locally from scratch: env vars used (and that `DATABASE_URL` direct is required for `LISTEN`), `npm install`, `db:generate`/`db:push` for the C7 migration, `npm run dev` for both servers, the `cloudflared tunnel` step and Postmark inbound URL config (cross-ref Component 4 plan §2.5), and how to fire a manual `NOTIFY` from `psql` for testing C6 before Postmark clears.
4. **Complete end-to-end tests — REAL, not synthesized** — this is the explicit requirement for this bundle. Record the **actual real runs** you can see end-to-end:
   - **C5:** a real reply with a revised PDF reaching a real external mailbox, threaded, and the counterparty's next real reply matching back (≥3 rounds).
   - **C6:** a real reply flipping a real open dashboard live within ~1–2s, plus the offline→online reconnect test and the scale-to-zero observation.
   - **C7:** two real Genie accounts — A sends to B's service address, B sees it live under "Received", B counters back to A.
   For each test: the steps you ran, the observed DB rows / GCS objects / UI state, and the result. **Do not substitute synthesized Postmark payloads for the "done" bar.** If Postmark is still verifying, mark the affected tests **🟡 blocked**, leave the exact commands/steps ready to run, and state plainly what remains — exactly as Component 4's notes did. The bar is "a test I can see," end to end.
5. **Verification matrix** — a table mapping each done-criterion in §2.4 / §3.6 / §4.5 / §5 to what you ran and the result (✓ / 🟡 blocked / ✗), like Component 4 notes §6.
6. **Operational knobs / extension points** — e.g. SSE channel naming, ping interval, where Component 8's AI hook plugs into the now-live received/reply flows.
7. **What's left for whoever finishes** — any blocked item (Postmark) with the precise next action.
