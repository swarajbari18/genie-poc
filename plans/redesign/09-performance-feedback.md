# Plan 09 — Performance & User Feedback

## Purpose

This plan is applied last — it refines all the pages built in Plans 02–05 to feel fast and responsive. Currently the app has no loading states (button clicks are silent until a redirect happens), full-page reloads on every live update, and no error recovery patterns outside `alert()`. A production-grade app communicates every state transition to the user.

---

## Why This Is Last

The other plans establish the correct content and flow. Performance and feedback patterns are layered on top — they don't change what the app does, they change how it feels. Implementing them first would mean refactoring skeleton states around a layout that hasn't been finalised yet.

---

## Problem Inventory

| Problem | Location | Current behaviour | Target behaviour |
|---|---|---|---|
| Full-page reload on SSE | Dashboard, contract page | `window.location.reload()` | Targeted DOM update (see Plans 02, 03) |
| No loading state on form submit | Upload, send-for-review, send-for-signature | Button text changes; then blank white page | Button shows spinner; skeleton renders during fetch |
| No loading state on navigation | All pages | Instant white flash → new page | Page shows "Loading…" or skeleton before content arrives |
| `alert()` for errors | All pages | Browser native alert dialog | Inline error banner below the failed action |
| No visual indication when AI is processing | Contract page | Status badge changes; nothing else | Animated "Analysing changes…" state in left column |
| Thread column scroll | Contract page | No auto-scroll | Scrolls to newest message on load and on new SSE message |
| Upload page missing viewport meta | `upload.astro` | Unusable on mobile | Add `<meta name="viewport" content="width=device-width, initial-scale=1.0">` |
| Three DB queries on contract page | Backend | 3 round-trips to Neon | 1 consolidated query (Plan 07) — but the frontend should also show a skeleton while waiting |
| Sign token page has no loading state | `sign/[token].astro` | Blank white then redirect | "Preparing your signing page…" spinner |

---

## Skeleton Loading States

A skeleton is a grey block that mimics the shape of the content being loaded. It uses a CSS animation to suggest activity. The skeleton prevents the jarring "nothing → everything" flash.

**Implementation pattern**: Use a CSS animation class `.skeleton` defined in `global.css`:
```css
.skeleton {
  background: linear-gradient(90deg, #F3F4F6 25%, #E5E7EB 50%, #F3F4F6 75%);
  background-size: 200% 100%;
  animation: skeleton-sweep 1.5s infinite;
  border-radius: var(--radius-input);
}
@keyframes skeleton-sweep {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

**Where to use skeletons**:

1. **Contract detail page — initial load**: while the SSR is running (on the server), the page layout is already rendered by Astro. No skeleton needed here — Astro is SSR, the HTML arrives with data. BUT if the `client:visible` DiffViewer has not yet hydrated, show a skeleton placeholder of approximate height (300px) until it loads.

2. **AI processing state**: when `contract.status === 'ai_processing'`, show two skeleton blocks in the left column where the diff summary and DiffViewer would be. Height: approximately 60px for the summary card and 300px for the diff viewer area.

3. **Sign token page**: while the redirect is being prepared, show a centred spinner with "Preparing your signing page, please wait…" text instead of a blank white page.

---

## Spinner Component

A pure CSS spinner (no JavaScript, no library) in `global.css`:
```css
.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-border-mid);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
```

Use within button labels: `<button class="btn-primary" disabled><span class="spinner"></span> Sending…</button>`

---

## Inline Error Banners (Replace `alert()`)

Every `alert('...')` call in every page must be replaced with an inline error message rendered in the DOM.

**Pattern**: Each form should have an `<div class="error-banner" id="form-error" style="display:none"></div>` element positioned below the form. On error: set `.textContent` and `.style.display = 'block'`. On retry: hide it again.

**CSS class `.error-banner`** (add to `global.css`):
```css
.error-banner {
  background: #FEF2F2;
  border: 1px solid #FECACA;
  color: #B91C1C;
  padding: 0.75rem 1rem;
  border-radius: var(--radius-input);
  font-size: 0.875rem;
  margin-top: 0.75rem;
}
```

**Pages with `alert()` calls to fix**:
- `upload.astro`: `alert('Upload failed: ${err.error}')` and `alert('Network error during upload')` — replace with `#upload-error` div
- `contracts/[id].astro`: multiple alert calls in the send/reply/signature handlers
- `dashboard.astro`: `alert('Failed to load signing page...')` in Sign Now handler

