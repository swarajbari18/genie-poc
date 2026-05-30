# Component 9 — AI Contract Diff Analysis
## Implementation Plan (standalone)

**Written:** 2026-05-26
**Component:** 9 — AI Contract Diff Analysis (git-style, **LLM-free** change detection + an optional plain-English summary).
**Status:** ⬜ not started.
**What it covers:** when a counterparty returns a **modified PDF** (a reply with an attachment), automatically compute a **git-style, colour-coded, word-level diff** of the new version against the *previous* version, render it side-by-side (additions green, deletions red) on the contract thread, and layer **one optional LLM call** that writes a plain-English summary of what changed — feeding the human's decision to **accept-and-sign or counter again**. The change *detection* is deterministic (Myers diff, exactly like `git diff`) and **uses no LLM**; the LLM only summarizes the already-computed patch.

**Depends on (grounded in the REAL code state, not approach.md's stale ⬜ markers):**
- **Components 1–4 built** (auth, service email, upload, dashboard, send, GCS, Postmark inbound). Component 4's *real* Postmark round-trip was test-blocked on account verification — that blocks the *real* end-to-end run of this component too (a reply with an attachment is the trigger), so the same §1.3-style caveat from the 5/6/7 plan applies: build it, exercise it via a tunnel + seeded inbound payload, and record the **real** run once Postmark clears.
- **Components 5/6/7 are BUILT IN CODE** despite approach.md's build-plan marking them ⬜. Verified by reading: `POST /:id/reply` exists (`backend/src/routes/contracts.ts:208`); the dashboard `sort_group` raw query is shipped (`contracts.ts:32-63`); the SSE bus + `notifyUser` exist (`backend/src/lib/events.ts`); `processInbound()` and the received-contract branch exist (`backend/src/routes/webhooks.ts:112`, `:152-170`, `:264-299`). This component **consumes the reply/inbound version stream** (the `reply-{ts}.pdf` objects + inbound thread rows those components produce) and the **`notifyUser` seam** for live skeleton→populated updates.
- **The trigger seam already exists:** `triggerAiPipeline(insertContractId, attachmentRecords)` is a **no-op stub** called at the very end of `processInbound()` (`webhooks.ts:360`, defined `:373-382`). Component 9 replaces that stub's body.
- **INDEPENDENT of Component 8 (signing).** This does not depend on signing and signing does not depend on it. It **feeds** the human decision that precedes Component 8's `POST /:id/send-for-signature`: the diff + summary is what tells the user "this version is acceptable → send for signature" vs "counter again". A signer **decline** (C8) drops the contract back to `negotiating`; the next returned version flows through this same diff pipeline.

> **Convention (same as Components 4–8):** this file is the **plan** — intent, seams, manual steps, done-criteria. The **implementation notes** (`implementation-notes.md` in this folder) are the *as-built* walkthrough and are written by whoever implements this, **not** here. §14 specifies exactly what those notes must contain. The bar for "done" is a **real end-to-end run with real PDFs you can see** — never synthesized data.

---

## 0. Why this matters

When a counterparty returns a modified document, the user must see **exactly what changed** to decide "accept this and move to signing, or counter again". `git diff` shows precise change sets with **no AI** — a deterministic algorithm — and we do the same: the detection is the Myers diff, free, instant, identical output every time, every comparison, **zero LLM calls**. An LLM is used only *afterward*, for a single optional plain-English summary layered on top of the computed diff. This keeps detection cheap, reproducible, and incapable of hallucinating changes that aren't really in the document.

---

## 1. SDK & dependency additions

### 1.1 Backend (`backend/package.json` `dependencies`, alongside `postmark`, `@google-cloud/storage`)

```bash
cd backend
npm install diff@9.0.0 pdf-parse@2.4.5
# + ONE LLM SDK (pick per the key you have — see §1.3):
#   npm install @google/genai          # for GEMINI_API_KEY
#   npm install @anthropic-ai/sdk       # for ANTHROPIC_API_KEY
```

- **`diff@9.0.0` (jsdiff)** — Myers diff; deterministic, no AI. We use `diffWords` (word-level, whitespace-normalized) for the rendered diff and `structuredPatch` for the LLM input. **DO NOT install `@types/diff`** — jsdiff v8+ ships its own TypeScript types; adding `@types/diff` causes duplicate/conflicting declarations. v9 targets current Node LTS (fine for this Cloud Run backend).
- **`pdf-parse@2.4.5`** — the rewritten 2.x line (pure TS, ESM, maintained). Pin to `2.x`; do **not** drift back to the stale 1.1.1 era. Extracts text from a PDF Buffer. *Escalation path (do NOT install unless needed):* if reading-order/columns come out badly, swap extraction to `pdfjs-dist@5.7.284` (`getTextContent()` per-item positions) or `unpdf@1.6.2`; keep the rest of the pipeline identical. Document if you escalate.
- **LLM SDK** — exactly one, matching the key present (§1.3). The summary is a single short call; any chat-completions-style SDK works. Keep the call behind a small adapter in `aiAnalysis.ts` so swapping providers is a one-function change.

### 1.2 Frontend — the React-island decision (read §8 for the full tradeoff)

The renderer is the only place this component needs frontend work. Two viable paths:

- **Path A (RECOMMENDED): `react-diff-viewer-continued@4.2.2` in a React island.** `@astrojs/react@5.0.5` + `react@19` + `react-dom@19` are **already wired** (`frontend/astro.config.mjs` has the `react()` integration; `frontend/package.json` lists them). **No `components/` directory exists yet** — this island is the **first React component in the project**, so create `frontend/src/components/` and mount with `client:visible`/`client:load`. Install:
  ```bash
  cd frontend && npm install react-diff-viewer-continued@4.2.2
  ```
- **Path B (alternative, no island): `diff2html@3.4.56` in a vanilla `<script>`.** Turns a unified-diff string (jsdiff `createTwoFilesPatch` output) into GitHub-style HTML, consistent with the shipped vanilla-script pattern (Components 5/6/8 all use vanilla scripts). Install `diff2html` + its CSS.

> **Recommendation:** **Path A.** A read-only legal diff for a businessperson benefits from `react-diff-viewer-continued`'s built-in **collapsible unchanged regions** and intra-line word highlighting — exactly the "like VS Code" experience asked for — with almost no code. The React runtime is already configured; the cost of introducing the first island here is low and is the natural place for it (this is the most interactive surface in the app). State the choice in the notes either way. **Do NOT use Monaco** (`@monaco-editor/react`) — see §12.

### 1.3 Env var (the only new config Component 9 introduces)

Add **one** of these to `backend/.env` and `.env.example` (production = GCP Secret Manager → Cloud Run). approach.md "Environment Variables" already lists them, commented, for Component 9:

```bash
# AI diff summary (Component 9 only) — the DIFF needs NO key; this is for the optional summary only.
GEMINI_API_KEY=...     # or
ANTHROPIC_API_KEY=...
```

**Critical design property:** the **diff itself needs no key**. If neither key is set (or the call fails), the pipeline still produces the full colour-coded diff and resolves cleanly with an empty summary (§6.7). This is the "no-LLM detection" guarantee and is a tested done-criterion (§10 step 7, §14c).

---

## 2. What already exists — extend, do not rebuild

Grounded against the current code (line numbers verified 2026-05-26):

| File | Today | What C9 adds |
|---|---|---|
| `backend/src/routes/webhooks.ts` | `processInbound()` (`:112`) ends by calling `triggerAiPipeline(insertContractId, attachmentRecords)` (`:360`); `triggerAiPipeline()` is a **no-op stub** (`:373-382`) that just logs | **REPLACE the stub body** to fire the C9 pipeline async/non-blocking when an inbound **PDF reply on a matched contract** is present (see §7). The matched-reply branch already wrote `status='replied'` (`:321-326`) and called `notifyUser(...,'replied')` (`:333-341`) before this point. |
| `backend/src/services/` | `postmarkClient.ts`, `serviceEmail.ts` | **ADD** `aiAnalysis.ts` (the whole pipeline — §6). Routes-vs-services rule: the webhook route triggers; the service does the work. |
| `backend/src/db/schema.ts` | `contracts` already has `aiAnalysis: jsonb('ai_analysis')` (`:135`), `aiStartedAt` (`:136`), `aiCompletedAt` (`:137`); `contractStatusEnum` already contains `'ai_processing'` (`:40`), `'completed'` (`:41`), `'negotiating'` (`:42`) | **NO SCHEMA CHANGE NEEDED.** Confirmed present. C9 only *writes* these existing columns + transitions among existing enum values. (Optionally add a `ContractAiAnalysis` TS type next to the type exports at `:244-251` for the `aiAnalysis` JSON shape — type-only, no migration.) |
| `backend/src/lib/events.ts` | `notifyUser(userId, {contractId, status})`, `UserUpdatePayload` (`:25-29`) | **No change.** Call `notifyUser` on `ai_processing` start and on `completed`/`negotiating` finish (§7). |
| `backend/src/lib/storage.ts` | `contractsBucket`, `generateDownloadSignedUrl(storageKey, expiresInSeconds=3600)` | **No change.** Download the two PDF versions with `contractsBucket.file(key).download()` → `[Buffer]` (same call as `contracts.ts:144`). "Download Their Version" reuses the existing `GET /:id/attachment` endpoint (`contracts.ts:380`). |
| `backend/src/routes/contracts.ts` | `GET /:id` returns `{ contract, threads }` (`:105-119`); `GET /:id/attachment` signs a thread-attachment key after ownership+key-in-thread check (`:380-420`) | **No new endpoint required.** `aiAnalysis` rides along on the `contract` row already returned by `GET /:id`. (Optional: a thin `GET /:id/diff` that returns just `contract.aiAnalysis` if you want to lazy-load the patch — recommended only if the patch is large; default is to ship it inline on `GET /:id`.) |
| `frontend/src/pages/contracts/[id].astro` | thread render; SSE wired → on a `status` event for this contract it does `window.location.reload()` (`:216-222`) | **ADD** an AI-analysis block when `contract.aiAnalysis` is present: the plain-English **summary**, a **"View Full Diff"** side-by-side viewer, and **"Download Their Version"**. A skeleton when `status==='ai_processing'`. The existing SSE reload flips skeleton→populated on the `ai_processing → completed` event (§8). |
| `frontend/src/components/` | **does not exist** | **NEW** (Path A): create the directory + the `DiffViewer.tsx` island (and optionally `ReplyViewer.tsx`). This is the project's first React island — the runtime is already configured. |

---

## 3. New files this component introduces

- `backend/src/services/aiAnalysis.ts` — **NEW.** The full pipeline: select previous version → download both PDFs → extract text (`pdf-parse` v2.x) → normalize → `diffWords` (render) + `structuredPatch` (LLM input) → optional single LLM summary over the patch → write `ai_analysis` + `ai_started_at`/`ai_completed_at` + status transition → `notifyUser`. (§6.)
- `frontend/src/components/DiffViewer.tsx` — **NEW (Path A).** A React island wrapping `react-diff-viewer-continued`, fed the old/new text (or the precomputed word-diff) from `contract.aiAnalysis`. Side-by-side, word-level green/red, collapsible unchanged regions, read-only.
- *(Optional, Path A)* `frontend/src/components/ReplyViewer.tsx` — the summary header + "View Full Diff" toggle + "Download Their Version" button, hosting `DiffViewer`. May instead live as markup + vanilla script on the page; implementer's call (§8).
- **No migration** (schema already has the columns/enum values — §2, confirmed).

---

## 4. The `ai_analysis` JSON shape (define once, store on `contracts.ai_analysis`)

Store a single typed object. The renderer reads `summary` + the text/patch; the LLM is fed `patch` only.

```jsonc
{
  "version": 1,                         // schema version of THIS json blob, for forward-compat
  "fromThreadId": "<thread row id of the PREVIOUS version>",
  "toThreadId":   "<thread row id of the NEW inbound version>",
  "fromStorageKey": "contracts/{u}/{c}/original.pdf",       // or a prior reply-{ts}.pdf
  "toStorageKey":   "contracts/{u}/{c}/reply-{ts}.pdf",
  "oldText": "<normalized extracted text of the previous version>",   // feeds react-diff-viewer
  "newText": "<normalized extracted text of the new version>",        // feeds react-diff-viewer
  "patch": { /* jsdiff structuredPatch object: { oldFileName, newFileName, hunks:[{ oldStart, oldLines, newStart, newLines, lines:[" ctx","-del","+add"] }] } */ },
  "stats": { "additions": 0, "deletions": 0, "changedHunks": 0 },     // cheap counts for the badge + completed/negotiating heuristic
  "summary": "3 changes: payment term 30→45 days; liability cap added; signatory name updated.",  // "" if LLM unavailable/failed
  "summaryStatus": "ok" | "skipped_no_key" | "failed",               // honest provenance of the summary
  "model": "gemini-2.x-flash" | "claude-haiku-...",                   // null when summaryStatus != ok
  "extractor": "pdf-parse@2.4.5",
  "diffEngine": "jsdiff@9.0.0 diffWords",
  "generatedAt": "2026-05-26T12:00:00.000Z"
}
```

**Notes on the shape:**
- Storing both `oldText`/`newText` AND `patch` is deliberate: `react-diff-viewer-continued` renders cleanly from the two texts (it runs jsdiff internally), while `patch` (jsdiff `structuredPatch`, a few hundred tokens) is the *exact* thing fed to the LLM and is also what `diff2html` needs if you pick Path B. If document size makes storing both texts heavy, store `patch` + render Path B from it; document the choice.
- `summaryStatus` makes graceful failure auditable: the UI can say "Summary unavailable" honestly instead of pretending. The **diff is always present regardless of `summaryStatus`.**

---

## 5. Selecting the "previous version" (the correctness decision — define precisely)

Negotiations run many rounds; the diff is **always new-vs-immediately-preceding**, never new-vs-original (approach.md Scope Boundary: no arbitrary-version browser). Given the NEW inbound thread row (the one `processInbound` just inserted, `webhooks.ts:306-318`) for `contractId`:

**Rule (recommended):** the "previous version" is **the most recent thread row, before the new inbound row, whose `attachments` array contains a PDF** — i.e. the last version anyone actually exchanged. Query:

```
SELECT id, attachments, email_date, direction
FROM contract_threads
WHERE contract_id = :id
  AND email_date < :newRowEmailDate          -- strictly older than the new inbound row
  AND jsonb_array_length(attachments) > 0    -- carried a document
ORDER BY email_date DESC
LIMIT 1;
```

- If a prior row is found → diff the new PDF against **that row's first PDF attachment** (`attachments[0].storageKey`). This correctly handles: original send (outbound `original.pdf`), our counter with a revised PDF (outbound `reply-{ts}.pdf`, Component 5), and their prior reply with a PDF (inbound `reply-{ts}.pdf`).
- **If no prior PDF version exists** (the very first time a document is exchanged — e.g. the counterparty's first reply when our original send carried the `original.pdf`): diff against the contract's `original.pdf` via `contract.storageKey`. In practice the outbound send row *does* carry the attachment so the query finds it; the `contract.storageKey` fallback is the safety net. If genuinely no prior document exists at all, there is **nothing to diff** — write `ai_analysis = null`, leave status as-is (`replied`), and return (this is the "text-only reply, no document" case, §10/§14c test 3).

**Edge: multiple PDFs on one row.** Use `attachments[0]` (the primary document) on both sides; note in the JSON which keys were used (`fromStorageKey`/`toStorageKey`).

> **Why a query, not "the original":** across 5 rounds, round-5-vs-round-4 is what the human needs to see, not round-5-vs-round-1. Getting this wrong is a named risk (§11).

---

## 6. The pipeline — `backend/src/services/aiAnalysis.ts` (step by step)

Export one async entrypoint, e.g. `runDiffAnalysis({ contractId, ownerUserId, newThreadId, newAttachmentKey })`. It is invoked fire-and-forget from the webhook (§7) and must **never throw out** — every failure mode resolves the contract cleanly.

**6.1 Mark start.** `UPDATE contracts SET status='ai_processing', ai_started_at=now(), updated_at=now() WHERE id=:contractId` (only if current status warrants it — guard against racing a newer event). Then `notifyUser(ownerUserId, { contractId, status: 'ai_processing' })` so the open thread shows a skeleton immediately.

**6.2 Select the previous version** per §5. If none → write `ai_analysis=null`, **revert status to `replied`** (there's nothing to analyze), `notifyUser(...,'replied')`, return.

**6.3 Download both PDFs from GCS.** `const [oldBuf] = await contractsBucket.file(fromStorageKey).download(); const [newBuf] = await contractsBucket.file(toStorageKey).download();` (same API as `contracts.ts:144`).

**6.4 Extract text (`pdf-parse` v2.x).** Parse each Buffer → raw text. Wrap each parse in try/catch; an extraction failure on either side is a hard stop that still resolves cleanly (§6.7, `completed` with empty summary and a diagnostic note — but if extraction fails there's no diff to show, so set `ai_analysis` to a small `{ version:1, summaryStatus:'failed', summary:'', error:'extraction_failed', ... }` and status `completed`; the UI shows "couldn't read the document" rather than a spinner).

**6.5 NORMALIZE (apply to BOTH texts, in this order — these are the mitigations the brief requires before diffing):**
1. **Re-join hyphenated line breaks:** `text.replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2')` (rejoins `agree-\nment` → `agreement`). Run this **before** whitespace collapse (it depends on the `\n`).
2. **Normalize newlines:** `\r\n` and `\r` → `\n`.
3. **Collapse whitespace runs:** `text.replace(/[ \t]+/g, ' ')` (collapse spaces/tabs) and `text.replace(/\n{3,}/g, '\n\n')` (cap blank-line runs), then `text.trim()`.
4. *(Optional, improves prose output)* re-segment into sentences/paragraphs (e.g. split on `. ` heuristically) so the side-by-side view breaks at natural points. Mark optional; `diffWords` already kills reflow noise. Document if applied.

> **Granularity = WORD level, never line level.** Legal paragraphs are long reflowed lines; a one-word edit under `diffLines` marks the whole paragraph changed, and PDF line breaks are unstable. Use **`diffWords`** (whitespace-normalized — best for PDF text). Use `diffWordsWithSpace` only if exact spacing must be preserved (not the default here). Character-level fragments words — avoid.

**6.6 Compute the diff (deterministic, NO LLM):**
- For rendering: keep `oldText`/`newText` for `react-diff-viewer-continued`, OR precompute `diffWords(oldText, newText)` if you render the spans yourself.
- For the LLM input + stats: `const patch = structuredPatch('previous.txt', 'returned.txt', oldText, newText, '', '', { context: 3 })`. Derive `stats.additions`/`deletions`/`changedHunks` from `patch.hunks` (count `+`/`-` prefixed lines / hunk count). For Path B, also produce `createTwoFilesPatch(...)` (unified-diff string) for `diff2html`.

**6.7 Optional single LLM summary over the PATCH (not the documents):**
- If no key is set → `summaryStatus='skipped_no_key'`, `summary=''`, `model=null`. **Skip the call entirely.**
- Else, one call with a **strict prompt** constraining it to the diff only:
  > *System:* "You summarize contract edits for a non-lawyer. You are given ONLY a diff (added/removed text). Summarize ONLY changes present in the diff. Do not infer, invent, or comment on anything not in the diff. Output 1–5 short bullet points in plain English (e.g. 'Payment term changed from 30 to 45 days'). If the diff is trivial or empty, say so."
  > *User:* the `structuredPatch` (or a compact "removed: … / added: …" rendering of its hunks).
- **Timeout + graceful failure:** wrap in a timeout (e.g. 15–20s) and try/catch. Any error/timeout → `summaryStatus='failed'`, `summary=''`, `model=null` — **the diff is still written and shown.** Never block, never spin forever. (Feeding only the patch — a few hundred tokens — is what makes this cheap, fast, and unable to hallucinate changes outside the real edit set.)

**6.8 Write results + transition status.**
- `UPDATE contracts SET ai_analysis=<the §4 JSON>, ai_completed_at=now(), status=<completed|negotiating>, updated_at=now() WHERE id=:contractId`.
- **`completed` vs `negotiating` rule (recommended for v1):** **always set `completed`** when a diff was produced. Reserve `negotiating` for a later heuristic (e.g. "material clause changed") — do not build the heuristic now; it needs a clause classifier this POC doesn't have, and a wrong auto-classification is worse than none. (`negotiating` also remains the state Component 8 sets on a signer *decline*, so leaving it human/decline-driven keeps its meaning crisp.) **Document this choice in the notes;** the JSON `stats` are stored so a heuristic can be added later without re-running diffs.
- `notifyUser(ownerUserId, { contractId, status: '<completed|negotiating>' })`.

**6.9 Idempotency / re-runs.** If the same inbound is reprocessed (Postmark retry is already deduped upstream at `webhooks.ts:75-90`, so this is rare), re-running the analysis is **safe and deterministic** — it overwrites `ai_analysis` with the identical computed diff. No extra ledger needed; note this property.

---

## 7. Trigger wiring — where in `processInbound()` to fire it (`webhooks.ts`)

The stub is already called at the **end** of `processInbound`, after the thread row + status write + `notifyUser('replied')` + `markInboundProcessed` (`webhooks.ts:328-360`). Replace `triggerAiPipeline`'s body:

- **Fire only when:** this was the **matched-reply branch** (`contractId` is set, i.e. NOT a received-contract and NOT the unmatched fallback) **AND** at least one stored attachment is a PDF (`attachmentRecords.length > 0`). The received-contract branch (Component 7) is a *new* document with no previous version to diff, so skip it for v1 (a received contract's first counter-reply *will* diff later, via the normal matched path). Text-only replies (no attachment) → skip (nothing to diff).
- **Fire-and-forget, non-blocking:** `processInbound` already returned 200 to Postmark long before this point; keep the analysis fully async and `.catch`-guarded so a bug never bubbles:
  ```ts
  // inside the replaced triggerAiPipeline, or inline:
  if (contractId && attachmentRecords.some(a => a.contentType.toLowerCase().includes('pdf'))) {
    const owner = /* contracts.userId for contractId, already looked up at :334 */;
    const newPdf = attachmentRecords.find(a => a.contentType.toLowerCase().includes('pdf'))!;
    runDiffAnalysis({ contractId, ownerUserId: owner, newThreadId: threadRow.id, newAttachmentKey: newPdf.storageKey })
      .catch(err => log.error('webhooks', 'AI diff analysis failed', { contractId, error: err?.message }));
  }
  ```
  (Note `triggerAiPipeline` currently only receives `(insertContractId, attachmentRecords)`; extend its signature to also pass `threadRow.id` and the owner id, or move the call inline right after the `notifyUser('replied')` block at `:341` where both are in scope. Recommended: pass them through — keep the single call site.)
- **`notifyUser` calls (two):** `ai_processing` at start (§6.1) and `completed|negotiating` at finish (§6.8). The `'replied'` notify already fired before this (`:333-341`); the sequence the open page sees is `replied → ai_processing → completed`.

---

## 8. Frontend — the AI-analysis block on `contracts/[id].astro`

`GET /api/contracts/:id` already returns the full `contract` row, so `contract.aiAnalysis` (jsonb) and `contract.status` arrive with no API change. Three states to render:

1. **`status === 'ai_processing'`** (and a PDF reply just landed): a **skeleton** card — "Analyzing what changed…" with a spinner placeholder. No infinite spinner risk: the pipeline always transitions to `completed` (or back to `replied`), and the existing SSE script reloads the page on that `status` event (`[id].astro:216-222`), flipping skeleton → populated within ~1–2s.
2. **`contract.aiAnalysis` present** (`status` `completed`/`negotiating`): render the **AI Changes** card:
   - **Plain-English summary** at top. If `summaryStatus !== 'ok'`, show "Plain-English summary unavailable — see the diff below" (honest, per §4). A small **changes badge** from `stats` ("12 additions, 5 deletions").
   - **"View Full Diff"** → the side-by-side viewer (Path A `DiffViewer.tsx` island fed `oldText`/`newText`; Path B `diff2html` HTML from the unified patch in a vanilla script). Word-level green/red, **collapsible unchanged regions**, read-only. Inline view acceptable on narrow/mobile.
   - **"Download Their Version"** → reuse the existing attachment download path: `GET /:id/attachment?key=<toStorageKey>` (the page already wires `.attachment` clicks at `[id].astro:187-202`; the endpoint verifies ownership + key-in-thread, `contracts.ts:380-420`). No new endpoint.
   - **PDF-lossiness honesty (UX):** include a one-line note — "Diff is computed from text extracted from the PDF; formatting and rare wording may differ slightly from the original document." This sets correct expectations and is the honest disclosure the brief requires.
3. **No `aiAnalysis`, ordinary reply:** unchanged thread render (e.g. a text-only reply just shows the message).

**Island vs vanilla decision (recommend Path A):** `react-diff-viewer-continued` gives collapsible unchanged regions + intra-line word highlight for free — ideal for a non-developer reading a long contract. The React runtime is already configured (`astro.config.mjs`), `components/` just doesn't exist yet; create it and mount `<DiffViewer oldText={...} newText={...} client:visible />`, hydrating `oldText`/`newText` from `contract.aiAnalysis` (pass as props from the Astro frontmatter, or fetch `GET /:id` client-side). Path B (diff2html in a vanilla script) stays consistent with the rest of the page and avoids the first hydration — pick it if you want zero new islands. **State which you chose and why in the notes.**

---

## 9. Security & correctness checklist (carry forward from Components 1–8)

- **Ownership-scoped reads only.** `aiAnalysis` rides on `GET /:id`, which already filters `where id AND userId` (`contracts.ts:109-111`). "Download Their Version" uses `GET /:id/attachment`, which enforces ownership **and** key-in-thread (`contracts.ts:389-415`) — do **not** add any "sign an arbitrary key" path.
- **Diff + summary run server-side only.** Extraction, jsdiff, and the LLM call all happen in `aiAnalysis.ts` on the backend. The frontend receives the computed result and renders it.
- **LLM API key never reaches the frontend** (Principle 6). It is read only in `aiAnalysis.ts`, never serialized into any response, never logged. The `notifyUser` payload stays `{userId, contractId, status}` only — no document text, no summary (the frontend refetches the authenticated row).
- **The summary is fed ONLY the computed patch** — never the two full documents and no PII beyond what the diff already contains. This is cheaper, faster, and prevents hallucinated changes.
- **Body/diff rendering stays escaped.** `react-diff-viewer-continued` renders text content as text (no `dangerouslySetInnerHTML` of contract text). For Path B, `diff2html`'s HTML is generated from the diff string — render its output into a container but do **not** additionally inject raw `bodyHtml`. Keep the existing `bodyText`-only policy (Component 4 notes).
- **Never throw out of the pipeline.** A failure must resolve the contract to a terminal UI state (`completed` with diff, or `completed` with an "unreadable" note) — never leave `ai_processing` stuck (infinite spinner). Guarded by the `.catch` at the call site (§7) **and** internal try/catch (§6).

---

## 10. Cross-component BUILD / VERIFY DAG

Each step ends in a checkable done-criterion. Do not advance past a failing step. (Modeled on the Components 5/6/7 plan §5 and Component 8 §11.)

1. **Deps + env** — `npm install diff@9.0.0 pdf-parse@2.4.5` + the LLM SDK (backend); `react-diff-viewer-continued@4.2.2` (frontend, Path A). *Done:* `import { diffWords, structuredPatch, createTwoFilesPatch } from 'diff'` and `import ... from 'pdf-parse'` compile with **no `@types/diff`**; a tiny script extracts text from a sample PDF Buffer.
2. **`aiAnalysis.ts` — extraction + normalize** — `pdf-parse` v2.x + the four normalization transforms (§6.5). *Done:* a script prints normalized text for two sample PDFs; hyphenated breaks rejoined, whitespace collapsed.
3. **`aiAnalysis.ts` — deterministic diff** — `diffWords` + `structuredPatch` + `stats`. *Done:* running the diff twice on the same inputs yields **byte-identical** `patch`/`stats` (proves determinism); a one-word change yields exactly one changed span, not a whole-paragraph change.
4. **Previous-version selection** — the §5 query. *Done:* on a contract with original + 2 reply versions, the pipeline picks **round N-1**, not the original (assert `fromThreadId`/`fromStorageKey`).
5. **Status transitions + write** — `replied → ai_processing → completed`; `ai_analysis` JSON written per §4; `ai_started_at`/`ai_completed_at` set. *Done:* DB shows the §4 JSON, both timestamps, and `status='completed'`.
6. **Trigger wiring** — replace `triggerAiPipeline` body (§7); fire only on matched-reply + PDF; fire-and-forget. *Done:* a seeded inbound PDF reply (over the tunnel) drives the full pipeline without blocking the webhook 200; a text-only reply does **not** trigger it (`ai_analysis` stays null).
7. **ZERO-LLM proof (the headline correctness check)** — **unset both `GEMINI_API_KEY` and `ANTHROPIC_API_KEY`**, send a reply with a modified PDF. *Done:* the full colour-coded word-level diff renders; `summaryStatus='skipped_no_key'`, `summary=''`; status reaches `completed`; **no LLM call was made** (confirm via logs / no SDK network call). This proves detection is LLM-free.
8. **LLM summary path** — with a key set. *Done:* the summary reads plainly and names only changes that are actually in the diff (spot-check against the patch).
9. **LLM-failure path** — set an **invalid** key. *Done:* the diff still renders; `summaryStatus='failed'`, `summary=''`; status reaches `completed`; **no infinite spinner**.
10. **Frontend** — skeleton on `ai_processing`; summary + "View Full Diff" + "Download Their Version" on `completed`; SSE flips skeleton→populated. *Done:* §14c UI states observed live within ~1–2s.
11. **Full real round-trip (gated on Postmark, like 5/6/7)** — a real external reply with a real modified PDF. *Done:* all §14c cases recorded with observed DB `ai_analysis` JSON / GCS keys / UI state and pass/fail in the notes.

---

## 11. Known risks (specific to the diff)

- **PDF extraction is lossy.** PDF is a page-description format with no logical paragraphs — extractors emit spurious line breaks, split hyphenated words, reflow paragraphs when one word shifts wrapping, and jumble multi-column/table layouts. Word-level diff + normalization (§6.5) keep prose **approximately correct and readable**, but they do **not** eliminate roughness on heavily reflowed or multi-column/table PDFs. This is honestly disclosed in the UX (§8) and must be recorded candidly in the notes (§14c test 6). Escalation: `pdfjs-dist` for reading order; `mammoth` for a DOCX branch (deferred, §12).
- **LLM latency / cost / failure.** The summary call adds seconds and a few-hundred-token cost. Mitigated: async (never blocks the webhook 200 or the page), timeout-guarded, and **graceful** — diff always renders without it (§6.7). The diff is free and instant.
- **Very large documents.** A long contract → large extracted text → larger `oldText`/`newText` stored in `ai_analysis` and a bigger render. Mitigation: store `patch` and lazy-load via an optional `GET /:id/diff` if the inline JSON gets heavy (§2); cap stored text length defensively and note truncation. jsdiff handles large inputs but is O(ND) — extreme inputs could be slow; acceptable for contract-sized prose.
- **Non-PDF attachments.** Only PDFs are diffed; non-PDF attachments are already dropped upstream (`webhooks.ts:181-191`). DOCX is a cleaner future branch (`mammoth`, real paragraph structure) — **deferred** (§12).
- **"Previous version" selection across many rounds.** Picking the wrong prior version produces a confusing diff. §5's "most recent prior row with a PDF" rule is the guard; test it explicitly on a 3+ round contract (§10 step 4, §14c test 8).
- **Scanned/image PDFs have no extractable text.** Extraction returns empty/garbage; the pipeline resolves `completed` with an "unreadable document" note (§6.4) rather than a fake diff. OCR is out of scope (§12).

---

## 12. What NOT to build in this component

- **Monaco `DiffEditor`** (`@monaco-editor/react`). It is the literal VS Code diff component but is far too heavy (full editor engine, web workers, editable) for read-only prose. "Like VS Code" here means the **visual** experience (green/red side-by-side), delivered by `react-diff-viewer-continued`. Do not pull Monaco in.
- **Using an LLM for change detection.** Detection is the deterministic Myers diff, period. The LLM only summarizes the computed patch.
- **A "compare any two arbitrary versions" browser.** Always **new-vs-previous** (§5). The version-history browser is explicitly out of POC scope (approach.md Scope Boundary).
- **OCR for scanned/image PDFs.** Out of scope; resolve cleanly with an "unreadable" note instead.
- **The DOCX branch (`mammoth`).** Cleaner extraction with real paragraph structure, but **deferred** — note it as the next upgrade if a party ever returns a DOCX.
- **The `completed` vs `negotiating` clause-classification heuristic.** v1 is `completed`-always; `negotiating` stays human/decline-driven (§6.8). Building an auto-classifier now risks wrong calls; the stored `stats` let it be added later.
- **A new schema migration.** The columns/enum values already exist (§2) — do not regenerate the schema for this component.

---

## 13. Reference — files & endpoints after this component lands

```
backend/src/
  services/aiAnalysis.ts   NEW  pdf-parse v2.x extract + normalize + jsdiff diffWords/structuredPatch
                                + optional single LLM summary over the patch; writes ai_analysis + transitions status
  routes/webhooks.ts       EDIT replace triggerAiPipeline body (:373-382) → fire runDiffAnalysis async
                                on matched-reply + PDF; notifyUser ai_processing → completed
  db/schema.ts             (UNCHANGED columns/enums; OPTIONAL: add ContractAiAnalysis TS type only)
  routes/contracts.ts      (UNCHANGED; aiAnalysis rides on GET /:id; download via existing /:id/attachment)
  lib/events.ts            (UNCHANGED, reused: notifyUser)
  lib/storage.ts           (UNCHANGED, reused: contractsBucket.file(key).download())

frontend/src/
  components/              NEW DIR (first React island in the project)
    DiffViewer.tsx         NEW (Path A) react-diff-viewer-continued side-by-side, word-level, collapsible
    ReplyViewer.tsx        NEW (optional) summary + View Full Diff + Download Their Version
  pages/contracts/[id].astro EDIT  ai_processing skeleton; AI Changes card (summary + diff + download); SSE flips it live

New env var: GEMINI_API_KEY  OR  ANTHROPIC_API_KEY  (summary only; the diff needs no key)
New endpoint: (none required; OPTIONAL GET /api/contracts/:id/diff to lazy-load the patch)
```

---

## 14. Instructions to the implementer — write `implementation-notes.md`

When you finish, write `implementation-notes.md` **in this folder** (`plans/component-09-ai-diff/`), modeled on `plans/component-04-inbound/implementation-notes.md`. It is the *as-built* record — what actually shipped, not what was intended. **The bar for "done" is a real end-to-end run with real PDFs you can SEE — never mock/synthesized data.** The notes MUST contain these sections:

**(a) Full as-built CODE WALKTHROUGH.** A files-touched table (path → what changed → why), then the actual flow that shipped, per piece: the `triggerAiPipeline` replacement in `webhooks.ts` (the exact fire condition + fire-and-forget guard); `aiAnalysis.ts` step by step (previous-version selection query as written, the exact normalization regexes used, the `diffWords`/`structuredPatch` calls, the LLM prompt actually sent and the timeout value, the status transitions, and the exact `ai_analysis` JSON written — paste a real example blob); the frontend AI-Changes card + diff viewer. Call out **every decision this plan left to you and which you chose and why:** Path A React island vs Path B diff2html (§1.2/§8); storing both `oldText`/`newText` + `patch` vs patch-only (§4); `completed`-always vs a `negotiating` heuristic (§6.8); whether you added the optional `GET /:id/diff` lazy-load (§2); whether you re-segmented into sentences (§6.5 step 4); any extractor escalation to `pdfjs-dist` (§1.1).

**(b) Detailed SETUP GUIDE — run it from scratch.** Everything a teammate needs: the LLM env var (`GEMINI_API_KEY` **or** `ANTHROPIC_API_KEY`) and **the explicit statement that the diff runs with NO key** (and how to run key-less to prove it); `npm install` lines for **both** backend (`diff@9.0.0 pdf-parse@2.4.5` + the chosen LLM SDK, and that `@types/diff` must NOT be installed) and frontend (`react-diff-viewer-continued@4.2.2` if Path A); **wiring `@astrojs/react`** — note it is **already configured** (`astro.config.mjs` `react()`), so the only new step is creating `frontend/src/components/` and mounting the island (`client:visible`); `npm run dev` for both servers; and **how to seed two real PDF versions to diff** — the realistic path: send a contract (Component 3), then reply from an external mailbox with a genuinely edited PDF (Component 4/5), over the `cloudflared tunnel` (cross-ref Component 4 plan §2.5); plus a faster local-dev path if Postmark is still blocked (place two PDFs in GCS under `contracts/{u}/{c}/` and invoke `runDiffAnalysis` directly from a script).

**(c) Detailed END-TO-END PHYSICAL TEST CASES — REAL, not synthesized.** Actually perform and record each, with **real PDFs** (real reply round-trips once Postmark clears; if still blocked, run the direct-invoke path with real PDF files and mark the Postmark-gated assertions 🟡). For EACH: the exact steps, the observed **DB `ai_analysis` JSON** (paste it), the **GCS objects** used (`fromStorageKey`/`toStorageKey`), the **UI state**, and **pass/fail**:
  1. **Real modified-PDF reply → correct word-level diff** — a genuinely edited contract; confirm additions/deletions are highlighted at the right words and the side-by-side renders.
  2. **TRIVIAL one-word change** — change exactly one word; **prove only that word highlights, not the whole paragraph/line** (the word-vs-line-level proof — the core correctness claim).
  3. **Text-only reply, NO document change** — reply with a message and no attachment; confirm **no diff** is produced (`ai_analysis` null / pipeline skipped), status stays `replied`, no skeleton stuck.
  4. **LLM-OFF run (both keys unset)** — prove the **full colour-coded diff still renders** with `summaryStatus='skipped_no_key'` and an empty summary, status `completed` (the "no-LLM detection" proof). Confirm via logs that **no LLM call was made**.
  5. **LLM-FAILURE path (invalid key)** — the diff still renders; `summaryStatus='failed'`, empty summary; status reaches `completed`; **no infinite spinner**.
  6. **Heavily-reflowed / multi-column PDF** — feed a real reflowed or multi-column/table PDF and **honestly record how rough the extracted-text diff looks** (screenshots; note spurious breaks/jumbling). This is a candor test, not a pass/fail of correctness.
  7. **Live transition** — confirm `status` flips `replied → ai_processing → completed` and the thread updates **within ~1–2s via SSE** (skeleton → populated), no manual refresh.
  8. **Multi-round (new-vs-previous, not new-vs-original)** — on a contract with original + ≥2 reply versions, confirm the diff is **round N vs round N-1** (assert `fromThreadId`/`fromStorageKey` point at the immediately preceding version).

**(d) VERIFICATION MATRIX.** A table mapping each done-criterion (§10 steps 1–11 and each §14c case) to what you ran and the result (✓ / 🟡 blocked / ✗), like Component 4 notes §6. State plainly that the "done" bar is a real run with real PDFs you can see; if anything is Postmark-gated, leave the exact commands/steps ready to run and say what remains.

**(e) Operational knobs / extension points** — LLM timeout value + which model; how to swap providers behind the `aiAnalysis.ts` adapter; the extractor escalation path (`pdfjs-dist`) and the deferred DOCX branch (`mammoth`); where a future `completed`/`negotiating` clause heuristic would read `stats`; and how this diff result feeds the human's hand-off into Component 8's `send-for-signature` (the "accept-and-sign vs counter" decision).
