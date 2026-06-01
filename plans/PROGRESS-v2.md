# Genie v2 — Implementation Progress Log
> Append-only. Never rewrite earlier entries.
> Format: timestamp · item · what done · how verified · questions/blockers.

---

## 2026-05-30 — Session start

**Setup:** Git initialized in `/GENEAI_POC`, initial commit (`002fb08`) on `master`. Branch `v2-implementation` created.

**Read:** `HANDOFF-PROMPT.md`, `plans/v2-reduction-and-fixes-spec.md`, `approach.md` in full before touching code.

**Key finding — approach.md vs reality:** `approach.md` says "Dropbox Sign" everywhere; the actual codebase uses **BoldSign** (`backend/src/services/boldsignClient.ts`). As noted in HANDOFF, treating BoldSign as the e-signature provider throughout.

---

## BLOCKED — A1: GCS Signed-URL Signing (surfaced to user)

**Status:** BLOCKED — awaiting service-account JSON key from user.

**What the spec requires (E-A1):**
- Local dev: `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/key.json` pointing at a service account with object-read on the GCS bucket. Once set, `getSignedUrl` has a private key and works — no code change needed for this.
- Cloud Run: grant runtime SA `roles/iam.serviceAccountTokenCreator` on itself.
- Code hardening: wrap `getSignedUrl` in `storage.ts` with a typed error + clear log line.

**Current state:**
- ADC file exists at `~/.config/gcloud/application_default_credentials.json` but it is a user credential (no private key) — confirmed as the root cause of the 500s.
- `GOOGLE_APPLICATION_CREDENTIALS` is not set in `.env`.
- Code hardening (item 3) can proceed now; verification gate (PDF renders inline) requires the key.

**Handoff rule:** "if absent, STOP and ask the user" — surfaced.

**Resolution:** User added `GOOGLE_APPLICATION_CREDENTIALS` to root `.env` pointing at a service-account JSON key. Additionally fixed `responseDisposition` from `attachment` to `inline` in `/download-url` route so the iframe receives a viewable URL instead of triggering a browser download.

**Verified:** User confirmed PDF renders inline in the contract detail page. ✓

**Changes:**
- `backend/src/lib/storage.ts` — added `GcsSigningError` class; wrapped `getSignedUrl` in try/catch; added `disposition` param (default `'attachment'`, pass `'inline'` for iframe viewer)
- `backend/src/routes/contracts.ts` — imports `GcsSigningError`; `/download-url` route returns clean 503 on signing failure; passes `'inline'` disposition for iframe
- `.env.example` — documented `GOOGLE_APPLICATION_CREDENTIALS`

**Noted for B6:** When `signedStorageKey` is present (status=`signed`), `/download-url` should serve the signed PDF — it is the canonical document at that stage.

---

## 2026-05-30 — A5: Stable webhook URL + request waterfall collapse ✓

**Changes:**
- `backend/src/routes/contracts.ts` — `GET /:id` now returns `versions` (LATERAL subquery) and `documentUrl` (signed URL, inline disposition, signed PDF when `signedStorageKey` present)
- `backend/src/index.ts` — boot warning if `PUBLIC_BASE_URL` unset
- `.env.example` — documented `PUBLIC_BASE_URL` with named-tunnel guidance
- `frontend/src/pages/contracts/[id].astro` — removed separate `/versions` SSR fetch; `versions` + `documentUrl` read from main contract response; `loadPdf()` reads from `data-document-url` attribute (no client-side fetch); contacts SSR fetch retained (used for SSR-rendered signer chips — lazy refactor deferred to B6/A3)

**Verified:** page loads, PDF renders, one contract request in backend logs instead of four.

**Also done (user-approved, outside strict spec order):**
- Removed `completed-card` green banner; replaced with subtle green ring on stage strip (`stage-strip--signed`)
- "Download executed" button moved into doc viewer toolbar (green-tinted pill)
- Signed PDF shown in iframe when `signedStorageKey` present

**Noted for A4:** Thread/dashboard shows "in progress" for signed contracts — status display issue, address in A4 nextAction pass.

---

## 2026-05-30 — A4/E-A4: /versions auth, clean titles, nextAction ✓

**Changes:**
- `backend/src/routes/contracts.ts` — `/versions` endpoint now allows owner OR signer (mirrors GET /:id auth); `GET /:id` computes and returns `nextAction` (full enum per E-A4 spec)
- `backend/src/routes/webhooks.ts` — received-contract title now strips Genie suffix from subject (`split(' — ')[0]`), falls back to title-cased filename sans extension
- `frontend/src/pages/contracts/[id].astro` — `nextAction` read from main response; banner rendered above the document with correct copy + CTAs per E-A4; anchor IDs added to thread, signing, and reply sections for CTA scroll-links; `nextActionDownloadBtn` + `nextActionSignBtn` wired in JS