---

## Optimistic UI for Reply Submission

When the user clicks "Send Reply" on the thread reply composer, do not wait for the backend response before updating the thread. Instead:
1. Immediately append a new thread entry to the DOM with: direction `outbound`, from "You", the typed message body, and a subtle "Sending…" indicator
2. Remove the composer text (clear the textarea)
3. Disable the submit button
4. When the API call resolves:
   - On success: remove the "Sending…" indicator from the optimistic entry. The SSE event from the backend will eventually confirm the entry, but the optimistic update is already there.
   - On failure: remove the optimistic entry, re-populate the textarea with the original text, re-enable the button, show an error banner

This makes the reply feel instant — no waiting for the network round-trip.

---

## Thread Column Auto-Scroll

The thread column in the contract detail page has `overflow-y: auto`. On page load, scroll it to the bottom (newest message). On receiving an SSE event that adds a new message, scroll to the bottom again.

In the page's `<script>` block:
```javascript
const threadCol = document.getElementById('thread-column');
if (threadCol) {
  threadCol.scrollTop = threadCol.scrollHeight;
}
```

Call this on initial load and whenever a new message is appended (either from SSE or from the optimistic reply).

---

## Page Transition Feedback

Astro's built-in View Transitions API can provide smooth page transitions. However, enabling this is optional for a POC — the simpler approach is:

When a user clicks a navigation link (e.g., "Back to Dashboard", "Open contract"), add a client-side `beforeunload`-style dim: set the body to 50% opacity on click, then the new page loads. This is achievable with:
```javascript
document.querySelectorAll('a[href]').forEach(a => {
  a.addEventListener('click', () => document.body.style.opacity = '0.5');
});
```

Do not pursue View Transitions unless the user explicitly requests it — it adds complexity.

---

## The Missing `<meta name="viewport">` on Upload Page

**File**: `frontend/src/pages/upload.astro`

Add `<meta name="viewport" content="width=device-width, initial-scale=1.0">` to the `<head>`. After Plan 01's `AppLayout` is applied, this will be in the layout's `<head>` block and will apply to all pages automatically. The only reason to call it out explicitly here is that it is currently missing only from `upload.astro` — the other pages already have it.

---

## SSE: When to Reload vs. When to Update in Place

This policy applies to both the dashboard and the contract detail page. Defined here as a single reference:

| SSE event + status change | Action |
|---|---|
| Sort group stays the same (e.g., `ai_processing → completed`, both group 2) on dashboard | Update badge text/class in place |
| Sort group changes (e.g., `replied → out_for_signature`, group 1 → 2) on dashboard | `window.location.reload()` |
| Stage stays the same on contract page | Update stage indicator and badge in place |
| Stage changes on contract page | `window.location.reload()` |
| A new thread entry arrives (inbound email SSE event) | Append new thread entry to DOM, scroll to bottom |
| Signer status changes (signed/declined) | Update signer row in signing timeline in place |
| `completed` (all signed) | `window.location.reload()` — left column content changes substantially |

The general rule: reloads are acceptable for stage transitions (rare events). In-place updates for status-within-stage changes (common events like AI processing completion).

---

## Files to Modify

| File | Changes |
|---|---|
| `frontend/src/styles/global.css` | Add `.skeleton`, `.spinner`, `.error-banner` classes (and `@keyframes`) |
| `frontend/src/pages/upload.astro` | Replace `alert()` with `#upload-error` div; viewport meta (handled by AppLayout in Plan 01) |
| `frontend/src/pages/dashboard.astro` | Replace `alert()` in Sign Now handler; targeted SSE update (Plan 02 spec) |
| `frontend/src/pages/contracts/[id].astro` | Replace all `alert()` calls; optimistic reply; thread scroll; skeleton for AI state; targeted SSE update (Plan 03 spec) |
| `frontend/src/pages/sign/[token].astro` | Add "Preparing…" loading state; improve error state |

## Files to Reference

| File | Why |
|---|---|
| `frontend/src/styles/global.css` | Add animation utilities here alongside brand tokens |
| `backend/src/routes/events.ts` | Verify the exact JSON shape of SSE event payloads — `contractId`, `newStatus`, and any additional fields — to implement targeted DOM updates correctly |
