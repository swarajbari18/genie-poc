# Genie AI POC — Implementation Master Prompt

## How to Use This File

Paste the entire contents of this file as your first message in a new Claude Code session. It is fully self-contained. You do not need to read any prior conversation — everything you need to know is here. Read it completely before writing a single line of code.

---

## Log Ownership — Critical Rule (Read Before Anything Else)

There are two kinds of log files in this system. Their ownership is strict and never crosses.

### Master log: `PROGRESS.md`
**Owner: the orchestrator (you, the agent reading this prompt). Only you write to this file. Subagents never touch it.**

Located at: `/home/swarajbari/Projects/GENEAI_POC/plans/redesign/PROGRESS.md`

You update it:
- When you are about to spawn a subagent: write `[TIME] DELEGATING Plan XX to subagent`
- When a subagent returns: write `[TIME] SUBAGENT Plan XX returned`
- After you verify the subagent's work: write `[TIME] VERIFIED Plan XX — tsc passed / failed`
- When you mark a plan complete: write `[TIME] COMPLETED Plan XX`
- When you hit a blocker: write `[TIME] BLOCKED — [description]`

**This is your persistent memory across sessions.** If your session is cut off, the next orchestrator session reads this file and resumes without asking the user anything.

### Plan logs: `PROGRESS-{plan-number}.md`
**Owner: the subagent assigned to that plan. The orchestrator does not write to these.**

Located at: `/home/swarajbari/Projects/GENEAI_POC/plans/redesign/PROGRESS-{NN}.md`
Examples: `PROGRESS-07.md`, `PROGRESS-01.md`, `PROGRESS-06.md`

The subagent creates and updates its own plan log throughout implementation:
- Before editing a file: `[TIME] ABOUT TO EDIT: path/to/file.ts — reason`
- After editing a file: `[TIME] EDITED: path/to/file.ts — what changed`
- When it hits a problem: `[TIME] PROBLEM: description + how resolved`
- When done: `[TIME] PLAN DONE — summary of all changes`

The subagent updates its log **before and after every single file change** — not in a batch at the end. If the subagent's session dies, the plan log shows the exact last completed edit, so it can be resumed without re-doing work.

### Why this separation eliminates conflicts

Plans are implemented sequentially (one at a time). At any moment, exactly one subagent is active. That subagent writes only to its own `PROGRESS-{NN}.md`. The orchestrator writes only to `PROGRESS.md`. These are always different files. No concurrent writes, no clobbering.

---

## If PROGRESS.md Already Exists When You Start

**Read it first.** It means a previous orchestrator session was interrupted. Find the last `DELEGATING` or `COMPLETED` entry, determine which plan was in progress, read that plan's `PROGRESS-{NN}.md` to see where the subagent left off, and resume from there. Do not restart from the beginning. Do not ask the user what was happening.

---

## The Product: What Genie AI Is and Why This POC Exists

Genie AI (`genieai.co`) is a legal contract drafting tool — it takes a brief and generates a contract document. The product ends at "here is your PDF." But the real workflow doesn't end there: after drafting, a user must negotiate with the counterparty (send the contract, receive redlines, go back and forth), then send for e-signature, and finally execute.

Today, Genie users do this manually: download the PDF, upload it to DocuSign, email it to the counterparty, receive replies in their personal inbox, re-upload new versions manually, and repeat. It is fragmented, error-prone, and completely disconnected from where the contract was created.

This POC plugs that gap. It is a contract workflow app that handles the journey from "I have a drafted contract" to "all parties have signed and I have the executed PDF" — entirely in-app. The five stages are:

1. **Draft** — upload the contract PDF
2. **Sent / Awaiting Review** — deliver it to the counterparty via email
3. **Under Review / Negotiating** — counterparty replies (with or without a revised PDF); AI analyses changes
4. **Signing** — send for e-signature via Dropbox Sign; track who has signed
5. **Executed** — all parties have signed; download the final PDF

This is a job application POC. It must look and feel production-grade. The current state of the frontend does not — it uses default Tailwind blue on white and is completely off-brand, has a broken mental model (two parallel "send" buttons instead of a sequential journey), has no loading states, and has critical backend bugs that make signing not work at all.

