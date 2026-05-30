# Plan 04 — Send & Negotiate Flow

## Purpose

Redesign the unified "Send → Reply → Signing Gateway" flow that lives in the left column of the contract detail page. This plan resolves the most fundamental conceptual problem in the current UI: the app presents "Send for Review" and "Send for Signature" as two independent, always-available parallel choices. The correct model is a gated, sequential journey.

---

## The Conceptual Problem (In Detail)

The current contract detail page has two separate card sections side-by-side:
1. A "Send for Review" form: recipient name + email + "Send" button — always visible
2. A "Send for Signature" form: signer configuration + "Send for Signature" button — also always visible, even on `draft` status

This implies to the user that they can either "send for review" or "send for signature" at any time, as if these are two modes. This is wrong in two ways:

**Wrong 1 — Sequential not parallel**: A contract must first go through review/negotiation, then signing. You cannot send a `draft` for signature. You cannot sign a contract that has never been reviewed. The actions are strictly ordered.

**Wrong 2 — Signing is a gateway, not a form**: Initiating signing is a significant, intentional action — it creates a legal signature request, sends emails to signers, and changes the workflow state permanently. It should not appear as just another form next to the "Send for Review" form.

---

## The Correct Mental Model

Think of the left column of the contract page as a **stage-specific action panel**. What it shows depends entirely on what stage the contract is in. A user never needs to choose between "Send for Review" and "Sign" — they see only the action relevant to the current stage.

```
Stage 1 (Draft)        → Show: "Send for Review" form
Stage 2 (Sent)         → Show: "Awaiting reply…" status message
Stage 3 (Under Review) → Show: Reply composer [in thread] + "Initiate Signing" gateway [subtle, secondary]
Stage 4 (Signing)      → Show: Signing status timeline
Stage 5 (Executed)     → Show: "Download Executed Contract"
Declined               → Show: "Contract declined — start a new draft or restart negotiation"
```

---

## Stage 1: Draft — "Send for Review"

**What it shows**: A form with:
- Recipient Name (text input, required)
- Recipient Email (email input, required)
- A message preview area showing the email that will be sent (non-editable, derived from the email template)
- A prominent `.btn-primary` button: "Send for Review"

**What it does on submit**:
1. POST `/api/contracts/:id/send` with `{ recipientName, recipientEmail }`
2. The backend sends the contract PDF to the recipient via Postmark, moves status to `sent`
3. On success: the page transitions to Stage 2 view

This form is only shown when `contract.status === 'draft'`. The condition must NOT include any other status.

**UX note**: The subject line of the outgoing email currently uses the uploaded filename (e.g., `MSA_v3_final_FINAL.pdf`) instead of the contract title the user typed. This is a backend bug fixed in Plan 07 (email templates). After Plan 07's fix, the message preview in this form can show the actual subject line.

---

## Stage 2: Sent — Awaiting Reply

**What it shows**: Not a form. A status card:
- Icon: envelope or hourglass (thin stroke, `var(--color-accent)`)
- Heading: "Awaiting reply from {contract.recipientName}"
- Sub-text: "Sent to {contract.recipientEmail}. You'll be notified here and by email when they reply."
- If `ai_processing`: show a subtle spinner with "AI is reviewing the changes…" below the status

**What it does**: Nothing interactive. The SSE handler will update this card when a reply arrives.

---

## Stage 3: Under Review — The Negotiation Loop

**What it shows in the left column**:
- A "Contract Status" summary card showing who has the ball (counterparty has not yet replied vs you have an unread reply)
- A "Signing Gateway" section — described below

**The Signing Gateway**:
The gateway is a collapsible/expandable card in the left column, styled subtly different from the "Send for Review" form (no prominent primary button visible until expanded). 

Collapsed state: A secondary-styled card with a label: "Ready to finalise? ›" with small text: "Initiate signing once you've agreed on the final terms." No button visible.

Expanded state (user clicks "Ready to finalise?"): Shows the signer configuration form:
- Owner is automatically added as a signer with order 1
- "Add another signer" section with name + email + order fields
- A warning: "Once sent for signature, the contract can no longer be edited or replied to."
- A `.btn-primary` button: "Send for Signature"
- A `.btn-ghost` cancel button to collapse back

**Why it is secondary**: During active negotiation, the dominant action is in the thread column (replying). The signing gateway is only relevant when both parties have finished negotiating — so it should not compete visually with the thread.

**When the gateway shows**: `['replied', 'negotiating'].includes(contract.status)` AND `contract.origin !== 'received'` (only the contract owner initiates signing). For received contracts, no signing gateway is shown in the owner's UI.

---

## Stage 4: Signing — Status Timeline

Covered in Plan 05.

---

## Stage 5: Executed — Download

**What it shows**: A card:
- Heading: "Contract Executed"
- Subtext: execution date, list of signers who signed
- A `.btn-primary` button: "Download Signed Contract" → calls `GET /api/contracts/:id/signed-url` and opens the GCS signed URL in a new tab

---

## Declined State

**What it shows**: A card with:
- Red-tinted banner: "Contract was declined by {decliner name}"
- Two options: "Download Original" and "Start New Version" (which would navigate to upload or create a draft copy — scope this as a stretch goal; at minimum show the declined message and the download button)

---

## Reply Composer (Thread Column)

The reply composer is described in Plan 03 but the business logic belongs here:

- Show when: `['replied', 'negotiating'].includes(contract.status)` (owner) or `['received', 'replied', 'negotiating'].includes(contract.status)` (received origin)
- POST target: `POST /api/contracts/:id/reply` with `{ body, file? }`
- On success: the reply is immediately appended to the thread as an optimistic update (add a new thread entry to the DOM with "You" label, the body text, and a "Sending…" indicator). The backend will fire an SSE event confirming receipt.
- On failure: show an inline error below the composer textarea. Never use `alert()`.

---

## What to Remove

- The current `'draft'` in `allowedStatuses` at `contracts.ts` line ~467 — after Plan 07 this is fixed on the backend, but also remove it from any frontend condition that shows signing options
- The current two-card parallel layout (both "Send for Review" and "Send for Signature" visible simultaneously)
- Any `alert()` calls for error handling — replace with inline error messages using a `.error-banner` CSS class

---

## Files to Modify

| File | Changes |
|---|---|
| `frontend/src/pages/contracts/[id].astro` | Replace current action cards with stage-conditional action panel |
| `backend/src/routes/contracts.ts` | Line ~467: remove `'draft'` from `allowedStatuses` for send-for-signature (also in Plan 07) |

## Files to Reference

| File | Why |
|---|---|
| `frontend/src/styles/global.css` | `.btn-primary`, `.btn-ghost`, `.card`, `.badge-*` classes |
| `approach.md` §4.5 | "Send for Signature" endpoint spec and signer configuration schema |
| `backend/src/routes/contracts.ts` POST `/:id/send` | Current "Send for Review" endpoint — check response shape |
| `backend/src/routes/contracts.ts` POST `/:id/send-for-signature` | Current endpoint — review what it expects and returns |
