# Plan 05 — Signing Ceremony

## Purpose

Fix the Dropbox Sign integration from the embedded flow (wrong) to the email-link flow (correct per `approach.md`), and redesign the signing-related UI to reflect what actually happens: Dropbox Sign emails the signer a link, they sign on Dropbox's hosted page, and the app receives a webhook when done.

This plan is tightly coupled to Plan 07's backend fix (switching `signatureRequestCreateEmbedded` → `signatureRequestSend`). Plan 07 must be implemented first. This plan handles everything downstream of that fix: the UI that shows during and after the signing ceremony.

---

## The Core API Bug (Summary — Detail in Plan 07)

**Current code**: `dropboxSignClient.ts` line 57 calls `signatureRequestCreateEmbedded()`, which creates a signature request that requires an embedded iframe to complete. This generates a `signatureId` that can be used with `embeddedApi.embeddedSignUrl()` to get a time-limited URL for an iframe.

**Correct flow**: `signatureRequestSend()` creates a signature request and automatically sends each signer an email from Dropbox Sign with a direct link. No `CLIENT_ID` is needed. No iframe. No embedded URL generation.

**Implication for the UI**: the `/sign/:token` page currently fetches an embedded sign URL and redirects the user to it. After the fix, Dropbox Sign handles the sign email entirely. The `/sign/:token` page is only needed for internal Genie-to-Genie signers (where the contract owner is also a signer and needs to be directed to their signing link within the app).

---

## What the Signing Ceremony Looks Like After the Fix

### From the contract owner's perspective (Stage 4 — Left Column)

When `contract.status === 'out_for_signature'` or `partially_signed`, the left column shows a **Signing Timeline** card:

```
Signature Request
─────────────────────────────
● alice@example.com   [Signed ✓]    2 Jan 2026
● bob@example.com     [Waiting…]    Sent 2 Jan
● you@genie.ai        [Pending]     Not yet sent
─────────────────────────────
[Download Final Contract — disabled, greyed until all signed]
```

Each row in the timeline is a signer from the `contract_signers` table (fetched as part of the `GET /:id` response). Status values from the `contract_signers.status` column:
- `pending` / `sent` → "Waiting…" pill badge (muted)
- `viewed` → "Viewed" pill badge (slightly more prominent muted)
- `signed` → "Signed ✓" pill badge (green tint: `#F0FDF4` bg, `#166534` text)
- `declined` → "Declined ✗" pill badge (red tint)

The timeline is server-rendered (SSR in Astro). SSE events update the signing status in real time.

### From the signer's perspective

**External counterparty**: they receive an email from Dropbox Sign directly. They do not interact with the Genie app. No `/sign/:token` page is involved.

**Genie-to-Genie signer** (the contract owner is listed as a signer, or another Genie user is invited as a signer):
1. They appear in the `awaitingMySignature` card on their dashboard
2. Clicking "Sign Now" calls `GET /api/contracts/:id/sign-url` (internal endpoint)
3. That endpoint retrieves the stored `dropboxSignatureId` for that signer-user pair from `contract_signers` and calls `embeddedApi.embeddedSignUrl()` to get the embedded URL
4. The browser is redirected to that URL

**Wait — doesn't this still need the embedded API?**

Yes, but only for the _internal Genie-to-Genie_ case where we want to avoid breaking the in-app sign flow for users who are both contract owners and signers. The fix is:

- For external signers: use `signatureRequestSend` — Dropbox handles the email and hosted page. No embedded URL needed.
- For internal Genie signers: after the `signatureRequestSend` call returns the `signatureId` list, store the `signatureId` in `contract_signers.dropboxSignatureId`. When the user clicks "Sign Now" in the dashboard, fetch the embedded URL using `embeddedApi.embeddedSignUrl(signatureId)` and redirect. **This reuses the existing `getEmbeddedSignUrl` function** — it stays in `dropboxSignClient.ts`, it's just no longer used to initiate the overall request.

So: `signatureRequestCreateEmbedded` is replaced by `signatureRequestSend`. `getEmbeddedSignUrl` is kept and used only for Genie-to-Genie redirect.

**Important**: `DROPBOX_SIGN_CLIENT_ID` environment variable is still needed for the Genie-to-Genie embedded URL fetch. It is NOT needed for `signatureRequestSend`. So remove `CLIENT_ID` as a parameter to the create request, but keep `embeddedApi` initialized for the embedded URL calls.