**Verified:** user confirmed banner visible and correct for signed and in-progress contracts. Addresses "thread shows in progress for signed contracts" note from A5.

---

## Next: A3 — Identity-email resolution + signer defaults + contact picker

---

## 2026-06-01 — B6: Contract detail reduction + component split ✓

**Commit:** `0ccd56c`

**Component extraction (user approved split):**
- `ContractDocViewer.astro` — document viewer panel + tab/editor JS
- `ContractSigningWizard.astro` — confirm-style signing form + signer management JS
- `ContractThread.astro` — activity thread + reply composer JS
- `[id].astro` reduced from 3541 → ~900 lines (HTML+CSS+JS)
- `<style>` changed to `<style is:global>` so extracted components inherit page CSS

**B6 UI changes applied:**
- **Cut** metadata card (CONTRACT / RECIPIENT / ORIGINAL PDF labels) — duplicated the header
- **Cut** Review/Signature toggle from draft send form and signing form
- **Cut** "Contract Under Review. The counterparty's reply is in the thread." status ribbon
- **Signing wizard → confirm-style:** pre-filled summary ("Requesting signatures from X and Y"), pencil icon (accent colour) on the right to toggle edit mode, role dropdown removed (roles inferred: index 0 = creator, rest = counterparty), note field removed, warning notice removed
- **Edit signers mode:** all signer cards show × when 2+ present (first signer no longer locked); edit-actions row shows `[+]` icon box left + `[Done]` right on same line
- **nextAction banner → minimal hint:** replaced colored card with a one-line text hint + inline CTA link; `executed` state removed (toolbar download button is sufficient)
- **Thread boilerplate stripped:** "— Sent via Genie AI", "Reply to this email…" lines removed at SSR time
- **Thread review links → buttons:** `/review/TOKEN` and `/sign/TOKEN` URLs rendered as "Review document" / "Sign document" anchor buttons
- **Thread inbound sender:** relay address (`@mail.usetend.in`) resolved to `contract.recipientName` via `counterpartyName` prop

**Verified:** User confirmed visually — document viewer visible, metadata card gone, signing confirm card functional with pencil icon, thread boilerplate stripped, hint line visible instead of colored banner.

---

## 2026-06-01 — E-B3: Dashboard restructure ✓

**Commit:** pending

**Changes:**
- **Sidebar removed** — `WORKSPACE / PROJECTS` sidebar (220px flex column) gone entirely
- **Three actionability groups replace project/asset layout:**
  - `NEEDS YOU` — `awaitingMySignature` OR status in `replied / negotiating / received / ai_processing`; rendered as large cards (thumbnail slot + title + status subtitle + accent CTA button)
  - `WAITING ON OTHERS` — non-terminal, non-urgent (sent, draft, out_for_signature, partially_signed, declined); rendered as compact `·` rows
  - `DONE` — signed/completed; collapsed by default, `▸` toggle to expand
- **One creation entry** — single `+ New contract` button in toolbar (top-left); all other creation entry points (per-project `+ Contract`, asset card `+ New`, sidebar `+ New project`) removed from primary surface
- **Projects → filter dropdown** — `All projects ▾` in toolbar (top-right); selecting a project hides contracts from other projects via `data-project` attribute toggling; `+ New project` moved to bottom of filter menu
- **No dual representation** — each contract appears exactly once (previously shown in both ASSETS row and IN PROGRESS row)
- **Targeted SSE** — on SSE event, fetches fresh `/api/contracts`, diffs against stored state, rebuilds only `groupsContainer` if something changed; no `location.reload()` (no white flash)
- **Preserved exactly:** sign-now pulse strip, demo seed banner, empty state, new project modal

**Verified:** User confirmed all checklist items ✓ — no sidebar, toolbar with correct CTAs, three groups with correct membership, cards vs rows distinction, DONE collapsed, no duplicate contracts, filter dropdown functional.

---

## 2026-06-01 — E-B4/B5: Create one-intent-box + unified front door (design review in progress)

**Status:** Implemented. Awaiting user design-review approval before commit.