---

## The 41 Problems We Identified

These were catalogued across 10 categories before the plans were written. All 41 are addressed across the 10 implementation plans.

**Brand (5)**: No Genie brand tokens anywhere. All `#2563eb` blue. Wrong font (system-ui instead of Inter/DM Sans). No shared CSS file. Each page re-declares its own `:root` block.

**Landing Page (3)**: Off-brand colours. No visual identity. No tagline ("Agree With Confidence").

**Fundamental Flow — Mental Model (6)**: "Send for Review" and "Send for Signature" appear as two parallel options, always visible. The app has no concept of a sequential journey. No stage indicator. No "where am I?" context. Draft contracts show a signing form. Users can attempt to sign before anyone has reviewed anything.

**Signing (5)**: Wrong Dropbox Sign API used (`signatureRequestCreateEmbedded` instead of `signatureRequestSend`). `CLIENT_ID` env var required for something that doesn't need it. Genie-to-Genie signing (where you are a signer on someone else's contract) is invisible on the dashboard. `/sign/:token` page has no loading state. `allowedStatuses` includes `'draft'`.

**Thread View (6)**: Newest message at top (backwards). All entries — outbound, inbound, system events — look identical. No direction indicators. No sender attribution. System events (signing lifecycle) styled the same as human messages. Attachment chip shows "contract.pdf" for every file.

**Dashboard (5)**: "Your Contract Address" is the first element — buries the actual work. Contract tiles only clickable on the text link, not the row. Raw DB enum strings displayed as status (`out_for_signature`, `ai_processing`). Full page reload on every SSE event. Genie signer contracts never shown.

**Performance (4)**: Three separate DB queries on contract detail page. Full page reload on SSE instead of targeted DOM update. No loading states on form submissions. No skeleton states.

**Copy / Content (3)**: Generic email bodies ("Please review the attached contract and reply with your feedback."). Subject line uses uploaded filename, not contract title. No sender name in outbound emails.

**Missing Patterns (2)**: `alert()` used for all error handling everywhere. No optimistic UI on reply submit.

**Positioning / Architecture (2)**: GCS filename hardcoded as `"contract.pdf"` on every download. No `Cache-Control: no-store` on signed URL endpoints (Cloudflare can cache expired URLs).

---

## The 10 Implementation Plans

All plans live in `/home/swarajbari/Projects/GENEAI_POC/plans/redesign/`. Each plan is a complete knowledge document — it tells you what file to change, why, which SDK methods to use, and what design pattern to apply. They do NOT contain actual code. The subagent writes the code.

| File | What it covers |
|---|---|
| `00-overview.md` | Master context, architecture rules, reading order, 5-stage model, technology stack |
| `01-brand-foundation.md` | CSS custom properties, `global.css`, `AppLayout.astro`, primitive component classes |
| `02-dashboard.md` | Pipeline card layout, status labels, UNION query for Genie signers, targeted SSE update |
| `03-contract-page.md` | Two-column layout, stage indicator, thread redesign, ordering fix |
| `04-send-negotiate-flow.md` | Stage-gated action panel, reply composer conditions, signing gateway |
| `05-signing-ceremony.md` | Dropbox Sign API switch to email-link flow, signing timeline UI, webhook chain |
| `06-email-templates.md` | Rich email bodies, dynamic GCS filenames, subject line fix, Cache-Control |
| `07-backend-fixes.md` | All 8 confirmed backend bugs with exact file:line references |
| `08-ai-version-history.md` | Surfacing the AI diff in UI, version history panel, AI summary callout |
| `09-performance-feedback.md` | Skeletons, spinners, replace `alert()`, optimistic reply, SSE policy |

**Read `00-overview.md` first, in full, before opening any other plan.**

---

## Implementation Order

Plans are strictly sequential — each plan depends on the previous ones being done. Never run two plans in parallel.

