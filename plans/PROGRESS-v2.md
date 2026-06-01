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



