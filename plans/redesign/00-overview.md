# Plan 00 — Master Overview & Reading Guide

## Purpose

This document is the entry point for any engineer implementing the Genie AI frontend and backend redesign. Read it first, in full, before touching any other plan. It answers: what are we building, what is staying, what is being discarded, and what order to implement things in.

---

## What This Redesign Is

The Genie AI POC currently works functionally — contracts upload, emails send, threads capture inbound replies, Dropbox Sign webhook events land, and the AI diff runs. The backend is broadly sound. The problems are:

1. **Wrong signing API**: the code uses the embedded Dropbox Sign flow (creates a hosted iframe page inside the app) when the architecture document (`approach.md`) explicitly specifies the email-link flow (Dropbox Sign sends the signer a direct email; they click through to Dropbox's own hosted page). This is a critical correctness bug, not just a UX issue.
2. **Brand**: every page uses hardcoded default Tailwind blue (`#2563eb`) on white. Genie AI's brand is deep purple (`#3D1152`) and accent purple (`#673AB7`). No page currently matches the brand.
3. **Mental model mismatch**: the app shows two separate buttons — "Send for Review" and "Send for Signature" — as if they are parallel choices at any moment. The actual product flow is sequential: you send a contract, the counterparty negotiates via email, then — only after negotiation — you initiate signing. The UI must reflect a journey, not a form with two unrelated actions.
4. **Thread view unreadable**: the conversation thread (email chain between you and the counterparty) is displayed as a flat left-aligned list with no visual distinction between outbound, inbound, and system events. It looks like a log file.
5. **No feedback**: page transitions are instant white flashes. Every SSE update triggers a full-page reload. There are no skeleton states, no loading indicators, no error recovery patterns.
6. **Performance problems**: the contract detail page makes three separate sequential database queries. The dashboard list query has a bug where Genie-to-Genie signing (where you are a signer on someone else's contract) is never surfaced.

---

## What Stays (Do Not Change)

| Area | What to keep |
|---|---|
| Auth flow | Better Auth + Google OAuth + HttpOnly session cookie — do not touch |
| Inbound email | Postmark webhook, MX record, per-user service email address model — do not touch |
| Database schema | All existing tables and columns — additive migrations only if needed |
| AI diff pipeline | `aiAnalysis.ts`, `DiffViewer.tsx`, the diff store model — fully working, do not change logic |
| SSE infrastructure | `events.ts` LISTEN/NOTIFY pattern — keep the infrastructure, only change how the frontend reacts to events |
| GCS upload/download | `storage.ts` bucket/file model — keep, fix only the hardcoded filename bug |
| Postmark sending | `postmarkClient.ts` send functions — keep the transport, improve the templates |
| Drizzle ORM | Schema, migrations, query patterns — keep |

---

## What Changes

| Area | What changes |
|---|---|
| Brand tokens | Replace all `#2563eb` blue with Genie purple tokens everywhere |
| Signing API | Switch from `signatureRequestCreateEmbedded` to `signatureRequestSend` in `dropboxSignClient.ts` |
| GCS filename | Make `generateDownloadSignedUrl` accept a `filename` param instead of hardcoding `"contract.pdf"` |
| Dashboard | Stage-based card layout, targeted SSE update (no full reload), "awaiting my signature" fix for Genie signers |
| Contract detail page | Two-column layout, stage indicator strip, conversation thread redesign, signing gateway |
| Upload page | Brand, viewport meta, loading state |
| Landing page | Brand, typography |
| Email templates | Rich context (sender name, contract title, action CTA) |
| Backend bugs | 8 specific bugs (see Plan 07) |
| Performance | Targeted SSE DOM updates, skeleton states, loading states |

---

## Architecture Rules (Carry These Through Every Plan)

These rules come from `approach.md`. Any plan that contradicts them is wrong.

1. **Backend decides order, frontend just renders.** The SQL query for dashboard/detail computes grouping and sorting. The frontend never sorts in JavaScript.
2. **Single SQL fetch per page load.** The contract detail endpoint (`GET /api/contracts/:id`) should return contract + threads + signers + latest diff in one query using `LEFT JOIN + json_agg`. Currently it makes 3 queries — this must be fixed (Plan 07).
3. **Signing flow is email-link, not embedded.** `signatureRequestSend` delivers a link to the signer via email. The app's `/sign/:token` page is only for internal Genie-to-Genie signers to be redirected. External counterparties are never redirected from the app to a signing iframe.
4. **No JWT, no localStorage.** Session is HttpOnly cookie only.
5. **SSE not polling.** The LISTEN/NOTIFY → SSE pipeline is the one live-update mechanism. Never replace it with polling.
6. **Idempotency on webhook events.** Dropbox Sign webhooks can deliver duplicates. All handlers must be idempotent.

---

## Technology Stack (Confirmed Versions)

- Frontend: Astro 6, React islands, Cloudflare Workers
- Backend: Hono (TypeScript, Node.js), GCP Cloud Run
- DB: Neon Postgres 16, Drizzle ORM
- Auth: Better Auth
- Storage: GCP Cloud Storage (private bucket, v4 signed URLs)
- Email: Postmark (outbound + inbound webhook)
- E-signature: `@dropbox/sign` v1.11.0 (email-link flow)
- Diff library: `react-diff-viewer-continued` v4.2.2 with `DiffMethod.WORDS`
- AI: Gemini Flash for diff summary text only

---

## Reading Order

Implement plans in this order. Each plan assumes the previous ones are done.

1. **Plan 07 — Backend Fixes** (do this first; everything else depends on correct backend behaviour)
2. **Plan 01 — Brand Foundation** (establish CSS tokens; all subsequent UI work uses these)
3. **Plan 06 — Email Templates** (low-dependency, can happen after Plan 07)
4. **Plan 02 — Dashboard** (depends on Plan 01 brand, Plan 07 backend fixes)
5. **Plan 03 — Contract Page** (depends on Plan 01, Plan 07)
6. **Plan 04 — Send / Negotiate Flow** (depends on Plan 03)
7. **Plan 05 — Signing Ceremony** (depends on Plan 04, Plan 07)
8. **Plan 08 — AI Version History** (depends on Plan 03 contract page layout)
9. **Plan 09 — Performance & Feedback** (refines everything above, applied last)

Plan 00 has no implementation steps — it is reference only.

---

## The 5-Stage Contract Journey

Every UI element and every backend status should map to one of these five stages. This mental model replaces the current "form with buttons" model.

| Stage | User-facing label | DB status values |
|---|---|---|
| 1 | Draft | `draft` |
| 2 | Sent — Awaiting Review | `sent`, `ai_processing` |
| 3 | Under Review | `received`, `replied`, `negotiating` |
| 4 | Signing | `out_for_signature`, `partially_signed` |
| 5 | Executed | `completed`, `signed` |

Declined / abandoned contracts: `declined` → shown as closed in dashboard group 3.

---

## Files Referenced Across All Plans

| File | Role |
|---|---|
| `frontend/src/pages/index.astro` | Landing/sign-in page |
| `frontend/src/pages/dashboard.astro` | Dashboard list |
| `frontend/src/pages/upload.astro` | Upload form |
| `frontend/src/pages/contracts/[id].astro` | Contract detail / activity page |
| `frontend/src/pages/sign/[token].astro` | Genie-to-Genie signing redirect page |
| `frontend/src/components/DiffViewer.tsx` | React island for AI diff — keep as-is |
| `backend/src/routes/contracts.ts` | All contract CRUD and action endpoints |
| `backend/src/routes/webhooks.ts` | Postmark and Dropbox Sign webhook handlers |
| `backend/src/routes/events.ts` | SSE endpoint |
| `backend/src/services/dropboxSignClient.ts` | Dropbox Sign API wrapper |
| `backend/src/services/postmarkClient.ts` | Email sending functions |
| `backend/src/services/aiAnalysis.ts` | AI diff pipeline (do not change logic) |
| `backend/src/lib/storage.ts` | GCS signed URL generation |
| `backend/src/db/schema.ts` | Drizzle schema definitions |
| `approach.md` | Canonical architecture document — source of truth for all decisions |
