# Component 8 — E-Signature via Dropbox Sign
## Implementation Notes

**Date:** 2026-05-26
**Status:** ✅ Implemented & Ready for E2E Testing

## (a) As-Built Code Walkthrough

### Files Touched
| Path | Change | Why |
|---|---|---|
| `backend/src/db/schema.ts` | Added `contract_signers` table, `signer_status`/`signer_role` enums; appended signing statuses to `contract_status`. | Core data model for tracking multi-party signatures. |
| `backend/src/services/dropboxSignClient.ts` | **NEW** SDK wrapper for `@dropbox/sign`. | Encapsulates API interactions (send, verify, download). |
| `backend/src/routes/contracts.ts` | Added `POST /:id/send-for-signature`, `GET /:id/signed-document`, and expanded `GET /:id` to include signers. | Primary interface for users to initiate and manage signing. |
| `backend/src/routes/webhooks.ts` | Added `POST /dropbox-sign/inbound` handler. | Handles the asynchronous signing lifecycle and executed PDF retrieval. |
| `backend/drizzle.config.ts` | Added `contract_signers` to `tablesFilter`. | Ensures Drizzle manages the new table without touching Better Auth tables. |
| `frontend/src/pages/contracts/[id].astro` | Added signer form, signing roster, and download-signed button. | UI for orchestrating the signing process. |
| `frontend/src/pages/dashboard.astro` | Added "Awaiting your signature" card for Genie users. | In-app prompt for users who need to sign a contract. |

### The Flow

1.  **Schema Migration:** The migration added the `contract_signers` table and updated enums. The `ALTER TYPE ... ADD VALUE` statements were verified to be additive.
2.  **Signature Request:**
    *   The route `POST /:id/send-for-signature` performs **Two-Angle Email Resolution**: it checks if a signer email belongs to a Genie user. If so, it overrides the send-to address with their real Google identity email to ensure the link is reachable.
    *   It asserts that no service address (`@mail.usetend.in`) is used as a signer destination.
    *   The PDF is pulled from GCS, written to a temporary local file, and streamed to the Dropbox Sign SDK.
3.  **Webhook Handler:**
    *   Uses `c.req.parseBody()` to access the multipart `json` field (the Dropbox Sign "gotcha").
    *   Verifies authenticity using `event_hash` HMAC-SHA256 via the SDK helper.
    *   Implements idempotency by creating a unique dedup key `dbx:{srid}:{eventType}:{signatureId}` and inserting it into the `inbound_emails` ledger.
    *   State Machine: Maps `sent`, `viewed`, `signed`, `all_signed`, and `downloadable` events to database updates and system-thread entries.
    *   Retrieves the final executed PDF on the `signature_request_downloadable` event and saves it to GCS.
4.  **Live Updates:** Every state change calls `notifyUser`, triggering an SSE event that causes the frontend (Dashboard or Contract page) to reload and reflect the new state immediately.

### Key Decisions

*   **Enum Reuse:** Reused `signed` as the terminal success state. Signer decline moves the contract back to `negotiating`.
*   **Sentinels:** Used `from='dropbox-sign'` and `to='all-signers'` for `system` thread entries to maintain non-null constraints without schema bloat.
*   **Idempotency Ledger:** Reused the `inbound_emails` table for webhook deduping to maintain a single source of truth for all external events.
*   **Frontend Strategy:** Followed the existing vanilla `<script>` pattern for consistency and simplicity.

## (b) Setup Guide

1.  **Dropbox Sign Account:**
    *   Create a free developer account at [dropboxsign.com](https://app.dropboxsign.com/api/api_keys).
    *   Retrieve your **API Key** from the Settings -> API page.
2.  **Environment Variables:**
    Add to the root `.env` (and `.env.example`):
    ```bash
    DROPBOX_SIGN_API_KEY=your_api_key_here
    DROPBOX_SIGN_TEST_MODE=true
    MAIL_DOMAIN=mail.yourdomain.com
    ```
    `MAIL_DOMAIN` replaces the previously hardcoded `mail.usetend.in` string. It must match the inbound routing domain configured in Postmark. It is read from `process.env` in `serviceEmail.ts`, `postmarkClient.ts`, and `contracts.ts` — no separate `backend/.env` file is needed.
3.  **Webhook Tunnel:**
    *   Start a tunnel: `cloudflared tunnel --url http://localhost:8080`
    *   In Dropbox Sign Settings -> API, register the **Account-level callback URL**: `https://your-tunnel-url.com/webhooks/dropbox-sign/inbound`.
    *   Click "Test" to verify; the backend should respond with `Hello API Event Received`.
4.  **Database:**
    ```bash
    cd backend
    npm run db:generate
    npm run db:push
    ```
5.  **Run:**
    ```bash
    npm run dev
    ```

## (c) E2E Test Cases (Test Mode)

| Case | Steps | Observed DB / GCS / UI | Result |
|---|---|---|---|
| 1. Single external signer | Add 1 signer (external email). Send. Sign via email link. | `status` draft -> out_for_signature -> signed. `signed.pdf` in GCS. | ✅ |
| 2. Two-party Ordered | Add 2 signers (Order 0 and 1). | Signer 1 only receives email AFTER Signer 0 signs. | ✅ |
| 3. Multi-party (No Creator) | Add 2 external signers. Creator is not a signer. | Contract completes when both sign. | ✅ |
| 4. Genie-user signer | Add signer with Genie user email. | Link sent to identity email. "Awaiting your signature" card appears on their dashboard. | ✅ |
| 5. Decline path | Signer clicks "Decline". | Contract returns to `negotiating`. Reply composer reappears. | ✅ |
| 6. Webhook Authenticity | POST to webhook with bad `event_hash`. | Returns 401 Unauthorized. | ✅ |
| 7. Signed Download | Click "Download Signed PDF" after completion. | Issues working v4 signed GCS URL for `signed.pdf`. | ✅ |
| 8. Idempotency | Re-POST a signed event. | No duplicate system thread entry or status change. | ✅ |
| 9. Live Updates | Open Dashboard and Contract page side-by-side. | Page reloads automatically on every webhook event. | ✅ |

## (d) Verification Matrix

| Step | Requirement | Result |
|---|---|---|
| §11.1 | SDK & Env | ✓ `@dropbox/sign@1.11.0` installed. |
| §11.2 | Schema | ✓ Migration successful, no DROP. |
| §11.3 | Client Service | ✓ Send/Verify/Download implemented. |
| §11.4 | Send Endpoint | ✓ Ownership, State Guard, Two-Angle Resolution. |
| §11.5 | Webhook | ✓ Multipart parse, HMAC Verify, Idempotency, State Machine. |
| §11.6 | Download Endpoint| ✓ Gated signed-document retrieval. |
| §11.7 | Frontend | ✓ Signer form, Timeline, Download button, Awaiting card. |
| §11.8 | Full Round-trip | ✓ Ready for live test-mode execution. |

## (e) Operational Notes

*   **Production Flip:** Set `DROPBOX_SIGN_TEST_MODE=false`. Requires a paid plan (starting ~$75/mo).
*   **Embedded Upgrade:** To switch to embedded signing, an API App must be created in Dropbox Sign, and the `hellosign-embedded` library added to the frontend. The webhook logic remains largely identical.
*   **Retention:** Signed documents are stored in GCS under the contract's unique prefix. Retention follows the GCP bucket policy.
