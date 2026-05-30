# Plan 08 — AI Diff & Version History Panel

## Purpose

Surface the AI diff pipeline — which is already fully implemented and working — in a clear, useful way in the contract detail page UI. Currently, when a counterparty sends a revised PDF, the backend runs the diff, stores it in the database, and that's where it ends. There is no UI for the user to view the changes or the AI summary. This plan describes where and how to present that information, and defines a Version History panel so the user can navigate between contract versions.

---

## What Already Works (Do Not Change)

This is critical context: the AI diff pipeline is complete and correct. Do not modify `aiAnalysis.ts` or `DiffViewer.tsx`.

**`backend/src/services/aiAnalysis.ts`**:
- `runDiffAnalysis()` fires when a matched inbound email contains a PDF attachment and the contract already has a previous PDF version
- It extracts text from both PDFs using `pdf-parse`, runs a Myers diff using `jsdiff`, and generates a human-readable summary using Gemini Flash
- Stores the result in a `contract_diffs` (or equivalent) table with: `version`, `fromThreadId`, `toThreadId`, `fromStorageKey`, `toStorageKey`, `oldText`, `newText`, `patch`, `stats` (additions/deletions/unchanged line counts), `summary`, `summaryStatus`, `model`, `extractor`, `diffEngine`, `generatedAt`
- Status transitions during analysis: `replied → ai_processing → completed` (or back to `replied` if no previous version exists to diff against)

**`frontend/src/components/DiffViewer.tsx`**:
- React island (client-side component in Astro)
- Wraps `react-diff-viewer-continued` v4.2.2
- Uses `DiffMethod.WORDS` — word-level diff, not line-level (correct for legal text)
- Side-by-side view, collapsible unchanged regions
- Custom colors: additions green (`#acf2bd`), deletions red (`#fdb8c0`)
- Props: `oldText: string`, `newText: string`
- Works correctly; keep as-is

---

## What Needs to Be Built