```
Step 1:  Plan 07 — Backend Fixes          (all 8 bugs; everything else depends on this)
Step 2:  Plan 01 — Brand Foundation       (CSS tokens + AppLayout; all UI plans use these)
Step 3:  Plan 06 — Email Templates        (low dependency; can follow Plan 07)
Step 4:  Plan 02 — Dashboard              (depends on Plan 01 brand + Plan 07 backend)
Step 5:  Plan 03 — Contract Page          (depends on Plan 01 + Plan 07)
Step 6:  Plan 04 — Send / Negotiate Flow  (depends on Plan 03 layout)
Step 7:  Plan 05 — Signing Ceremony       (depends on Plan 04 + Plan 07 Fix 1)
Step 8:  Plan 08 — AI Version History     (depends on Plan 03 layout)
Step 9:  Plan 09 — Performance & Feedback (applied last, refines everything above)
```

---

## How to Implement Each Plan (Subagent Strategy)

Each plan is implemented by a dedicated subagent. The orchestrator spawns one subagent at a time, waits for it to return, verifies the output, then moves to the next plan.

### What to include in every subagent brief

Construct the brief by concatenating these sections in order:

**Section A — Context (paste verbatim):**
```
You are implementing one plan of a multi-plan redesign of the Genie AI POC — a contract
workflow app (Send → Negotiate → Sign). Read every instruction carefully before touching
any file.

PRODUCT CONTEXT:
Genie AI is a legal contract drafting tool. This POC handles the workflow after drafting:
deliver the contract by email, negotiate with the counterparty via threaded replies, send
for e-signature via Dropbox Sign, and download the executed PDF. It is a job application POC
and must look and feel production-grade.

ARCHITECTURE RULES (non-negotiable — approach.md is source of truth):
1. Backend decides order, frontend just renders. Never sort in JavaScript.
2. Single SQL fetch per page load. Contract detail: one query with LEFT JOIN + json_agg.
3. Signing is email-link flow: signatureRequestSend. No iframe. No CLIENT_ID for the request.
4. No JWT, no localStorage. Session is HttpOnly cookie only.
5. SSE not polling. LISTEN/NOTIFY → SSE is the one live-update mechanism.
6. Webhook handlers are idempotent. Dropbox Sign can re-deliver events.

TECH STACK:
- Frontend: Astro 6, React islands, Cloudflare Workers. Files in frontend/src/
- Backend: Hono (TypeScript, Node.js), GCP Cloud Run. Files in backend/src/
- Database: Neon Postgres 16, Drizzle ORM. Schema in backend/src/db/schema.ts
- E-signature: @dropbox/sign v1.11.0 — email-link flow (signatureRequestSend), not embedded
- Diff: react-diff-viewer-continued v4.2.2, DiffMethod.WORDS. frontend/src/components/DiffViewer.tsx
- Auth: Better Auth, Google OAuth, HttpOnly cookie — DO NOT TOUCH

BRAND TOKENS:
--color-accent: #673AB7 (ALL interactive elements — replace every #2563eb with this)
--color-brand-deep: #3D1152 (logo, footer)
--color-text-primary: #212121
--color-text-muted: #828282
--color-bg-subtle: #F9F9F9
--color-border-light: #F2E7FE (highlight cards)
--radius-card: 12px / --radius-button: 8px
--font-family-base: 'Inter', 'DM Sans', system-ui, sans-serif
```

**Section B — Your plan log file (tell the subagent its log path):**
```
YOUR LOG FILE: /home/swarajbari/Projects/GENEAI_POC/plans/redesign/PROGRESS-{NN}.md

You must update this file BEFORE and AFTER every single file change — not in a batch at the
end. Format each entry as:
  [TIME] ABOUT TO EDIT: path/to/file — reason
  [TIME] EDITED: path/to/file — what changed (one line)
  [TIME] PROBLEM: description — how resolved
  [TIME] PLAN DONE — list of all files changed

If you cannot complete the plan in one session, stop at a clean boundary (after a completed
file save), write your last log entry, and the next agent will resume from there.

DO NOT write to PROGRESS.md — that file belongs to the orchestrator. Only write to
PROGRESS-{NN}.md.
```

**Section C — The plan content (paste the full text of the plan file for Plan XX).**

**Section D — Resume instruction (if the plan log already exists):**
```
PROGRESS-{NN}.md already exists. Read it first. Find the last "EDITED" entry.
Resume from the next file that has not yet been changed. Do not redo work that is
already logged as done.
```

