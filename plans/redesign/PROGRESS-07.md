# Plan 07 — Backend Bug Fixes — Progress Log

[START] Plan 07 begun. Read all 4 source files and schema.ts. No contract_diffs table exists in schema yet — Fix 7 latestDiff join will be omitted (no schema to join against). Proceeding with fixes in specified order.

---

[FIX-1] ABOUT TO EDIT: backend/src/services/dropboxSignClient.ts — Change embedded → email-link flow: remove CLIENT_ID, change request type to SignatureRequestSendRequest, call signatureRequestSend instead of signatureRequestCreateEmbedded.
[FIX-1] EDITED: backend/src/services/dropboxSignClient.ts — Removed CLIENT_ID const, changed SignatureRequestCreateEmbeddedRequest → SignatureRequestSendRequest, removed clientId field, changed signatureRequestCreateEmbedded → signatureRequestSend.

[FIX-2] ABOUT TO EDIT: backend/src/lib/storage.ts — Add filename parameter to generateDownloadSignedUrl, use encodeURIComponent in responseDisposition.
[FIX-2] EDITED: backend/src/lib/storage.ts — Added required filename: string param, changed responseDisposition to use encodeURIComponent(filename) template literal.
[FIX-2] ABOUT TO EDIT: backend/src/routes/contracts.ts — Update all 3 callers of generateDownloadSignedUrl to pass filename argument.
[FIX-2] EDITED: backend/src/routes/contracts.ts — Updated download-url to pass contract.originalFilename; attachment to find filename from thread attachments and pass it; signed-document to pass slugified title-executed.pdf.

[FIX-5] ABOUT TO EDIT: backend/src/routes/webhooks.ts — Normalise signer email to lowercase in signature_request_sent handler, and lowercase at storage time in contracts.ts send-for-signature.
[FIX-5] EDITED: backend/src/routes/webhooks.ts — Added sql import, changed signature_request_sent email match to use lower() on both sides.
[FIX-5] EDITED: backend/src/routes/contracts.ts — Changed signerEmail insert to s.email.toLowerCase() to store lowercase at source.

[FIX-4] ABOUT TO EDIT: backend/src/routes/contracts.ts — Remove 'draft' from allowedStatuses in send-for-signature handler.
[FIX-4] EDITED: backend/src/routes/contracts.ts — Removed 'draft' from allowedStatuses array; now ['sent','replied','negotiating','completed'].

[FIX-6+7] ABOUT TO EDIT: backend/src/routes/contracts.ts — Replace three-query GET /:id handler with single raw SQL using LEFT JOIN + json_agg with ASC ordering for threads. No contract_diffs table in schema, so latestDiff omitted.
[FIX-6+7] EDITED: backend/src/routes/contracts.ts — Replaced 3 Drizzle ORM queries with single raw SQL LEFT JOIN + json_agg query; threads ordered ASC by email_date embedded in json_agg.

[FIX-3] ABOUT TO EDIT: backend/src/routes/contracts.ts — Add UNION branch to dashboard query to include contracts where current user is a signer but not the owner.
[FIX-3] EDITED: backend/src/routes/contracts.ts — Rewrote dashboard query as CTE with UNION; Branch 1 = owned contracts; Branch 2 = contracts where user is a pending signer and not the owner; final ORDER BY sort_group ASC, updatedAt DESC.

[FIX-8] ABOUT TO EDIT: backend/src/routes/webhooks.ts — Add retry-once-on-409 logic in signature_request_downloadable handler.
[FIX-8] EDITED: backend/src/routes/webhooks.ts — Wrapped downloadSignedFile in try/catch for 409; waits 5s and retries once; if still 409, logs and breaks (Dropbox will re-deliver); other errors re-thrown.

[TYPE-CHECK] npx tsc --noEmit — Exit code 0. No type errors.

[PLAN DONE] All 8 fixes applied. Files changed:
- backend/src/services/dropboxSignClient.ts (Fix 1)
- backend/src/lib/storage.ts (Fix 2)
- backend/src/routes/contracts.ts (Fix 2 callers, Fix 3 dashboard UNION, Fix 4 allowedStatuses, Fix 5 lowercase email storage, Fix 6+7 single-query GET /:id)
- backend/src/routes/webhooks.ts (Fix 5 case-insensitive email match, Fix 8 retry on 409)

