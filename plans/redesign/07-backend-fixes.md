# Plan 07 — Backend Bug Fixes

## Purpose

Fix 8 specific, confirmed backend bugs in the Genie AI POC. This plan should be implemented first — before any UI work — because the UI plans depend on correct backend behaviour. Each fix is described with its exact file, line reference, root cause, and the correct approach. No fix in this plan requires a database schema change.

---

## Fix 1: Signing API — Wrong Dropbox Sign Method

**File**: `backend/src/services/dropboxSignClient.ts`
**Lines**: 8 (`CLIENT_ID`), 47–55 (request object), 57 (`signatureRequestCreateEmbedded`)

**Root cause**: The `sendSignatureRequest` function uses `SignatureRequestCreateEmbeddedRequest` and calls `signApi.signatureRequestCreateEmbedded(req)`. This creates a signature request that requires an in-app iframe to complete signing. However, `approach.md` §5 explicitly specifies the email-link flow where Dropbox Sign sends signers a direct email — no iframe, no client ID needed for the request itself.

**Correct approach**:
- Change the request type from `SignatureRequestCreateEmbeddedRequest` to `SignatureRequestSendRequest` (from `@dropbox/sign`)
- Change the API call from `signApi.signatureRequestCreateEmbedded(req)` to `signApi.signatureRequestSend(req)`
- Remove the `clientId: CLIENT_ID` field from the request object — `signatureRequestSend` does not take a `clientId`
- Remove `const CLIENT_ID = process.env.DROPBOX_SIGN_CLIENT_ID!` from the module top (line 8) — it is no longer needed for the send request
- Keep `const embeddedApi = new DropboxSign.EmbeddedApi()` and keep `getEmbeddedSignUrl()` — they are still used for the Genie-to-Genie "Sign Now" flow where an internal Genie user needs to sign via the app (see Plan 05)
- The response shape from `signatureRequestSend` is the same as from `signatureRequestCreateEmbedded`: `res.body.signatureRequest.signatureRequestId` and `res.body.signatureRequest.signatures[].signatureId` — the rest of the function body stays the same

**Test**: After fix, a call to `sendSignatureRequest` should not require `DROPBOX_SIGN_CLIENT_ID` in the environment. Dropbox Sign will send signing emails directly to the signers.

---

## Fix 2: GCS Hardcoded Filename

**File**: `backend/src/lib/storage.ts`
**Line**: 19 (`responseDisposition: 'attachment; filename="contract.pdf"'`)

**Root cause**: Every single download served from GCS arrives in the browser named `contract.pdf` regardless of the actual file. The filename is hardcoded in the signed URL generation function with no way to override it.

