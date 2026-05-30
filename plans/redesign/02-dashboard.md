# Plan 02 — Dashboard Redesign

## Purpose

Redesign `frontend/src/pages/dashboard.astro` and fix the underlying backend query in `backend/src/routes/contracts.ts` so the dashboard accurately shows the user's contract pipeline, surfaces contracts awaiting their signature (including those owned by other Genie users), and updates live via SSE without full-page reloads.

---

## Current Problems

### Visual
- All elements use `#2563eb` blue — completely off-brand
- "Your Contract Address" is the first thing on screen on every visit, burying the actual work
- Contract tiles: only the title `<a>` is clickable, not the whole row
- Status values are raw database enum strings (`out_for_signature`, `ai_processing`) — unreadable
- The "Awaiting your signature" card uses hardcoded inline blue and light-blue background
- Group headers (`Needs Attention`, `In Flight`, `Closed`) are correct conceptually but styled as faint uppercase grey text — they need more visual weight

### Logic / Backend
- The dashboard query (`contracts.ts` line 71: `WHERE c.user_id = ${user.id}`) only returns contracts the logged-in user _owns_. The `awaitingMySignature` subquery checks `cs.genie_user_id = ${user.id}` but within that WHERE clause — so it only ever finds signers on the user's _own_ contracts. If User B uploads a contract and adds User A as a signer, User A's dashboard _never_ shows it. This is the Genie-to-Genie signing bug.
- The SSE handler in `dashboard.astro` calls `window.location.reload()` on _any_ status event, causing a full white-flash reload even when a background AI processing job completes.

---

## Backend Fix: Dashboard Query

**File**: `backend/src/routes/contracts.ts`, the `GET /` handler (currently lines 37–76)

The fix uses a SQL UNION to merge two result sets:
1. Contracts the user _owns_ (`c.user_id = user.id`) — the current query
2. Contracts where the user is a _signer_ (`cs.genie_user_id = user.id`) — new, currently missing

Both sides of the UNION compute the same columns: `id`, `title`, `status`, `origin`, `sort_group`, `awaitingMySignature`, etc. For side 2, `awaitingMySignature` is always `true` (because the only reason side 2 shows is that the user is a signer on it).

Use Drizzle's `sql` template literal to write this as a raw SQL query (same pattern as the current query — raw SQL is already used here). The UNION result should still be ordered by `sort_group ASC, updated_at DESC`.

Add a `DISTINCT ON (c.id)` or `UNION` (not `UNION ALL`) to prevent duplicates if, for some reason, a user both owns and is a signer of the same contract.

The shape of each row returned stays identical — the frontend does not need to change its template logic, only the backend query expands.

---

## Frontend Redesign: Layout

### Header (from AppLayout — Plan 01)
The shared `AppLayout.astro` provides the header. The dashboard page does not duplicate it.

### Page structure

Replace the current single-column layout with:

```
[Header — from AppLayout]

[Awaiting Your Signature — conditional, only if awaitingMySignature contracts exist]

[Pipeline section]
  [h2: "Contracts"]  [button: "New Contract" → /upload]

  [Group: Needs Attention]  ← sort_group = 1
    [ContractTile]
    [ContractTile]

  [Group: In Flight]        ← sort_group = 2
    [ContractTile]

  [Group: Closed]           ← sort_group = 3
    [ContractTile]

  [Empty state — if no contracts at all]

[Contract Address — collapsed at bottom]
```

The "Your Contract Address" section moves to the bottom of the page. Most users check it once and never need to see it again. It should still exist for discoverability but should not be the visual landing point on every visit.

---

## Frontend Redesign: Components

### Contract Tile

The tile is a `<li>` inside the group card. The entire `<li>` must be clickable — not just the title text. Use `<a href="/contracts/{id}">` wrapping the entire tile content, or use JavaScript to make the `<li>` navigate on click. The cleanest approach is to make the `<li>` itself a relative container and put an absolutely-positioned `<a>` stretched to fill it (`position: absolute; inset: 0`), which keeps accessibility correct while making the whole row clickable.

Tile layout (horizontal): 
- Left: contract title (weight 600, `var(--color-text-primary)`), then recipient email below in muted text (0.8rem, `var(--color-text-muted)`)
- Right: status badge