### After each subagent returns

1. Read `PROGRESS-{NN}.md` — verify the log was written throughout (not just at the end)
2. Read the key files that were supposed to change — spot-check that the changes are present
3. Run type check:
   - Backend: `cd /home/swarajbari/Projects/GENEAI_POC/backend && npx tsc --noEmit`
   - Frontend: `cd /home/swarajbari/Projects/GENEAI_POC/frontend && npx astro check`
4. If type check passes: update `PROGRESS.md` with `COMPLETED Plan XX — VERIFIED`
5. If type check fails: spawn another subagent with the error output and `PROGRESS-{NN}.md` contents, instructing it to fix the type errors only

---

## Technology Stack (Quick Reference)

- **Frontend**: Astro 6, React islands, Cloudflare Workers. Files in `frontend/src/`.
- **Backend**: Hono (TypeScript, Node.js), GCP Cloud Run. Files in `backend/src/`.
- **Database**: Neon Postgres 16, Drizzle ORM. Schema in `backend/src/db/schema.ts`.
- **Auth**: Better Auth, Google OAuth, HttpOnly session cookie. Do not touch.
- **Storage**: GCP Cloud Storage private bucket, v4 signed URLs. `backend/src/lib/storage.ts`.
- **Email**: Postmark (outbound + inbound webhook). `backend/src/services/postmarkClient.ts`.
- **E-signature**: `@dropbox/sign` v1.11.0 — **email-link flow** (`signatureRequestSend`), not embedded. `backend/src/services/dropboxSignClient.ts`.
- **Diff**: `react-diff-viewer-continued` v4.2.2, `DiffMethod.WORDS`. `frontend/src/components/DiffViewer.tsx` — do not change.
- **AI**: Gemini Flash for diff summary text only. `backend/src/services/aiAnalysis.ts` — do not change.

---

## Architecture Rules (Non-Negotiable)

These come from `approach.md`. Violating them breaks the system.

1. **Backend decides order, frontend just renders.** Never sort in JavaScript.
2. **Single SQL fetch per page load.** Contract detail: one query with `LEFT JOIN + json_agg`.
3. **Signing is email-link, not embedded.** `signatureRequestSend`. No iframe. No `CLIENT_ID` for the request.
4. **No JWT, no localStorage.** Session is HttpOnly cookie only.
5. **SSE not polling.** LISTEN/NOTIFY → SSE is the one live-update mechanism.
6. **Webhook handlers are idempotent.** Dropbox Sign can re-deliver events.

---

## Brand Tokens (Quick Reference)

```css
--color-brand-deep:    #3D1152   /* logo, footer */
--color-accent:        #673AB7   /* ALL interactive elements */
--color-text-primary:  #212121
--color-text-muted:    #828282
--color-bg-white:      #FFFFFF
--color-bg-subtle:     #F9F9F9
--color-border-light:  #F2E7FE   /* highlight cards */
--color-border-mid:    #D3B4F7
--font-family-base:    'Inter', 'DM Sans', system-ui, sans-serif
--radius-card:         12px
--radius-button:       8px
--gradient-brand:      linear-gradient(180deg, #6C81FA 35%, #5D58FF 53%, #673AB7 90%)
```

Replace every instance of `#2563eb` in the codebase with `var(--color-accent)`.

---

## Critical Bugs Summary (for quick orientation)

| Bug | File | Line | Impact |
|---|---|---|---|
| Wrong Dropbox Sign API | `dropboxSignClient.ts` | 57 | Signing completely broken |
| Hardcoded GCS filename | `storage.ts` | 19 | Every download named "contract.pdf" |
| Missing Genie signer contracts | `contracts.ts` | 71 | Genie-to-Genie signing invisible |
| `'draft'` in allowedStatuses | `contracts.ts` | ~467 | Can sign before review |
| Case-sensitive email match | `webhooks.ts` | ~234 | Silent signer-not-found failure |
| Thread ordered newest-first | `contracts.ts` | GET /:id | Thread reads backwards |
| Three DB queries on detail page | `contracts.ts` | ~118–138 | 3× latency on busiest page |
| No retry on 409 from Dropbox | `webhooks.ts` | download call | Signed PDF never saved if not ready |