**Correct approach**:
- Add a `filename: string` parameter to `generateDownloadSignedUrl` (make it required, not optional — every caller should know what file they're serving)
- Change `responseDisposition` to use a template: `` `attachment; filename="${encodeURIComponent(filename)}"` ``
- `encodeURIComponent` handles spaces, non-ASCII characters, and special characters safely in the Content-Disposition header
- Update the function signature (currently line 11–14): `generateDownloadSignedUrl(storageKey: string, filename: string, expiresInSeconds = 3600)`

**Update all callers in `contracts.ts`**:
- Original contract download → pass `contract.originalFilename`
- Reply attachment download → pass the attachment's original filename from the thread record (check the `contractThreads` schema for the attachment filename column)
- Executed signed PDF → pass `` `${contract.title}-executed.pdf` `` (slugified: replace spaces with underscores or hyphens)

---

## Fix 3: Dashboard Query Missing Genie-to-Genie Signers

**File**: `backend/src/routes/contracts.ts`
**Lines**: 39–76 (the `GET /` handler raw SQL query), specifically line 71 `WHERE c.user_id = ${user.id}`

**Root cause**: The dashboard query fetches only contracts where `c.user_id = user.id` (contracts the user _owns_). The `awaitingMySignature` subquery checks `cs.genie_user_id = user.id` but it is evaluated within the `WHERE c.user_id = user.id` filter — so it only ever finds signer records on the user's own contracts. If another Genie user (User B) creates a contract and adds the current user (User A) as a signer, User A's dashboard never shows it.

**Correct approach**: Extend the query with a UNION that adds contracts from `contract_signers` where `cs.genie_user_id = user.id`:

```sql
SELECT <all columns> FROM contracts c WHERE c.user_id = user.id
UNION
SELECT <same columns>, true AS "awaitingMySignature"
FROM contracts c
JOIN contract_signers cs ON cs.contract_id = c.id
WHERE cs.genie_user_id = user.id
  AND cs.status IN ('pending', 'sent', 'viewed')
  AND c.user_id != user.id  -- avoid duplicates where user owns AND is a signer
ORDER BY sort_group ASC, updated_at DESC
```

Use `UNION` (not `UNION ALL`) to be safe against any edge-case duplicates. The second SELECT must have the same column list and aliases as the first. For `awaitingMySignature` in the second branch, it is always `true`.

The `sort_group` CASE expression must be repeated in the second SELECT (or the whole thing can be wrapped in a CTE/subquery). The cleanest approach for maintainability: use a CTE with two branches and ORDER BY at the top level.

---

## Fix 4: `allowedStatuses` Includes `'draft'` for Send-for-Signature

**File**: `backend/src/routes/contracts.ts`
**Line**: ~467 (the `POST /:id/send-for-signature` handler)

**Root cause**: The `allowedStatuses` array includes `'draft'`. This means a user can attempt to send a contract for signature before it has ever been reviewed. A draft contract has not been sent to any counterparty — a signing request on it is meaningless.

**Correct approach**: Remove `'draft'` from the `allowedStatuses` array. The allowed statuses for initiating signing should be `['sent', 'replied', 'negotiating', 'completed']`. More conservatively: `['replied', 'negotiating']` — only after at least one round of review. `'sent'` (counterparty hasn't even replied yet) and `'completed'` are debatable, but `'draft'` is unambiguously wrong.

Recommendation: use `['replied', 'negotiating']` — you must have at least started the conversation before you can sign.

---

## Fix 5: Case-Sensitive Email Match in Dropbox Sign Webhook

**File**: `backend/src/routes/webhooks.ts`
**Line**: ~234 (the `signature_request_sent` event handler, email comparison)

**Root cause**: When the `signature_request_sent` webhook fires, the handler matches the signer's email from the Dropbox event payload to the `contractSigners.signerEmail` column in the database. This comparison is case-sensitive. If Dropbox normalises email addresses differently from how they were stored (e.g., stored as `Alice@Example.com`, returned as `alice@example.com`), the match fails silently — `dropboxSignatureId` is never set, and subsequent events (like `signature_request_signed`) fail to find the signer record.

**Correct approach**: Normalise both sides to lowercase before comparing:
```
WHERE lower(cs.signer_email) = lower(event.signer_email_address)
```

In a Drizzle ORM query: use `sql\`lower(${contractSigners.signerEmail})\` = ${signerEmail.toLowerCase()}` or use Drizzle's `lower()` function if available.

If the query is a raw SQL string, wrap both sides in `LOWER()`.

Also: when storing the email in `contract_signers` at signer creation time (`POST /:id/send-for-signature`), store it as lowercase. This prevents the problem at source.

---

## Fix 6: Thread Ordering (Newest-First vs Oldest-First)

**File**: `backend/src/routes/contracts.ts`
**Lines**: the `GET /:id` endpoint, the Drizzle query for contract threads

**Root cause**: `orderBy: [desc(contractThreads.emailDate)]` — threads are sorted newest-first. The most recent message appears at the top. This is backwards — every email client, chat app, and letter thread in history reads oldest first, newest at the bottom.

**Correct approach**: Change `desc(contractThreads.emailDate)` to `asc(contractThreads.emailDate)`. One word change. The frontend renders the array in the order it receives it; no frontend change needed.

---

## Fix 7: Three Separate DB Queries on Contract Detail

**File**: `backend/src/routes/contracts.ts`
**Lines**: ~118–138 (the `GET /:id` endpoint — three separate Drizzle queries for contract, threads, signers)

**Root cause**: The endpoint runs three separate database round-trips: one for the contract record, one for threads, one for signers. `approach.md` §4 specifies a single SQL query using `LEFT JOIN` and `json_agg` to return all data in one round-trip. With a cloud-hosted Neon database on Cloud Run, each round-trip adds 20–50ms of latency. Three queries = up to 150ms of unnecessary latency on the most-visited page.

**Correct approach**: Write one raw SQL query using Drizzle's `sql` template:

```sql
SELECT
  c.*,
  json_agg(DISTINCT jsonb_build_object(
    'id', t.id, 'direction', t.direction, 'body', t.body,
    'emailDate', t.email_date, 'fromName', t.from_name,
    'attachmentStorageKey', t.attachment_storage_key,
    'attachmentFilename', t.attachment_filename
  ) ORDER BY (t.email_date) ASC) FILTER (WHERE t.id IS NOT NULL) AS threads,
  json_agg(DISTINCT jsonb_build_object(
    'id', s.id, 'signerName', s.signer_name, 'signerEmail', s.signer_email,
    'status', s.status, 'genieUserId', s.genie_user_id,
    'dropboxSignatureId', s.dropbox_signature_id
  )) FILTER (WHERE s.id IS NOT NULL) AS signers
FROM contracts c
LEFT JOIN contract_threads t ON t.contract_id = c.id
LEFT JOIN contract_signers s ON s.contract_id = c.id
WHERE c.id = ${id} AND c.user_id = ${user.id}
GROUP BY c.id
```

This returns one row. Parse `threads` and `signers` as JSON arrays directly.

Note: the thread ordering (`ORDER BY t.email_date ASC`) is embedded in the `json_agg` — this also resolves Fix 6 in the same query.

Also include the `latestDiff` (from `contract_diffs` table, if it exists — join and `ORDER BY created_at DESC LIMIT 1`). `approach.md` §4 specifies the response shape as `{ contract, threads, signers, latestDiff }`.

---

## Fix 8: `downloadSignedFile` Has No Retry on 409

**File**: `backend/src/routes/webhooks.ts`
**Lines**: the `signature_request_all_signed` or `signature_request_completed` handler where `downloadSignedFile(signatureRequestId)` is called

**Root cause**: When all signers have signed, the handler immediately calls `downloadSignedFile()`. Dropbox Sign returns HTTP 409 when the executed PDF is not yet ready (it takes a few seconds to generate). The current code catches the 409 and re-throws it — the webhook handler fails, Dropbox retries the webhook, but by then the 409 catch has already thrown and the contract status may be inconsistent.

**Correct approach**: Implement an exponential backoff retry loop around `downloadSignedFile`:
- Max 5 attempts
- Delays: 2s, 4s, 8s, 16s, 32s
- Only retry on `err.status === 409` — other errors should throw immediately
- After 5 failed attempts: log the failure, set contract status to a `download_pending` state (or fire a background job), and return `200 OK` to Dropbox Sign so it stops retrying the webhook
- Alternative (simpler): if the download fails on the first attempt, enqueue a retry using a `setTimeout` (non-blocking) for 10s. After the timeout, try once more and log the result.

The simplest correct approach for a POC: catch the 409, wait 5 seconds, retry once. If it still fails, log and continue — Dropbox Sign will re-deliver the webhook and a subsequent delivery will succeed.

---

## Implementation Order

These fixes should be applied in this order within Plan 07:
1. Fix 1 (signing API) — highest impact, most breaking if left unfixed
2. Fix 2 (filename) — affects every download; other plans depend on it
3. Fix 5 (email case sensitivity) — silent failure, catch it early
4. Fix 4 (allowedStatuses draft) — prevents impossible state transition
5. Fix 6 + Fix 7 (thread order + DB query consolidation) — do together since they're in the same `GET /:id` handler
6. Fix 3 (dashboard UNION query) — isolated change
7. Fix 8 (retry on 409) — lowest urgency, shouldn't block anything else

---

## Files to Modify

| File | Fixes |
|---|---|
| `backend/src/services/dropboxSignClient.ts` | Fix 1 (lines 8, 47–57) |
| `backend/src/lib/storage.ts` | Fix 2 (lines 11–22) |
| `backend/src/routes/contracts.ts` | Fix 3 (lines 37–76), Fix 4 (~line 467), Fix 6 (GET /:id orderBy), Fix 7 (GET /:id query consolidation) |
| `backend/src/routes/webhooks.ts` | Fix 5 (~line 234), Fix 8 (download retry) |
