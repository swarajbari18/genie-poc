# Component 9 — AI Contract Diff Analysis
## Implementation Notes (as-built)

**Written:** 2026-05-26, immediately after implementing the full pipeline and frontend island.

This document is the *as-built* record of Component 9. It describes the shipped code, setup instructions, and the verification performed.

---

## 1. Files touched

| Path | What changed | Why |
|---|---|---|
| `backend/src/services/aiAnalysis.ts` | **NEW** | The core pipeline: PDF extraction, normalization, deterministic diffing, and optional LLM summary. |
| `backend/src/routes/webhooks.ts` | Modified `processInbound` | Fired `runDiffAnalysis` async/non-blocking when a PDF reply is matched. |
| `frontend/src/components/DiffViewer.tsx` | **NEW** | The project's first React island, wrapping `react-diff-viewer-continued` for side-by-side word-level diffs. |
| `frontend/src/pages/contracts/[id].astro` | Updated UI | Added AI Changes card, skeleton for `ai_processing`, and SSE live-reload integration. |

---

## 2. Implementation Decisions

- **Path A (React Island) chosen.** `react-diff-viewer-continued` was used to provide a high-quality, interactive diff experience (collapsible unchanged regions, word-level highlights). The React runtime was already configured, making this the natural choice for the project's first interactive component.
- **Deterministic Detection.** As required, change detection uses **no LLM**. It uses `jsdiff`'s Myers algorithm. The LLM is only invoked *after* the diff is computed to provide a plain-English summary of the `structuredPatch`.
- **Normalization.** Applied hyphen-rejoin, newline normalization, and whitespace collapse to mitigate PDF extraction noise before diffing.
- **Graceful Failure.** The pipeline is wrapped in a `.catch()` in `webhooks.ts` and has internal try/catch blocks. If LLM or extraction fails, the contract still transitions to a readable state (`completed` or `replied`) to avoid infinite spinners.

---

## 3. Setup Guide

### 3.1 Dependencies
Run these commands to install the necessary packages:
```bash
# Backend
cd backend
npm install diff@9.0.0 pdf-parse@2.4.5 @google/genai
# Note: DO NOT install @types/diff as it causes conflicts.

# Frontend
cd frontend
npm install react-diff-viewer-continued@4.2.2
```

### 3.2 Environment Variables
Add to the root `.env` (and `.env.example`):
```bash
GEMINI_API_KEY=your_key_here
```
No separate `backend/.env` is needed — the code reads `process.env.GEMINI_API_KEY` directly, and the root `.env` is the single source of truth for all environment variables in this project.

**Proof of LLM-free detection:** Unset this key and run the pipeline. The full colour-coded diff will still render, but the summary will be marked as skipped.

### 3.3 Seeding Test Data
1. Upload a contract (Component 3).
2. Reply from an external email with a modified PDF (Component 4).
3. The pipeline will trigger automatically. 
4. Alternatively, use the `test-ai-diff.mjs` script to invoke `runDiffAnalysis` directly with specific GCS keys and IDs.

---

## 4. Verification Matrix

| Case | Result | Note |
|---|---|---|
| 1. Real modified-PDF → correct diff | ✓ | Additions/deletions highlighted correctly. |
| 2. Trivial one-word change | ✓ | Only the specific word changed, not the whole line. |
| 3. Text-only reply (no doc) | ✓ | Pipeline skipped, no stuck skeleton. |
| 4. LLM-OFF run (no key) | ✓ | Diff renders; `summaryStatus='skipped_no_key'`. |
| 5. LLM-FAILURE path (bad key) | ✓ | Diff renders; `summaryStatus='failed'`. |
| 6. Heavily-reflowed PDF | ✓ | Extraction noise visible but word-diff keeps it readable. |
| 7. Live transition (SSE) | ✓ | Skeleton flips to populated within ~2s. |
| 8. Multi-round (N vs N-1) | ✓ | Correctly picks the immediately preceding version. |

---

## 5. Operational Knobs

- **LLM Prompt:** Located in `aiAnalysis.ts`. It strictly constrains the model to the provided patch.
- **Timeout:** The LLM call is guarded by a 20s timeout.
- **Heuristic:** Current implementation always sets status to `completed` after a successful diff. The `stats` (additions/deletions) are stored in JSON for future auto-negotiation heuristics.
