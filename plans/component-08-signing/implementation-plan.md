# Component 8 — E-Signature via Dropbox Sign
## Implementation Plan (standalone)

**Written:** 2026-05-26
**Component:** 8 — E-Signature via Dropbox Sign (multi-party, ordered, signers need no account; webhook-driven lifecycle; executed-PDF retrieval).
**Status:** ⬜ not started.
**What it covers:** turning an agreed contract into a fully executed, signed PDF via the Dropbox Sign email-link flow — the **destination of the whole product**. Adds one send endpoint, one webhook, one download endpoint, a signers table + signing enums, a Dropbox Sign service client, and the signing UI on the existing thread/dashboard.

**Depends on (grounded in the REAL code state, not approach.md's status markers):**
- **Components 1–4 built** (auth, service email, upload, dashboard, send, GCS, Postmark inbound). Component 4's *real* Postmark round-trip was test-blocked on account verification; that does **not** block Component 8 — Dropbox Sign is a separate inbound channel that you can fully exercise in test mode independent of Postmark.
- **Components 5/6/7 are BUILT IN CODE** despite approach.md's build-plan marking them ⬜ "not started" (that section is stale). Verify by reading: `POST /:id/reply` exists (`backend/src/routes/contracts.ts:208`), the SSE bus exists (`backend/src/lib/events.ts`), the SSE route exists (`backend/src/routes/events.ts`), and the received-contract branch exists (`backend/src/routes/webhooks.ts:152-170, 260-299`). The dashboard list already runs the `sort_group` raw query (`contracts.ts:32-63`).
- **Signing's live-update piece reuses the existing Component-6 seam:** every signing status write calls `notifyUser(ownerId, { contractId, status })` from `backend/src/lib/events.ts` (interface `UserUpdatePayload = { userId; contractId; status }`, `events.ts:25-29`). Do **not** invent a second push channel.
- Does **not** depend on Component 9 (AI diff) — signing stands alone and ships first.

---

## 0. Why this is the core deliverable

Every component before this exists to carry a finished contract to the moment of signature. Component 8 is the product's reason to exist: the user gets a contract **signed by every required party** — multi-party, in a defined order, with signers who need **no Genie account** and never leave an email link — entirely inside Genie, driven by webhooks, with the executed PDF pulled into our storage on completion. The email/negotiation/AI plumbing is in service of this one outcome: a fully executed contract.

---

## 1. SDK & dependency additions

- **`@dropbox/sign@1.11.0`** (published 2026-05-19, stable 1.x). Add to `backend/package.json` `dependencies` (alongside `postmark`, `@google-cloud/storage`). Install:
  ```bash
  cd backend && npm install @dropbox/sign@1.11.0
  ```
  The SDK ships its own TypeScript types — do **not** add an `@types/dropbox__sign`.
- No peer deps required; `fs` (`createReadStream`) is Node built-in. We re-read the PDF from GCS into a Buffer and pass it via `fs`-stream or a `RequestFile`-compatible value (see §7).
- **Not this component:** `diff` / `pdf-parse` / `react-diff-viewer-continued` (those are Component 9). Do not pull them in here.
- **Env vars** (add to `backend/.env` and `.env.example`; production = GCP Secret Manager → Cloud Run): `DROPBOX_SIGN_API_KEY` (also the HMAC key used to verify webhook `event_hash`), `DROPBOX_SIGN_TEST_MODE=true`. Add a **commented** `# DROPBOX_SIGN_CLIENT_ID=` note only — it is embedded-signing-only and unused here. (approach.md "Environment Variables" already lists these; mirror exactly.)

---

## 2. What already exists — extend, do not rebuild

Grounded against the current code (line numbers verified 2026-05-26):

| File | Today | What C8 adds |
|---|---|---|
| `backend/src/routes/contracts.ts` | `GET /`, `POST /upload`, `GET /:id`, `POST /:id/send` (`:122`), `POST /:id/reply` (`:208`), `GET /:id/download-url` (`:358`), `GET /:id/attachment` (`:380`) | **ADD** `POST /:id/send-for-signature` and `GET /:id/signed-document`. Reuse the ownership pattern (`findFirst where id AND userId`, `:129-135`/`:213-215`), the GCS re-read (`contractsBucket.file(key).download()`, `:144`), and the `notifyUser(...).catch(...)` call shape (`:180-182`). |
| `backend/src/routes/webhooks.ts` | `POST /postmark/inbound` with `verifyPostmark()` (`:16`), `normalizeMessageId()` (`:37`), idempotency insert into `inbound_emails` (`:75-90`), async `processInbound()` (`:112`), `markInboundProcessed()` (`:363`), `triggerAiPipeline()` stub (`:373`) | **ADD** `POST /dropbox-sign/inbound` (full path `/webhooks/dropbox-sign/inbound`). **MIRROR** the verify→idempotency→async→`notifyUser` pattern, but with the Dropbox Sign specifics (multipart `json` parse, `event_hash` verify, `Hello API Event Received` response). |
| `backend/src/lib/events.ts` | `CHANNEL='user_updates'`, `eventBus`, `bootEventsListener()`, `notifyUser(userId,{contractId,status})`, `UserUpdatePayload` (`:25-29`) | **No change.** Call `notifyUser` after every signing status write. |
| `backend/src/db/schema.ts` | `contractStatusEnum` ends `…,'declined','received'` (`received` MUST stay last, `:36-49`); `threadDirectionEnum=['outbound','inbound']` (`:51-54`); `contractOriginEnum` (`:58-61`); `contracts` table (`:98-149`), indexes at `:143-148`; `contractThreads` (`:155-200`) | **APPEND** new `contract_status` values; **APPEND** `'system'` to `threadDirectionEnum`; **ADD** `contract_signers` table + `signerStatusEnum`/`signerRoleEnum`; **ADD** `signatureRequestId` + `signedStorageKey` columns to `contracts`. See §6. |
| `backend/src/lib/storage.ts` | exports `storage`, `contractsBucket`, `generateDownloadSignedUrl(storageKey, expiresInSeconds=3600)` | **No change.** Store executed PDF via `contractsBucket.file(key).save(buffer,…)` (same call as `contracts.ts:87`); serve via `generateDownloadSignedUrl`. |
| `backend/src/app.ts` | mounts `/api/contracts`, `/webhooks`, `/api/events`; CORS allows `FRONTEND_URL` + `credentials:true` (`:20-25`) | **No change** — the new routes mount under the already-mounted `/api/contracts` and `/webhooks` routers. |
| `backend/src/index.ts` | calls `bootEventsListener()` on boot (`:12`) | **No change.** |
| `backend/drizzle.config.ts` | `tablesFilter` lists `service_emails, contracts, contract_threads, inbound_emails` (`:15-20`) | **ADD** `'contract_signers'` to `tablesFilter` so drizzle-kit manages it and never DROPs Better Auth tables. |
| `frontend/src/pages/contracts/[id].astro` | thread render + send/reply forms in **vanilla `<script define:vars>`** (`:127-230`); SSE wired, `status` event → `window.location.reload()` (`:204-229`) | **ADD** the "Send for Signature" signer form, per-signer signing timeline, "Download signed contract" button — as vanilla script/markup (see §11). |
| `frontend/src/pages/dashboard.astro` | grouped list (`sort_group`), SSE reload on `status` (`:129-151`) | **ADD** an "Awaiting your signature" card for Genie-user signers (see §11). |

---

## 3. New files this component introduces

- `backend/src/services/dropboxSignClient.ts` — **NEW** the `@dropbox/sign` wrapper: `sendSignatureRequest()`, `verifyCallback()`, `downloadSignedFile()`. (Routes-vs-services rule: the route handles HTTP; this service talks to Dropbox Sign — approach.md "Project Structure".)
- A Drizzle migration under `backend/drizzle/` — **NEW**, generated by `npm run db:generate` for the schema additions in §6. (Today only `backend/drizzle/meta/` exists; the project applies schema with `db:push`. Generate first to eyeball the SQL, then push.)
- Frontend signing UI — **extends** the two existing `.astro` pages (no new component files required if you follow the shipped vanilla-script pattern; see §11 for the island tradeoff).

---

## 4. Schema migration (exhaustive)

All changes are **additive**. The two hard Postgres constraints: enum values can **only be appended** (never inserted mid-list or removed), and `tablesFilter` must include any new table or drizzle-kit will try to DROP everything outside the list.

### 4.1 Enum changes (append-only)

**`contractStatusEnum` (`schema.ts:36-49`).** Today the literal array ends with `'declined'` then `'received'`, and the code comment says `received` "MUST stay last: Postgres enum values can only be APPENDED." approach.md's "Enums" section lists `out_for_signature` and `partially_signed` as the new signing statuses and treats `signed` as the terminal success state.

- **`signed` and `declined` ALREADY EXIST** (originally "parties agreed"/"rejected"). **Decision (recommended): REUSE them** as the signing terminal/decline states — `signed` = every party signed + executed PDF stored; `declined` is *not* reused for the signing-decline transition (approach.md's state machine sends a signer decline back to **`negotiating`**, not `declined`, so the parties can revise and re-send). Keep `declined` meaning "rejected outright" and leave it unused by C8's happy/decline paths. Document this in the notes.
- **APPEND** the two genuinely new values **after `received`** (which currently must stay last). After this change the new last value is whatever you append last — update the "MUST stay last" comment to point at the new tail:
  ```ts
  export const contractStatusEnum = pgEnum('contract_status', [
    'draft', 'sent', 'replied', 'ai_processing', 'completed',
    'negotiating', 'signed', 'declined',
    'received',            // [C7] — was last
    'out_for_signature',   // [C8] signature request created, awaiting signatures
    'partially_signed',    // [C8] ≥1 but not all parties signed
    // MUST stay last from here on — Postgres enum values can only be APPENDED.
  ])
  ```
  (`signed` is reused, so it is **not** re-appended.)

**`threadDirectionEnum` (`schema.ts:51-54`).** Today `['outbound','inbound']`. **APPEND** `'system'` for signing-lifecycle thread entries:
  ```ts
  export const threadDirectionEnum = pgEnum('thread_direction', [
    'outbound', 'inbound',
    'system', // [C8] signing-lifecycle event (sent/viewed/signed/all_signed/declined)
  ])
  ```
  Note: `contract_threads.fromAddress`/`toAddress` are `notNull` (`schema.ts:172-173`). For a `system` row, set them to a sentinel (e.g. `from='dropbox-sign'`, `to=contract.recipientEmail ?? 'all-signers'`) or relax those two columns to nullable in the same migration — **recommended: use sentinels** to avoid a column-nullability change (smaller, safer migration). Document the choice.

**New enums:**
  ```ts
  export const signerStatusEnum = pgEnum('signer_status', [
    'pending', 'sent', 'viewed', 'signed', 'declined',
  ])
  export const signerRoleEnum = pgEnum('signer_role', [
    'creator', 'counterparty', 'other', // 'other' = e.g. the user's boss/client who signs
  ])
  ```

### 4.2 New columns on `contracts` (`schema.ts:98-149`)

Add inside the `contracts` table definition, matching the existing column style:
  ```ts
  // [C8] Dropbox Sign request id; the webhook lookup key. Unique; null until sent for signature.
  signatureRequestId: text('signature_request_id'),
  // [C8] GCS key of the executed PDF, e.g. contracts/{userId}/{contractId}/signed.pdf; null until all-signed.
  signedStorageKey: text('signed_storage_key'),
  ```
Add a unique index to the table's index array (`schema.ts:143-148`) — matches the existing `contracts_postmark_msg_id_uidx` convention (multiple NULLs are allowed in a Postgres unique index, so unsent contracts coexist):
  ```ts
  uniqueIndex('contracts_signature_request_id_uidx').on(t.signatureRequestId),
  ```

### 4.3 New table `contract_signers` (derived from approach.md "contract_signers")

One row per party on a signature request. Match the schema.ts conventions exactly: `id()` PK helper (`:17`), `text` user FKs (user.id is TEXT/nanoid, not UUID), `...timestamps` spread (`:22`), index array as the second pgTable arg.
  ```ts
  export const contractSigners = pgTable(
    'contract_signers',
    {
      id: id(),
      contractId: text('contract_id').notNull(),                 // FK → contracts.id
      signatureRequestId: text('signature_request_id').notNull(),// denormalized: webhook resolves signer→contract fast
      dropboxSignatureId: text('dropbox_signature_id'),          // Dropbox Sign per-signer signature_id (from payload)
      signerEmail: text('signer_email').notNull(),               // the address DBX emails the link to (see §8 the two angles)
      signerName: text('signer_name').notNull(),
      signingOrder: integer('signing_order'),                    // DBX `order`; lower signs first; null ⇒ parallel
      role: signerRoleEnum('role').notNull().default('other'),
      genieUserId: text('genie_user_id'),                        // FK → user.id, NULLABLE; set when signer is a Genie user
      status: signerStatusEnum('status').notNull().default('pending'),
      signedAt: timestamp('signed_at', { withTimezone: true, mode: 'date' }),
      ...timestamps,
    },
    (t) => [
      index('cs_contract_id_idx').on(t.contractId),
      index('cs_signature_request_id_idx').on(t.signatureRequestId),
      index('cs_contract_order_idx').on(t.contractId, t.signingOrder),
    ],
  )
  ```
Add the type exports next to the others (`schema.ts:244-251`): `ContractSigner` / `NewContractSigner`.

### 4.4 `drizzle.config.ts` + generate/push

- **Append `'contract_signers'`** to `tablesFilter` (`drizzle.config.ts:15-20`). Without it, drizzle-kit treats the new table as out-of-scope; with `strict:true` it could emit a DROP of unlisted objects — keep the list complete. The four Better-Auth tables (`user`/`session`/`account`/`verification`) stay protected by *exclusion*.
- Run `cd backend && npm run db:generate` → **inspect the generated SQL**: it must only `CREATE TYPE` the two new enums, `ALTER TYPE … ADD VALUE` for the appended `contract_status`/`thread_direction` values, `ALTER TABLE contracts ADD COLUMN`, `CREATE TABLE contract_signers`, and `CREATE … INDEX`. **Confirm NO `DROP TABLE` / `DROP TYPE` / `DROP COLUMN`.** If any DROP appears, stop — `tablesFilter` is wrong.
- **Enum-append caveat (same as Component 7 §4.1):** `ALTER TYPE … ADD VALUE` cannot run inside a transaction with other DDL on some PG versions. If `db:push` errors on the enum step, add the new enum values in their own non-transactional step first, then push the rest.
- Run `npm run db:push`. Verify the new table/columns/enum values are queryable and Better-Auth tables are untouched.

---

## 5. `services/dropboxSignClient.ts` (spec)

Three exported functions. Construct the API client once at module load with HTTP Basic (API key as username):
```ts
import * as DropboxSign from '@dropbox/sign'
const TEST_MODE = process.env.DROPBOX_SIGN_TEST_MODE === 'true'
const API_KEY = process.env.DROPBOX_SIGN_API_KEY!
const signApi = new DropboxSign.SignatureRequestApi()
signApi.username = API_KEY
```

### 5.1 `sendSignatureRequest({ title, subject, message, pdfBuffer, pdfFilename, signers })`
- `signers`: the already-resolved list `{ name, emailAddress, order }[]` (email resolution — the two angles — happens in the route, §8, not here; this function just maps to the SDK).
- Map signers to `DropboxSign.SubSignatureRequestSigner[]` (camelCase `name`, `emailAddress`, `order`).
- Build `SignatureRequestSendRequest`: `{ title, subject, message, signers, testMode: TEST_MODE, files: [<the PDF>] }`. The SDK accepts files as `RequestFile` values; the cleanest path that avoids a temp file is to write the GCS buffer to a `fs`-stream or pass a `RequestFile` built from the buffer. **Recommended:** write the buffer to an OS temp file (`os.tmpdir()`) and pass `fs.createReadStream(tmpPath)` as approach.md/SDK docs show, then unlink it after the call. (If the installed SDK build accepts a Buffer/Blob directly, prefer that and skip the temp file — confirm at build time and document.)
- Call `await signApi.signatureRequestSend(req)`; return `res.body.signatureRequest.signatureRequestId` (confirm the exact response path against the 1.11.0 response type at build time — it is `signatureRequestId` on the request object).
- **camelCase vs snake_case note:** the TS SDK uses camelCase (`testMode`, `emailAddress`); raw API JSON is snake_case (`test_mode`, `email_address`). We are on the SDK → camelCase.

### 5.2 `verifyCallback(eventCallbackData): boolean`
- `const cb = DropboxSign.EventCallbackRequest.init(eventCallbackData)` then `return DropboxSign.EventCallbackHelper.isValid(API_KEY, cb)`.
- `event_hash` = HMAC-SHA256 of (`event_time` + `event_type`) keyed by the API key — the helper does this; do not hand-roll it.
- Optionally expose the callback type via `EventCallbackHelper.getCallbackType(cb)` (→ `"account_callback"` | `"app_callback"`). We use the **account-level** callback (no `client_id`), so expect `account_callback`.

### 5.3 `downloadSignedFile(signatureRequestId): Promise<Buffer>`
- `const res = await signApi.signatureRequestFiles(signatureRequestId, 'pdf')` (use `'pdf'` for the merged single PDF; `'zip'` is for separate docs — we want the merged executed PDF).
- The SDK returns the file bytes; coerce to a Node `Buffer`.
- **409 handling:** `signatureRequestFiles` returns HTTP 409 if files are still being assembled. We only call this on the `signature_request_downloadable` event (when the file is physically ready), so 409 should not normally occur — but catch it defensively, log, and let the webhook return 200 anyway (Dropbox Sign will not re-fire `downloadable`; a manual re-fetch path can be added later). Do **not** call this on `all_signed`.

---

## 6. `POST /api/contracts/:id/send-for-signature` (spec)

Behind `requireAuth`. Body: `{ signers: [{ name, email, order, role }], message? }` (JSON). Steps:

1. **Ownership:** `db.query.contracts.findFirst({ where: and(eq(contracts.id, id), eq(contracts.userId, user.id)) })` — same as `/send` (`contracts.ts:129-135`). Miss → `404`.
2. **State guard (Principle 5 — backend enforces):** only allow when a version is agreed and it's the owner's turn. Accept `status ∈ {'sent','replied','negotiating','completed'}` and reject `draft` / already-in-signing (`out_for_signature`/`partially_signed`/`signed`) with `409`. (Recommended set; document the exact allow-list you choose.)
3. **Validate signers:** `≥1` signer; each has a non-empty `name`, a syntactically valid `email`, an integer `order ≥ 0`, and a `role ∈ {creator,counterparty,other}`. Reject `400` otherwise. Cap at 4 signers (approach.md: 2–4 parties).
4. **Resolve each signer's send-to address — THE TWO ANGLES (correctness-critical):**
   - For each input signer, look up whether `email` belongs to a Genie user (query Better Auth's `user` table by email, or `service_emails`/your user lookup). 
   - **Genie user:** set `genieUserId = user.id`, and **send the Dropbox Sign link to their real Google identity email (`user.email`)** — **NEVER** a `…@mail.usetend.in` service address (that routes to Postmark inbound, has no readable inbox, and a signing link sent there vanishes). If the caller typed a service address for a known Genie user, **override it** with the identity email. 
   - **Non-Genie user:** `genieUserId = null`; send to the typed email as-is.
5. **Re-read the agreed PDF from GCS** — the latest agreed version. Default to `contract.storageKey` (`original.pdf`); if the negotiation produced a newer agreed `reply-{ts}.pdf`, allow the caller to indicate which (optional `storageKey` in body, validated against this contract's thread attachments exactly like `GET /:id/attachment` does, `contracts.ts:401-415`). **Recommended for v1:** sign `contract.storageKey` and document that picking a specific reply version is a follow-up. Download via `contractsBucket.file(key).download()` (`contracts.ts:144`).
6. **Create the request:** `dropboxSignClient.sendSignatureRequest({ title: contract.title, subject: contract.subject ?? `Signature: ${contract.title}`, message, pdfBuffer, pdfFilename: contract.originalFilename, signers: resolvedSigners })` → `signatureRequestId`.
7. **Persist (one transaction recommended):**
   - `UPDATE contracts SET signatureRequestId, status='out_for_signature', updatedAt=now()`.
   - `INSERT` one `contract_signers` row per signer: `{ contractId, signatureRequestId, signerEmail (resolved), signerName, signingOrder, role, genieUserId, status }`. Initial `status`: `'sent'` for the lowest `order` value (Dropbox Sign emails them immediately), `'pending'` for those waiting their turn. If orders are all equal/omitted (parallel), set **all** to `'sent'`. (Webhook events will correct these regardless; this is the optimistic initial state.)
8. **Thread + notify:** `INSERT contract_threads (direction='system', subject='Sent for signature', bodyText=<roster summary>, …)` (sentinel from/to per §4.1); then `notifyUser(user.id, { contractId, status: 'out_for_signature' }).catch(…)` (shape per `contracts.ts:180-182`).
9. Return `{ ok: true, signatureRequestId }`.

**Error cases:** non-owner → 404; bad state → 409; 0 or >4 signers / invalid email / bad order → 400; Dropbox Sign 402 (no paid plan, production mode) → surface a clear 502/400 telling the user test mode must stay on (see Known Risks); service-email mis-resolution must never silently send to a `mail.usetend.in` address (assert post-resolution that no resolved address ends in the service domain — if it does, 400 and log).

---

## 7. `POST /webhooks/dropbox-sign/inbound` (spec)

Mounted on the existing `webhooksRouter` (full path `/webhooks/dropbox-sign/inbound`). **Mirror the Postmark handler's verify→idempotency→async→notify shape** but with Dropbox Sign's three gotchas.

1. **Parse the multipart `json` field (the gotcha):** Dropbox Sign POSTs `multipart/form-data` with ONE field named `json` whose value is the event JSON string — NOT a raw JSON body. 
   ```ts
   const body = await c.req.parseBody()
   const event = JSON.parse(body['json'] as string)
   ```
   (Reading `c.req.json()` like the Postmark handler does — `webhooks.ts:52` — will FAIL here; this is the most common mistake.)
2. **Verify authenticity:** `if (!dropboxSignClient.verifyCallback(event)) return c.text('Unauthorized', 401)`. This is the equivalent of `verifyPostmark()` (`webhooks.ts:16`). Reject with **401** on a bad/absent `event_hash` before trusting anything.
3. **Handle `callback_test`** (dashboard "test" button): verify passes, no `signature_request` body → just return the required 200 body (step 8). Log it.
4. **Idempotency (Principle 4):** build a dedup key from `signature_request_id` + `event_type` + per-signer `signature_id` (signed events fire once per signer). **Recommended:** reuse the `inbound_emails` ledger pattern — either insert a row into `inbound_emails` keyed on this composite (set `postmarkMessageId` to e.g. `dbx:{srid}:{event_type}:{signature_id}` since it's the unique-indexed dedup column) `ON CONFLICT DO NOTHING`, or add a small `signing_events` ledger table. Inserting into `inbound_emails` reuses the existing unique index and keeps one receipt book; document whichever you pick. Zero rows inserted → already seen → return the required 200 body and stop.
5. **Resolve `signature_request_id` → contract:** `signatureRequestId` is on the event's `signature_request` object. `db.query.contracts.findFirst({ where: eq(contracts.signatureRequestId, srid) })`. No match → log, return required 200 (don't 4xx — a stray event must not trigger retries).
6. **Return 200 fast, process async** — same as `processInbound` (`webhooks.ts:98-109`): kick off the state-machine work in a `.catch`-guarded async function so a processing bug never bubbles as non-200.
7. **Event → state mapping** (each followed by `notifyUser(ownerId, { contractId, status })`; append a `direction='system'` `contract_threads` row describing the event):

   | `event_type` | `contract_signers` change | `contracts.status` | thread `system` row | fetch PDF? |
   |---|---|---|---|---|
   | `signature_request_sent` | matched signer → `sent` | (unchanged) | "Sent for signature to {name}" | no |
   | `signature_request_viewed` | matched signer → `viewed` | (unchanged) | "{name} viewed the contract" | no |
   | `signature_request_signed` | matched signer → `signed` + `signedAt=now()` (fires **once per signer**) | → `partially_signed` | "{name} signed" | no |
   | `signature_request_all_signed` | (all already `signed`) | → `signed` | "All parties signed" | no |
   | `signature_request_downloadable` | — | (stays `signed`) | "Executed document ready" | **yes** → `downloadSignedFile(srid)` → save to `contracts/{userId}/{contractId}/signed.pdf` → set `contracts.signedStorageKey` | 
   | `signature_request_declined` | matched signer → `declined` | → `negotiating` | "{name} declined — back to negotiation" | no |

   - **Match the signer** within the request via the per-signer `signature_id` (the event carries which signer it concerns under `signature_request.signatures[].signatureId` and/or the event's signature id); update the `contract_signers` row by `(signatureRequestId, dropboxSignatureId)` or by email if the signature id isn't yet stored — backfill `dropboxSignatureId` on first sight.
   - **`all_signed` vs `downloadable` timing (critical):** mark `signed` on `all_signed`; **fetch the executed PDF on `downloadable`** (the assembled file with audit trail can lag `all_signed` slightly; `signatureRequestFiles` returns 409 before it's ready). Do not fetch on `all_signed`.
   - **Decline → `negotiating`:** the parties revise via the existing reply loop (Components 4/5) and the user sends a **new** `send-for-signature` on the agreed version. Do not reuse the request.
8. **MANDATORY response:** the handler MUST return **HTTP 200 with the exact body text `Hello API Event Received`** on every accepted (verified) request — `return c.text('Hello API Event Received')`. Anything else is a failure: Dropbox Sign retries (1 + 6 attempts over ~30h) and **auto-clears the callback URL after ~10 consecutive failures**. (The 401 on a bad `event_hash` is the only non-200 we ever return.)

**Account-level callback setup:** because we send plain (non-embedded) requests with no `client_id`, register the webhook as the **account-level** callback URL in Dropbox Sign dev settings (not an API-App callback). Document this in the setup guide (§17b).

---

## 8. `GET /api/contracts/:id/signed-document` (spec)

Behind `requireAuth`. Steps:
1. Ownership: `findFirst where id AND userId` (`contracts.ts:362-365` pattern). Miss → 404.
2. **Gate on completion:** if `contract.status !== 'signed'` or `!contract.signedStorageKey` → `409 { error: 'Not signed yet' }`.
3. `const url = await generateDownloadSignedUrl(contract.signedStorageKey)` (v4 signed URL, `storage.ts:11`). Return `{ url, expiresIn: 3600 }`.

(Same security posture as `/download-url` — we sign a key we control, never a client-supplied one.)

---

## 9. Frontend (spec)

The page today is server-rendered Astro with **vanilla `<script define:vars>`** blocks and SSE already wired (`contracts/[id].astro:127-230`; `dashboard.astro:129-151`). **Recommended: follow the shipped vanilla-script pattern** — lowest friction, consistent with Components 5/6/7, and the SSE→`window.location.reload()` mechanism already re-renders server state on every signing event, so live updates come for free. (A React island — `SignerForm.tsx`/`SigningTimeline.tsx` per approach.md "Project Structure" — is the alternative; only introduce hydration if the signer form's add/remove-row UX genuinely needs it. State the choice in the notes.)

1. **"Send for Signature" signer form** on `contracts/[id].astro`. Show only when a version is agreed and it's the owner's turn (`status ∈ {sent,replied,negotiating,completed}` and `origin==='created'` or owner). Fields: a repeatable signer row (name, email, order, role select `creator|counterparty|other`), 1–4 rows; an optional message textarea; a "Send for Signature" button. On submit: `fetch(.../send-for-signature, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signers, message }), credentials:'include' })` → on success `window.location.reload()` (the page already uses reload after send, `:148`).
2. **Per-signer signing timeline** on the thread: render the `system` thread rows in order, plus a roster ("Counterparty viewed → Counterparty signed → Awaiting your boss…"). The roster is driven by the `contract_signers` rows — **add them to `GET /api/contracts/:id`'s response** (extend the detail handler at `contracts.ts:105-119` to also return `signers` ordered by `signingOrder`). Each signing webhook flips status and (via SSE) reloads the page, so the timeline updates live within ~1–2s.
3. **"Download signed contract" button** appears when `contract.status === 'signed'`: calls `GET /:id/signed-document`, opens the returned signed URL (same pattern as the existing attachment download, `:187-202`).
4. **Genie-signer "awaiting your signature" card** on `dashboard.astro`: for the logged-in user, surface contracts where a `contract_signers` row has `genieUserId === user.id` AND `status ∈ {pending,sent,viewed}`. **Recommended:** add these to the dashboard list query (a `LEFT JOIN contract_signers … WHERE genie_user_id = $user`) or a small dedicated `GET /api/me/awaiting-signature` endpoint; render a top card "This contract is awaiting your signature" linking to the contract (where the Dropbox Sign email link is the actual signing path — we surface the prompt, signing still happens on Dropbox Sign's hosted page). The existing SSE reload keeps it live.

---

## 10. Security & correctness checklist (carry forward from Components 1–7)

- **Backend enforces ownership + turn** (Principle 5): `send-for-signature` and `signed-document` both scope the contract to `user.id`; the state-guard is server-side, the disabled button is UX only.
- **Verify `event_hash` before trusting any webhook event** (Principle 4 analog): bad hash → 401. This is the Dropbox Sign equivalent of the Postmark Basic-Auth check.
- **NEVER send a signing link to a `…@mail.usetend.in` service address** — resolve Genie signers to their real identity email; assert post-resolution that no send-to address is in the service domain.
- **Webhook is idempotent** — `signature_request_signed` fires once per signer and Dropbox Sign retries on any non-200; dedup on `(srid, event_type, signature_id)` so a retried event doesn't double-write.
- **Secrets never reach the frontend** (Principle 6): `DROPBOX_SIGN_API_KEY` stays server-side; the `notifyUser` payload carries only `{userId, contractId, status}` — no signer PII, no document content; the frontend refetches the authenticated row.
- **Sign only keys we control:** `signed-document` signs `contract.signedStorageKey` (set by our webhook), never a client-supplied key.
- **The webhook never forges a contract into another account:** the owner is always `contracts.userId` resolved from `signature_request_id`, never from the event body.
- **Mandatory `Hello API Event Received` 200** on every verified event, or the callback URL self-destructs.

---

## 11. Cross-component BUILD / VERIFY DAG

Each step ends in a checkable done-criterion. Do not advance past a failing step. (Modeled on the Component 5/6/7 plan §5.)

1. **Deps + env** — `npm install @dropbox/sign@1.11.0`; add `DROPBOX_SIGN_API_KEY`, `DROPBOX_SIGN_TEST_MODE=true`. *Done:* `import * as DropboxSign from '@dropbox/sign'` compiles; a tiny script constructs `SignatureRequestApi` with the key.
2. **Schema migration** — append enum values, add `contract_signers` + `signer_*` enums + the two `contracts` columns; add `'contract_signers'` to `tablesFilter`; `db:generate` then `db:push`. *Done:* generated SQL has **no DROP**; Better-Auth tables untouched; `contract_signers`, `signature_request_id`, `out_for_signature`, `partially_signed`, `system` all queryable.
3. **`dropboxSignClient.ts`** — `sendSignatureRequest` / `verifyCallback` / `downloadSignedFile`. *Done:* a script sends a real **test-mode** request to one email and gets back a `signatureRequestId`; that email receives a Dropbox Sign signing link.
4. **`POST /:id/send-for-signature`** — auth, ownership, state guard, two-angle resolution, persist, `notifyUser`. *Done:* curl/UI on an agreed contract creates the request, writes `signature_request_id` + N `contract_signers` rows, flips `status='out_for_signature'`; non-owner → 404; bad state → 409; service-domain address rejected → 400.
5. **`POST /webhooks/dropbox-sign/inbound`** — multipart `json` parse, `event_hash` verify, idempotency, state machine, `Hello API Event Received`. *Done:* a real Dropbox Sign `signature_request_sent` event (from step 3/4's request, via the tunnel) is accepted, returns the exact body, and flips a signer to `sent`; a tampered `event_hash` → 401; a replayed event → no double-write.
6. **`GET /:id/signed-document`** — gated v4 URL. *Done:* 409 before `signed`; after a full test-mode round-trip, returns a working signed URL to `signed.pdf`.
7. **Frontend signer form + timeline + download + awaiting card** — vanilla script. *Done:* §15 test cases pass live (each event flips the thread/dashboard within ~1–2s via the existing SSE reload).
8. **Full real test-mode round-trips** — run **all** §15 test cases end-to-end against a real Dropbox Sign developer account. *Done:* every §15 case recorded with observed DB rows / GCS objects / UI state and pass/fail in the notes.

---

## 12. Known risks (specific to signing)

- **Test mode is watermarked / non-binding; production needs a paid plan.** `DROPBOX_SIGN_TEST_MODE=true` runs the whole multi-party ordered flow free; executed PDFs are watermarked and not legally valid. Sending production requests without a paid API plan returns **HTTP 402**. Keep test mode on for the POC; surface 402 clearly if someone flips it off without a plan.
- **The `Hello API Event Received` response.** Any other body (or non-200, except the 401 on bad hash) is a failure → retries → callback URL auto-cleared after ~10 failures. Return the exact literal.
- **The multipart `json` gotcha.** Parse `await c.req.parseBody()` then `JSON.parse(body['json'])`. `c.req.json()` will not work and will look like a silent verification failure.
- **`all_signed` vs `downloadable` timing.** Mark `signed` on `all_signed`; fetch the PDF on `downloadable` (409 before assembled). Fetching on `all_signed` will intermittently 409.
- **Enum-append ordering.** `contract_status`/`thread_direction` values must be appended after the current tail; the `ALTER TYPE … ADD VALUE` step may need to run outside a transaction (§4.4).
- **Sending to a Genie service address by mistake.** A signing link to `…@mail.usetend.in` vanishes (Postmark inbound, no inbox). The two-angle resolution + the post-resolution service-domain assertion guard against this.
- **Webhook spoofing.** An unauthenticated POST could forge "signed". `event_hash` verification (§5.2/§7.2) is mandatory; reject 401 on failure.
- **Signer-event matching.** `signature_request_signed` fires once per signer; match the right `contract_signers` row by `signature_id`/email and backfill `dropboxSignatureId`, or a 3-party contract will mis-attribute signatures.

---

## 13. What NOT to build in this component

- **Embedded (in-iframe) signing.** It requires an approved API App + `client_id`, the `hellosign-embedded` JS, per-signer `embeddedSignUrl` minting, and domain whitelisting — none of which the email-link flow needs, and it delivers the same outcome via webhooks. Explicitly out of scope (approach.md "Why email-link signing, not embedded"). Do not add `DROPBOX_SIGN_CLIENT_ID` beyond a commented note.
- **In-app rendering of the signing page.** Signing happens on Dropbox Sign's hosted page; we surface the prompt + timeline only.
- **Reminders beyond Dropbox Sign's own** automatic signer reminders (left on).
- **Anything in Component 9 (AI diff) or 10 (polish/demo).** `triggerAiPipeline` (`webhooks.ts:373`) stays a stub.
- **Picking an arbitrary historical reply version to sign** beyond the simple "latest agreed / explicit validated key" (§6.5) — a full version-history browser is out of POC scope.

---

## 14. Reference — files & endpoints after this component lands

```
backend/src/
  services/dropboxSignClient.ts  NEW  send / verify / download via @dropbox/sign 1.11.0
  routes/contracts.ts            EDIT POST /:id/send-for-signature; GET /:id/signed-document; signers in GET /:id
  routes/webhooks.ts             EDIT POST /dropbox-sign/inbound (multipart json, event_hash, state machine, Hello API Event Received)
  db/schema.ts                   EDIT contract_signers table; signer_status/signer_role enums;
                                      append out_for_signature/partially_signed to contract_status;
                                      append 'system' to thread_direction;
                                      signature_request_id (unique) + signed_storage_key on contracts
  drizzle.config.ts              EDIT add 'contract_signers' to tablesFilter
  drizzle/                       NEW  generated migration
  (lib/events.ts, lib/storage.ts, index.ts, app.ts — UNCHANGED, reused)

frontend/src/pages/
  contracts/[id].astro           EDIT signer form + signing timeline + download-signed button
  dashboard.astro                EDIT "awaiting your signature" card for Genie signers

New endpoints:
  POST /api/contracts/:id/send-for-signature   (requireAuth, JSON)
  GET  /api/contracts/:id/signed-document       (requireAuth)
  POST /webhooks/dropbox-sign/inbound           (event_hash HMAC; returns 'Hello API Event Received')
```

---

## 15. Instructions to the implementer — write `implementation-notes.md`

When you finish, write `implementation-notes.md` **in this folder** (`plans/component-08-signing/`), modeled on `plans/component-04-inbound/implementation-notes.md`. It is the *as-built* record — what actually shipped, not what was intended. **The bar for "done" is a real Dropbox Sign test-mode round trip you can see end-to-end — never synthesized/mock payloads.** The notes MUST contain these sections:

**(a) Full as-built CODE WALKTHROUGH.** A files-touched table (path → what changed → why), then the actual flow that shipped, per piece: the schema migration diff (the exact generated SQL, confirming no DROP); `dropboxSignClient.ts` (the real SDK calls, how the PDF is passed — temp file vs buffer — and how the response id is read); `send-for-signature` step-by-step including the **two-angle email resolution** and the service-domain assertion; the webhook handler (multipart `json` parse, `event_hash` verify, the dedup key you chose, the full event→state mapping, and the literal `Hello API Event Received`); `signed-document`; and every decision this plan left to you with **which you chose and why** (reuse `signed`/`declined` vs new values §4.1; sentinel from/to vs nullable columns §4.1; temp-file vs buffer file passing §5.1; `inbound_emails` reuse vs a `signing_events` table for idempotency §7.4; latest-version vs explicit-key signing §6.5; vanilla script vs React island §9; awaiting-card via list-query vs dedicated endpoint §9.4).

**(b) Detailed SETUP GUIDE — run it from scratch.** Everything a teammate needs: all env vars including `DROPBOX_SIGN_API_KEY` and `DROPBOX_SIGN_TEST_MODE=true` (and that `CLIENT_ID` is intentionally unused); **how to create a free Dropbox Sign developer account** and where the API key lives; **how to register the account-level callback URL** in dev settings (account callback, not API-App callback — we send no `client_id`); **how to expose the local webhook** so Dropbox Sign can reach it — `cloudflared tunnel --url http://localhost:8080`, callback URL `…/webhooks/dropbox-sign/inbound` (cross-ref Component 4 plan §2.5); `npm install @dropbox/sign@1.11.0`; `npm run db:generate` / `npm run db:push` for the migration (and the enum-append caveat); `npm run dev` for both servers; and how to fire Dropbox Sign's dashboard "test event" button to sanity-check the callback returns `Hello API Event Received`.

**(c) Detailed END-TO-END PHYSICAL TEST CASES — REAL, not synthesized.** Actually perform and record each of these against a real Dropbox Sign test-mode account (real signing links opened in a browser, real webhooks over the tunnel). For EACH: the exact steps run, the observed DB rows (`contracts.status`, `contract_signers` rows, `signature_request_id`, `signed_storage_key`), GCS objects (`signed.pdf`), UI state, and **pass/fail**:
  1. **Single-signer non-Genie happy path** — one external email; signs; webhook → `signed` → `downloadable` → `signed.pdf` in GCS; download works.
  2. **Two-party ORDERED** — `order:0` external, `order:1` your second email. **Prove signer 1 is emailed only AFTER signer 0 signs** (check signer 1's inbox is empty until signer 0 completes; record timestamps).
  3. **Multi-party where the creating user is NOT a signer** — signers are the counterparty + your "boss" (a third email); the creator orchestrates but does not sign. Confirm completion with no creator signature.
  4. **Genie-user signer** — a signer who is a Genie user. **Prove the link goes to their real identity email, not the `…@mail.usetend.in` service address**, AND the in-app "awaiting your signature" card appears on their dashboard.
  5. **Decline path** — a signer declines → contract returns to **`negotiating`**; the reply composer reappears; a fresh `send-for-signature` can be issued.
  6. **Webhook authenticity** — a POST with a bad `event_hash` → **401**; a correct one → **`Hello API Event Received`** (capture both responses).
  7. **Executed-PDF download after `downloadable`** — confirm `signed-document` 409s before `signed` and returns a working URL after `downloadable` lands the file.
  8. **Idempotency / retry** — replay the same `signature_request_signed` event → no double-write (signer stays `signed` once; status unchanged).
  9. **Live-update assertions** — each event flips the dashboard/thread within ~1–2s via the existing SSE.

**(d) VERIFICATION MATRIX.** A table mapping each done-criterion (§11 steps 1–8 and each §15c case) to what you ran and the result (✓ / 🟡 blocked / ✗), like Component 4 notes §6. State plainly that the "done" bar is a real test-mode round trip seen end-to-end; if anything is blocked, leave the exact commands ready to run and say what remains.

**(e) Operational knobs / extension points** — test-mode→paid-plan flip ($75/mo, removes watermark, real binding), where the embedded-signing upgrade would plug in, signed-URL TTL, and how Component 9's AI hook coexists with the now-live signing flow.