---

## What PROGRESS.md Should Look Like

Create it immediately when you start. Format:

```markdown
# Implementation Progress — Genie AI POC Redesign

## Overall Status
- [ ] Plan 07 — Backend Fixes
- [ ] Plan 01 — Brand Foundation
- [ ] Plan 06 — Email Templates
- [ ] Plan 02 — Dashboard
- [ ] Plan 03 — Contract Page
- [ ] Plan 04 — Send/Negotiate Flow
- [ ] Plan 05 — Signing Ceremony
- [ ] Plan 08 — AI Version History
- [ ] Plan 09 — Performance & Feedback

---

## Log (orchestrator only — append, never rewrite)

[TIME] SESSION START — reading existing progress / starting fresh
[TIME] DELEGATING Plan 07 to subagent — log at PROGRESS-07.md
[TIME] SUBAGENT Plan 07 returned
[TIME] VERIFIED Plan 07 — tsc --noEmit passed
[TIME] COMPLETED Plan 07 ✓
[TIME] DELEGATING Plan 01 to subagent — log at PROGRESS-01.md
...
```

---

## What PROGRESS-{NN}.md Should Look Like (Subagent Log)

Each subagent creates this on its first edit and appends throughout. Example for Plan 07:

```markdown
# Plan 07 Implementation Log — Backend Fixes

[TIME] ABOUT TO EDIT: backend/src/services/dropboxSignClient.ts — switch from signatureRequestCreateEmbedded to signatureRequestSend; remove clientId from request object
[TIME] EDITED: backend/src/services/dropboxSignClient.ts — replaced embedded request with SignatureRequestSendRequest; removed CLIENT_ID from line 8 and line 48
[TIME] ABOUT TO EDIT: backend/src/lib/storage.ts — add filename param to generateDownloadSignedUrl
[TIME] EDITED: backend/src/lib/storage.ts — added filename:string param; responseDisposition now uses encodeURIComponent(filename)
[TIME] ABOUT TO EDIT: backend/src/routes/contracts.ts — update callers of generateDownloadSignedUrl to pass filename
[TIME] EDITED: backend/src/routes/contracts.ts — 3 callers updated; also removed 'draft' from allowedStatuses (~line 467)
[TIME] ABOUT TO EDIT: backend/src/routes/webhooks.ts — fix case-sensitive email match + add retry on 409
[TIME] EDITED: backend/src/routes/webhooks.ts — toLowerCase() on both sides of email comparison; added 5s retry on 409 for downloadSignedFile
[TIME] PLAN DONE — 4 files changed: dropboxSignClient.ts, storage.ts, contracts.ts, webhooks.ts
```

---

## Resumption Protocol (for interrupted sessions)

When a new session starts with this prompt:

1. Check if `PROGRESS.md` exists → if yes, read it completely
2. Find the last entry in the log — it tells you the current state
3. If the last entry is `DELEGATING Plan XX`: read `PROGRESS-XX.md` to see how far the subagent got, then spawn a new subagent with the resume instruction (Section D in the brief template above)
4. If the last entry is `SUBAGENT Plan XX returned` but no `VERIFIED`: run the type check yourself and proceed
5. If the last entry is `COMPLETED Plan XX`: move to the next plan in the implementation order
6. Never ask the user what was happening — the log tells you

---

## Instruction to Start

1. Check if `PROGRESS.md` exists at `/home/swarajbari/Projects/GENEAI_POC/plans/redesign/PROGRESS.md`
2. If it exists → follow the Resumption Protocol above
3. If starting fresh:
   a. Create `PROGRESS.md` using the template above
   b. Read `00-overview.md` in full
   c. Read `07-backend-fixes.md` in full
   d. Update `PROGRESS.md`: `DELEGATING Plan 07 to subagent`
   e. Spawn subagent for Plan 07 using the brief template (Sections A + B + C)
   f. When subagent returns: verify, type-check, update `PROGRESS.md`, move to Plan 01
   g. Continue sequentially through all 9 plans
4. When all 9 plans are done: write `ALL PLANS COMPLETE` in `PROGRESS.md` and report to the user
