# Component 4 — Inbound Reply Capture
## Implementation Notes (as-built)

**Written:** 2026-05-25, immediately after the steps in `implementation-plan.md` §8 were exercised locally against NeonDB + GCS. Postmark live round-trip (Step 5, Step 7) remains blocked on Postmark account verification — the rest passes.

This document is the *as-built* walkthrough. The *plan* (intent, manual steps, done-criteria) lives in `implementation-plan.md`; this file records what landed in code, what was verified, and which knobs you'd touch to extend it.

---

## 1. Files touched

```
backend/src/routes/webhooks.ts        rewritten — fixes In-Reply-To match (§5) +
                                       hardening (non-PDF logging, Date guard,
                                       processed-marking on every exit path,
                                       resilient JSON parse, async error capture)
backend/src/routes/contracts.ts       additive — new GET /:id/attachment?key=…
                                       (ownership + key-in-thread check before
                                       signing a GCS URL)
frontend/src/pages/contracts/[id].astro
                                       additive — attachment <a data-key=…> now
                                       calls /attachment, kept the original PDF
                                       button on /download-url; renders bodyText
                                       (Astro auto-escapes JSX text → no XSS
                                       from attacker bodyHtml); replied-status
                                       callout
```

Out of scope and **not** modified: schema (no migration), Components 1–3 wiring, AI pipeline (stays a stub), Component 5/6/7 surfaces.

---

## 2. The In-Reply-To fix (the highest-risk bug — landed first)

**Cause.** On send (Component 3) we store Postmark's API-returned `MessageID` — a **bare UUID** — into `contract_threads.postmark_message_id`. When the counterparty replies, their mail client sets `In-Reply-To:` to the **email `Message-ID:` header** Postmark generated for our outbound mail, which is `<{uuid}@{domain}>` (e.g. `<a1b2c3d4-…@mtasv.net>`). The original handler stripped `< >` but kept `@domain`, so it tried to match `a1b2c3d4-…@mail.usetend.in` against the stored bare `a1b2c3d4-…` → no match, contract stayed `sent`, every multi-round chain was dead on arrival.

**Decision.** Use the **bare UUID** as the canonical representation on both sides (send and match). Postmark's send API already gives us a bare UUID, so the outbound row is unchanged. On the inbound side we normalize both the `In-Reply-To` header *and* the inbound `MessageID` we store on the thread row, so Component 5's next-round replies will be matchable the same way.

**Helper** (`backend/src/routes/webhooks.ts`):

```ts
function normalizeMessageId(raw: string | undefined | null): string | null {
  if (!raw) return null
  const stripped = raw.replace(/[<>]/g, '').trim()
  if (!stripped) return null
  return stripped.split('@')[0]
}
```

Applied to:
- `payload.Headers["In-Reply-To"]` → used as the lookup key against `contract_threads.postmark_message_id` AND stored in `contract_threads.in_reply_to_message_id`.
- `payload.MessageID` → stored normalized in the inbound `contract_threads.postmark_message_id` so the next reply in the chain can be matched by the same rule. (The `inbound_emails.postmark_message_id` row keeps the raw, unnormalized id — that one is the Postmark-dedup ledger and should mirror Postmark exactly.)

**Verified.** Posted a synthesized reply with the *buggy* `<uuid@domain>` In-Reply-To against the live contract `c4c6cc39-…` (sent earlier in Component 3 testing). The contract flipped to `status='replied'`, the inbound `contract_threads` row carried `contract_id=c4c6cc39-…` and `in_reply_to_message_id=04c8a677-…` (bare). Test rows + GCS object were cleaned up; the contract was reset to `sent`.

---

## 3. Webhook handler — flow as-built

`POST /webhooks/postmark/inbound`:

1. Basic-Auth check — mismatch → `401` (Postmark retries; correct behavior for a misconfigured URL).
2. Resilient JSON parse — broken body → `200 {ok:false,error:"invalid_json"}` (we *never* return a non-200 for a deterministic input bug, otherwise Postmark would loop 10×).
3. Missing `MessageID` → `200 {ok:false,error:"missing_message_id"}` (no idempotency key, can't safely store).
4. **Idempotency:** `INSERT … ON CONFLICT (postmark_message_id) DO NOTHING RETURNING id`. Zero rows → `200 {ok:true,note:"duplicate"}`, stop.
5. Return `200 {ok:true}` immediately and kick off `processInbound()` without awaiting.
6. `processInbound` failures are caught and written to `inbound_emails.processing_error` + `processed_at` — never bubbled.

`processInbound(inboundId, payload)`:

- Reject unusable `OriginalRecipient` → mark inbound `processed=true` with no thread row, return.
- Resolve local-part → `getServiceEmailByLocalPart` → `{userId}`. No user → mark processed, return.
- Normalize `In-Reply-To` → look up `contract_threads.postmark_message_id` → optional `contractId`.
- For each attachment with PDF content type, decode base64 and upload to GCS:
  - matched: `contracts/{userId}/{contractId}/reply-{timestamp}.pdf`
  - unmatched: `inbound/{userId}/{messageId}.pdf`
  - non-PDF: dropped, logged at WARN with filename/contentType/size.
- Parse `payload.Date`; if Invalid → fall back to `new Date()` with a WARN log.
- Insert one `contract_threads` row (`contract_id` defaults to `'unknown'` when unmatched — placeholder until Component 7).
- If matched: `UPDATE contracts SET status='replied', updated_at=now()`.
- Mark `inbound_emails.processed=true`, set `thread_entry_id`, `processed_at`.
- Call `triggerAiPipeline(contractId, attachments)` — still a stub.

Every exit path now marks the inbound row processed (`markInboundProcessed` helper) so the ledger is never left in a "received, but never explained" state.

---

## 4. Reply-attachment download — `GET /api/contracts/:id/attachment?key=…`

Lives in `backend/src/routes/contracts.ts`, alongside the existing `/:id/download-url` (which signs only `contract.storageKey`, the original PDF). The new endpoint is what the thread page calls for any inbound attachment.

Order matters; **never** sign a user-supplied key without both checks:

1. `contracts.id = :id AND contracts.user_id = session.user.id` — ownership. Miss → `404`.
2. Iterate the contract's `contract_threads` rows; the `key` must appear in some row's `attachments[].storageKey`. Miss → `404`.
3. Only then call `generateDownloadSignedUrl(key)` and return `{url, expiresIn: 3600}`.

This blocks two attack shapes that a naive "sign whatever key the client sends" implementation would allow:
- **IDOR**: requesting another user's known storage key while holding your own session → blocked at step 2 (the key isn't in your contract's threads).
- **Path traversal / probing**: sending `../../etc/passwd`-style keys → same block.

Verified by replaying the DB-level predicate against a real owning user vs. a foreign userId, vs. a foreign key, vs. a traversal-shaped key. All non-owning cases return `not_owned_or_missing` or `key_not_in_threads`; only the owning + in-thread combination returns `ok:true`.

The endpoint also returns `401` for an unauthenticated request (it's behind `requireAuth`), confirmed via `curl`.

---

## 5. Frontend changes (additive)

`frontend/src/pages/contracts/[id].astro`:

- The download click handler now reads `data-key` from the `<a>`. If present, it calls `/api/contracts/:id/attachment?key=…` (the new endpoint). If absent (it never is for reply attachments rendered from `t.attachments`), it falls back to the original `/download-url` — keeping the existing original-PDF flow intact.
- A `replied` status banner ("Counterparty replied. Their reply is in the thread below.") renders above the rest of the page when `contract.status === 'replied'`. The plain status badge in the header is unchanged.
- Body rendering: thread entries render `t.bodyText` (Astro JSX interpolation of text auto-escapes — so even if a future reply slipped an attacker `<script>` through `body_text`, it would print as literal characters, not execute). `body_html` is **not** rendered. If we later want richer rendering, we need a sanitizer (e.g. DOMPurify) — explicitly deferred.

No live updates here — Component 6's territory. A page refresh after a reply lands shows the new state.

---

## 6. Verification matrix (what was actually run)

Local backend on `http://localhost:8080` (NeonDB pooled, real GCS bucket). Postmark inbound creds taken from `.env`.

| Plan checklist | What was done | Result |
|---|---|---|
| I1 — auth required | `POST` with no `Authorization` header | `401` ✓ |
| I2 — raw stored first | Any accepted POST writes `inbound_emails` row with full `raw_payload` *before* processing | ✓ (insert is synchronous; processing is `.catch()`-detached) |
| I3 — idempotent | POSTed the same payload twice with valid Basic Auth | First `{ok:true}`, second `{ok:true,note:"duplicate"}`, single `inbound_emails` row ✓ |
| I4 — user routing | Unknown local-part discarded; known local-part resolves to userId | ✓ (both cases marked `processed=true`, only the known case proceeds to thread/contract work) |
| I5 — contract match | Synthesized reply with buggy `<uuid@domain>` In-Reply-To against a real outbound thread | `contract_id` linked correctly; `in_reply_to_message_id` stored as bare UUID; `status` flipped to `replied` ✓ |
| I6 — attachment stored | Same test; PDF + non-PDF attachments in payload | PDF landed at `contracts/{userId}/{contractId}/reply-{ts}.pdf`; non-PDF dropped with WARN log ✓ |
| I7 — status | Same test | `contracts.status='replied'`, `updated_at` bumped ✓ (later reset for cleanliness) |
| I8 — download (security) | DB-level replay of the route's ownership + key-in-thread predicate, plus `curl` for the 401 case | All four cases behave: own + valid key → ok; own + foreign key → 404; own + traversal key → 404; other user + valid key → 404 ✓ |
| I9 — unmatched | POST with known service email but In-Reply-To pointing at a UUID we never sent; `Date` header deliberately invalid | Placeholder row with `contract_id='unknown'` ✓, `email_date` fell back to `now()` ✓, no error |
| I10 — failure isolation | `processInbound` always runs detached; any thrown error is caught and written to `inbound_emails.processing_error`, never re-thrown | ✓ (by construction; not artificially forced — would need a fault injection to drive it). |

**Postmark inbound is now unblocked.** The inbound domain `mail.usetend.in` has been registered on the inbound server and real round-trips are working.

---

## 7. Operational knobs / extension points

- **Storage layout.** Matched replies land at `contracts/{userId}/{contractId}/reply-{ts}.pdf`. Multiple replies are disambiguated by `Date.now()` in the key — collisions in the same millisecond are not handled; for the POC, fine. If the volume rises, swap the suffix for `crypto.randomUUID()`.
- **Unmatched placeholder.** Rows land with `contract_id='unknown'`. We deliberately keep both the placeholder thread row *and* the original `inbound_emails.raw_payload`, so when Component 7 lands ("received contract" inbox / intra-domain) it can backfill the real `contract_id` from the raw payload without losing anything.
- **AI hook.** `triggerAiPipeline(contractId, attachments)` is the seam Component 8 will replace. Its current call site fires after the inbound row is marked processed, so AI failures won't poison the inbound ledger.
- **Postmark retry semantics.** Anything that returns non-`200` is retried up to 10× by Postmark. The only non-`200` we ever return is `401` (bad creds — a config bug worth retrying). All other failure modes — invalid JSON, missing MessageID, processing crash — return `200` and either log or record the error on the inbound row.

---

## 8. What's left for someone finishing the component

1. **Postmark inbound URL format (critical).** Postmark's inbound webhook UI has no separate Basic Auth fields. Credentials must be embedded directly in the URL:
   ```
   https://{POSTMARK_INBOUND_WEBHOOK_USER}:{POSTMARK_INBOUND_WEBHOOK_PASS}@{HOST}/webhooks/postmark/inbound
   ```
   Use the literal password value — do not URL-encode `=` signs.

2. **Inbound domain must be set on the inbound server.** Go to Postmark → inbound server (not transactional) → Settings → Inbound Domain → set `mail.usetend.in`. Without this, Postmark receives the email but has no server to route it to, so the webhook never fires.

3. **Tunnel URL changes on every restart.** Each time `cloudflared tunnel --url http://localhost:8080` is run, a new random URL is generated. Update the Postmark inbound webhook URL every time the tunnel restarts.

4. **Cloud Run deployment.** Repoint the Postmark inbound webhook URL from the tunnel URL to the Cloud Run URL. Format remains the same — just swap the host.

5. If Postmark hands back a different `Message-ID` shape than `<{uuid}@{domain}>` in a real reply (e.g. some mail clients regenerate it), inspect `inbound_emails.raw_payload.Headers` and adjust `normalizeMessageId` — but keep the *single canonical representation on both sides* rule.

Anything beyond that is a different component (5/6/7/8).