"RECEIVED" label: keep the `#FEF9C3` / `#854d0e` warning badge for contracts where `origin === 'received'`. This is a useful signal, not clutter.

### Status Badge

Map raw DB status strings to human-readable labels before displaying. This mapping happens in the Astro template (TypeScript, server-side render — no client JS needed).

| DB status | Display label | Badge style |
|---|---|---|
| `draft` | Draft | muted |
| `sent` | Sent | muted |
| `ai_processing` | Reviewing… | active (purple) |
| `received` | Received | warning |
| `replied` | Replied | active |
| `negotiating` | Negotiating | active |
| `out_for_signature` | Signing | active |
| `partially_signed` | Partially Signed | active |
| `completed` | Executed | muted (green tint) |
| `signed` | Signed | muted (green tint) |
| `declined` | Declined | muted (red tint) |

Define a `statusLabel` and `statusVariant` helper function at the top of the Astro frontmatter (TypeScript). Returns `{ label: string, variant: string }`. Reference it in the template.

### Group Headers

The group header `h3` elements should use:
- Font: 0.8rem, weight 600, `var(--color-text-muted)`, uppercase, letter-spacing 0.08em
- A thin `1px` line separator above each group (except the first) using `border-top: 1px solid var(--color-border-default)` with `padding-top: 1.5rem` on the group container

### Awaiting Signature Card

This card appears at the top of the page content _only_ when `contracts.some(c => c.awaitingMySignature)` is true. Replace the hardcoded inline blue with `border-left: 4px solid var(--color-accent)` and `background: var(--color-border-light)` (`#F2E7FE`). The "Sign Now" button uses `.btn-primary`.

The "Sign Now" button click handler fetches `/api/contracts/${contractId}/sign-url` and redirects. This endpoint currently calls `getEmbeddedSignUrl` — after Plan 07's backend fix, this endpoint will be removed or repurposed (see Plan 05). For now, keep the button working with whatever the backend returns. Plan 05 resolves the signing ceremony entirely.

---

## Frontend Redesign: SSE Targeted Update

**File**: `dashboard.astro`, the second `<script define:vars={{ apiUrl }}>` block (Component 6 — Live Sync)

**Current behavior**: `window.location.reload()` on any `status` event.

**New behavior**: On receiving a `status` SSE event, do NOT reload the whole page. Instead, parse the event data (the backend sends a JSON object with at least `contractId` and `newStatus`) and update the affected tile in place.

The targeted update strategy:
1. The event data from the backend includes `contractId` and `newStatus`
2. Find the `<li>` element for that contract (add a `data-contract-id` attribute to each tile during SSR)
3. Find the `.badge` element inside that tile and update its text content and class to match the new status
4. If `newStatus` changes the sort group (e.g., `ai_processing → completed` moves from group 2 to group 3), a targeted in-place update is insufficient — fall back to a full reload only in this case

The status-to-sort-group mapping:
- Group 1: `received`, `replied`, `negotiating`, `partially_signed`
- Group 2: `draft`, `sent`, `ai_processing`, `out_for_signature`
- Group 3: `completed`, `signed`, `declined`

Implement `getSortGroup(status)` as a pure function at the top of the script block. When the SSE event arrives: compute the old sort group from the current DOM state, compute the new sort group from `newStatus`, if they differ → `window.location.reload()`, otherwise → update badge text and class in place.

This eliminates the white-flash reload for the most common SSE event: the AI processing update (`ai_processing → completed`) which happens within the same sort group (both are group 2).

---

## Files to Modify

| File | Changes |
|---|---|
| `backend/src/routes/contracts.ts` (lines 37–76) | UNION query to include signer contracts |
| `frontend/src/pages/dashboard.astro` | Full layout and logic update as described |

## Files to Reference

| File | Why |
|---|---|
| `frontend/src/layouts/AppLayout.astro` | Import for shared header/shell (created in Plan 01) |
| `frontend/src/styles/global.css` | Token variables and primitive classes (created in Plan 01) |
| `backend/src/routes/events.ts` | Understand SSE event shape — what fields are in the JSON payload |