---

## The `/sign/:token` Page

**Current behaviour**: fetches embedded URL → redirects.

**After the fix**: behaviour is unchanged — this page is still used for Genie-to-Genie signers. However, add:
1. A "Preparing your signing page…" loading state — currently there is a blank white flash between navigation and redirect
2. An explicit loading message: spinner + "Preparing your signing page, please wait…" in `var(--color-accent)`
3. Error state: if the fetch fails (expired token, already signed), show a message with a link back to dashboard instead of a blank error screen

---

## Webhook → SSE → UI Update Chain

When a signer completes signing on Dropbox's hosted page, Dropbox fires a webhook event to `POST /api/webhooks/dropbox-sign`. The chain:

1. `webhooks.ts` receives `signature_request_signed` event
2. Updates `contract_signers.status = 'signed'` for that signature ID
3. If all signers have signed: downloads the executed PDF, stores it in GCS, sets contract status to `completed`
4. Calls `notifyUser(userId, { contractId, newStatus })` which fires the LISTEN/NOTIFY event
5. LISTEN handler on the SSE connection pushes the event to the browser
6. Browser receives the SSE event on the contract detail page

The contract detail page SSE handler should:
- On `signature_request_signed`: find the signer row in the timeline and update its badge to "Signed ✓" in place (no reload needed — the signer list does not change structure)
- On `completed`: the Download button becomes active. If the status moves from stage 4 to stage 5, trigger a page reload to re-render the stage indicator and left column content.

---

## Send-for-Signature Backend Endpoint (Contracts Route)

The `POST /:id/send-for-signature` endpoint in `contracts.ts` currently calls `sendSignatureRequest()` which calls `signatureRequestCreateEmbedded`. After Plan 07's fix, `sendSignatureRequest()` will call `signatureRequestSend` instead. The endpoint logic around it:

- Remove `'draft'` from the allowed status list (currently line ~467)
- The signer payload: the frontend sends `{ signers: [{ name, email, order }] }`. The backend inserts rows into `contract_signers` and calls `sendSignatureRequest`
- The response from `signatureRequestSend` returns `signatureRequestId` and per-signer `signatureId`. Store these: `signatureRequestId` on the contract row, `dropboxSignatureId` per signer in `contract_signers`.

---

## Contract Status Progression During Signing

| Event | Old status | New status |
|---|---|---|
| `POST send-for-signature` succeeds | `replied` / `negotiating` | `out_for_signature` |
| First signer signs (not last) | `out_for_signature` | `partially_signed` |
| All signers sign | `partially_signed` | `completed` |
| Any signer declines | `out_for_signature` / `partially_signed` | `negotiating` |

The `declined → negotiating` transition means negotiation can resume. The thread reply composer must show in `negotiating` status (fixed in Plan 04's reply composer condition).

---

## Files to Modify

| File | Changes |
|---|---|
| `backend/src/services/dropboxSignClient.ts` | Switch `sendSignatureRequest` from `signatureRequestCreateEmbedded` to `signatureRequestSend`; remove `CLIENT_ID` from the send request (keep `embeddedApi` for Genie-to-Genie URL fetches) |
| `backend/src/routes/contracts.ts` | `POST /:id/send-for-signature`: remove `'draft'` from allowed statuses; `GET /:id/sign-url`: already correct for Genie-to-Genie use |
| `frontend/src/pages/contracts/[id].astro` | Add signing timeline component to Stage 4 left column; update SSE handler for signer-level updates |
| `frontend/src/pages/sign/[token].astro` | Add loading state, improve error state |
| `frontend/src/pages/dashboard.astro` | "Sign Now" button remains — its backend endpoint (`/sign-url`) is valid for Genie-to-Genie case |

## Files to Reference

| File | Why |
|---|---|
| `approach.md` §5 (Dropbox Sign) | Canonical spec: use email-link flow, not embedded. `CLIENT_ID` not needed for `signatureRequestSend`. |
| `@dropbox/sign` v1.11.0 docs | `SignatureRequestApi.signatureRequestSend()` method signature and request type: `SignatureRequestSendRequest`. Compare to `SignatureRequestCreateEmbeddedRequest` to see exactly which fields change. |
| `backend/src/routes/webhooks.ts` | `signature_request_sent` handler: stores `dropboxSignatureId` per signer. Must still work correctly after the API switch since the response shape is the same. |