**Backend changes:**
- `backend/src/routes/generate.ts` — added `POST /api/generate/extract`: one fast Gemini call that parses freeform lawyer intent into `{ title, contractType, partiesA: string[], partiesB: string[] }`. Returns arrays, normalises single-value responses. Uses `gemini-2.5-flash-lite`, 10s timeout.
- `POST /api/generate` — updated to accept `partiesA`/`partiesB` arrays (joins to strings) alongside legacy `partyA`/`partyB`. Contract generation prompt now uses "Party A (first part)" / "Party B (second part)" language.

**Frontend changes (`frontend/src/pages/create.astro`):**
- Removed all structured input fields (title, contract type, Party A/B dropdowns) — lawyers do not use "Party A / Party B", those are developer placeholders
- Single freeform textarea as the primary and only input, with instructional placeholder: *"Describe the contract — type, parties and their roles, governing law, and any key terms."*
- Two optional secondary fields: "Contract name" (auto-derived from extraction if blank) and "Add to project"
- Path chooser at top: "Generate with AI" (active pill) and "Upload a PDF" (ghost button)
- One-phase flow: click Generate → extraction runs silently behind the progress overlay → generate runs → contract opens. No two-step UI exposed to the user.
- Extraction fallback: if extract fails, title derived from first line of intent; default contractType NDA; partyA = signed-in user name

**Global CSS fixes (discovered during E-B4/B5):**
- `global.css` — added canonical `.form-input` definition (was missing; only existed in `[id].astro`'s `is:global` block, causing raw browser-default inputs on all other pages — wrong font, sharp corners, too shallow height)
- `--radius-input` bumped from `6px` to `8px` — 6px is visually indistinguishable from a rectangle at normal viewing distance
- `select.form-input` — explicit `border-radius`, `appearance: none`, `-moz-appearance: none` to ensure consistent rendering across browsers

**Product direction corrections (from user during this session):**
- "Party A / Party B" are developer terms, not legal terms. Lawyers use role-based names (Disclosing Party, Client, Employer, Licensor, etc.) — these should never appear in the lawyer-facing UI
- The Advanced section (structured fields) was removed entirely — lawyers write intent in natural language, the system extracts structure silently
- Placeholder text must be instructional (tell the lawyer what to include) not an example prompt

**Pending:** Design-review checkpoint — user to approve the create page layout before this is committed.

---

## ⚠️ CRITICAL PRODUCT FINDING — A6: AI Diff feature seam is broken

**Discovered:** 2026-06-01, during E-B3 investigation of the Vite `react-diff-viewer-continued` warning.

**Why it matters:** The colour-coded contract diff is the headline differentiator of this product — "negotiate + AI diff in one place." It is currently silently broken. Every demo that doesn't exercise it is selling the product short (per spec A6 language).

**What is supposed to happen:**
1. Counterparty returns a revised PDF via the `/review/:token` page
2. Inbound webhook receives it, calls `runDiffAnalysis()` in `aiAnalysis.ts`
3. AI extracts both texts, diffs them, generates a plain-English Gemini summary
4. `DiffViewer` on `contracts/[id].astro` shows the split diff with added/removed words highlighted

**The seam break (two problems, both must be fixed):**

**Problem 1 — Wrong storage target.** `runDiffAnalysis()` stores the result as a JSON blob in `contracts.aiAnalysis` (the column on the contracts table). The frontend (`[id].astro`) reads from `contract_versions` (the `contract_versions` table), looking for a row where `authoredBy === 'counterparty'`. No code ever writes a `contract_versions` row with `authoredBy: 'counterparty'`. `showVersionDiff` is therefore always `false` — the diff panel never renders.

**Problem 2 — Trigger condition.** `runDiffAnalysis()` only fires when the inbound email carries a **PDF attachment** (`attachmentRecords.find(a => a.contentType includes 'pdf')`). If the counterparty replies with text only, the attachment check fails silently and analysis never runs. Also, `triggerAiPipeline()` (called on every inbound) is a **stub** (`log.info 'AI pipeline stub — not yet implemented'`) — it does nothing.

**Fix required (A6, not yet scheduled):**
- After `runDiffAnalysis()` completes successfully, write a `contract_versions` row with `authoredBy: 'counterparty'`, `text: newRawText`, `versionNumber: <next>`. This bridges the seam so the frontend finds what it's looking for.
- OR: change the frontend to read from `contracts.aiAnalysis` directly (less clean — the text is already in the right shape in `contract_versions` for the owner's v1).
- The clean fix is backend-side: insert the counterparty version into `contract_versions` as part of `runDiffAnalysis()`.

**Status:** Not yet fixed. Logged here so it is not lost. Must be addressed in A6 (item 10 in spec order) before the demo, not after.

---