1. **Fetching diff data in the contract page**: the `GET /api/contracts/:id` endpoint (after Plan 07's consolidation) returns a `latestDiff` field. The contract page's Astro frontmatter receives this and passes it to the `DiffViewer` component.

2. **Version History panel**: a collapsible list of past diffs, so the user can see not just the latest revision but the entire negotiation history.

3. **AI Summary callout**: above the diff viewer, show the AI-generated summary text in a highlighted card so the user can understand the changes at a glance before diving into the diff.

4. **Stats bar**: show the numeric diff stats (additions, deletions, unchanged) in a compact horizontal bar, like GitHub's `+15 -7` changed lines indicator.

---

## UI Placement

This content goes in the **left column** of the contract detail page (Plan 03's two-column layout), beneath the document metadata card. It appears only when at least one diff record exists.

### AI Summary Callout Card

Appears at the top of the diff section. Card with:
- A small "AI" label badge (use the brand gradient on the badge icon — one of the few correct uses of the gradient)
- Heading: "What changed in this version"
- Body: `latestDiff.summary` text — this is the Gemini Flash-generated summary
- If `latestDiff.summaryStatus === 'pending'` or `'failed'`: show "Summary unavailable for this version"
- Style: `var(--color-border-light)` (`#F2E7FE`) background, `var(--color-border-mid)` border — matches the "highlight" card style from the Genie brand

### Stats Bar

A horizontal row immediately below the summary callout:
```
[+{additions} added]  [-{deletions} removed]  [{unchanged} unchanged]
```
Each segment is a small pill badge. Additions: green pill. Deletions: red pill. Unchanged: muted grey.

Values come from `latestDiff.stats.additions`, `latestDiff.stats.deletions`, `latestDiff.stats.unchanged`.

### DiffViewer Component

The `DiffViewer` React island is rendered below the stats bar. Pass `oldText` and `newText` from `latestDiff`:
- `oldText = latestDiff.oldText` — the extracted text of the previous contract version
- `newText = latestDiff.newText` — the extracted text of the new contract version

In Astro, React islands are mounted with `client:load` directive:
```astro
<DiffViewer client:load oldText={latestDiff.oldText} newText={latestDiff.newText} />
```

The `DiffViewer` is large and JavaScript-heavy. Use `client:visible` instead of `client:load` so it only hydrates when scrolled into view — this improves initial page load time.

### Version History Panel

A collapsible `<details>` element (native HTML — no JavaScript needed for expand/collapse) below the diff viewer:
- Summary: "Version history ({count} versions)"
- When expanded: a vertical list of all past diffs for this contract, ordered from latest to oldest
- Each row: version number, date of the diff, number of additions/deletions, a "View" link

The "View" link points to a URL like `/contracts/{id}?version={versionNumber}` — or, simpler for a POC, clicking a version row replaces the current `DiffViewer` props via client-side JavaScript.

**For the POC, a simpler approach works**: load all diffs as JSON in a `<script>` tag (using Astro's `define:vars`), and let a client-side event handler swap the `oldText`/`newText` props when the user selects a version. Since `DiffViewer` is a React island, update it by passing new props through a shared event or by using a wrapper component that holds state.

**Simplest POC implementation**: make the version history rows buttons. On click, `window.location.href = /contracts/${id}?version=${n}` where the Astro SSR reads the `?version` query param, fetches the appropriate diff record, and passes it to `DiffViewer`. No client-side state needed — it's just navigation.

---

## Backend: `GET /api/contracts/:id` Response Shape

After Plan 07's query consolidation, the response must include `latestDiff`. Add to the main query:

```sql
LEFT JOIN LATERAL (
  SELECT * FROM contract_diffs
  WHERE contract_id = c.id
  ORDER BY created_at DESC
  LIMIT 1
) ld ON true
```

Include `ld.*` in the SELECT as `latestDiff` (JSON object).

Also add an endpoint to fetch all diffs for version history: `GET /api/contracts/:id/diffs` — returns an array of all diff records for that contract, ordered newest-first. Only needs: `id`, `version`, `generatedAt`, `stats`, `summary`, `summaryStatus`. Does NOT need `oldText`/`newText` (those are large strings — only fetch them for the selected version to avoid sending megabytes in the list response).

Then, for the version selection flow (`?version=n` query param): the Astro SSR fetches `/api/contracts/:id/diffs/{version}` which returns the full diff record including `oldText` and `newText`.

---

## AI Processing State

When `contract.status === 'ai_processing'`, the diff is being generated. Show in the left column:
- A subtle spinner or animated progress bar (CSS animation, no JavaScript)
- Text: "Analysing changes…" in `var(--color-text-muted)`
- The spinner uses `var(--color-accent)` for the active arc
- The stats bar and diff viewer are replaced by a skeleton placeholder (two grey blocks of approximate height)

The SSE handler triggers a page reload (or targeted update) when `ai_processing → completed` — at that point the skeleton is replaced with real content.

---

## Pipeline B — What It Is (And Why It Doesn't Exist Yet)

**Pipeline B** is the scenario where a counterparty sends a _text-based reply_ (not a revised PDF) with instructions like "Change clause 4.2 to say 30 days instead of 14 days." Pipeline B would: extract the change instructions from the email body, use an LLM to apply those changes to the original contract text, generate a revised PDF, and present the diff.

Pipeline B does **not exist** in the current codebase. The `triggerAiPipeline` function stub in `aiAnalysis.ts` has only a log statement — no implementation. **Do not implement Pipeline B in this redesign.** It is scope-out. However, the Version History panel UI and the DiffViewer component are forward-compatible with Pipeline B — if Pipeline B is added later, it produces a `contract_diffs` record and the same UI displays it.

---

## Files to Modify

| File | Changes |
|---|---|
| `frontend/src/pages/contracts/[id].astro` | Add AI summary callout, stats bar, DiffViewer slot (use `client:visible`), version history `<details>` panel, `ai_processing` skeleton state |
| `backend/src/routes/contracts.ts` | `GET /:id`: include `latestDiff` via LATERAL join; add `GET /:id/diffs` and `GET /:id/diffs/:version` endpoints |

## Files to Reference

| File | Why |
|---|---|
| `frontend/src/components/DiffViewer.tsx` | Prop types: `{ oldText: string, newText: string }` |
| `backend/src/services/aiAnalysis.ts` | What fields are stored in the diff record — use same field names in the API response |
| `approach.md` §6 (AI Analysis) | Spec for the diff pipeline; confirms Pipeline A scope and Pipeline B non-scope |
