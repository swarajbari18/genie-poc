# UI/UX Revamp — Progress

## Status
- [x] Step 1 — global.css additions
- [x] Step 2 — AppLayout header polish
- [x] Step 3 — upload.astro drag-and-drop
- [x] Step 4 — dashboard.astro pipeline view
- [x] Step 5 — [id].astro header
- [x] Step 6 — [id].astro left column
- [x] Step 7 — [id].astro right column + composer
- [x] Step 8 — [id].astro signing wizard

## Log
[2026-05-28] SESSION START — fresh session, no prior PROGRESS.md, beginning Step 1.

[2026-05-28] Step 1 — global.css additions
  - added --shadow-raised token
  - added .btn-primary.btn-lg modifier (full-width large CTA)
  - added .warning-notice primitive (yellow inline notice with ⚠)
  - added .avatar / .avatar--outbound / .avatar--inbound (28px circle initials)
  - added .progress-bar + .progress-bar__fill primitives

[2026-05-28] Step 2 — AppLayout header polish
  - added accent-coloured shield SVG mark next to "Genie AI" wordmark
  - kept structure unchanged

[2026-05-28] Step 3 — upload.astro drag-and-drop
  - full rewrite: two-step progressive disclosure
  - dropzone with empty / dragover / selected states
  - file chip with name, size, remove ×
  - title auto-derived from filename (title-cased, underscores/dashes → spaces)
  - fake-progress bar animates to 90% during upload, jumps to 100% on success
  - inline error banner; preserves existing POST /api/contracts/upload contract

[2026-05-28] Step 4 — dashboard.astro pipeline view
  - three-column pipeline (NEEDS ATTENTION / IN FLIGHT / CLOSED) on ≥ 900px
  - column header pills with per-group colour
  - per-tile border-left colour (accent / mid / green / red)
  - card-style tile with shadow + hover lift; full-tile click overlay preserved
  - relative time-ago label per tile (server-rendered, refreshed by SSE)
  - awaiting-signature strip with pulse animation at top
  - large empty state with document icon + CTA
  - preserved targeted SSE badge update (no full reload on same-group changes)

[2026-05-28] Step 5 — [id].astro header + stage indicator
  - removed redundant raw status badge (stage strip already communicates status)
  - new layout: back link → title + counterparty meta → stage strip (right on desktop, below on mobile)
  - stage circles upsized 28 → 32 px; labels 0.65 rem
  - removed dead contractStatusBadge reference from SSE handler

[2026-05-28] Step 6 — [id].astro left column action area
  - DRAFT: collapsed "Ready to send?" card → expands in place to composer
  - email preview box with live recipient-name interpolation
  - SENT/AI_PROCESSING: split into awaiting card + separate "Analysing their changes…" pill
  - SIGNING_ROSTER: progress bar + timeline-style signer list
  - COMPLETED: large green ✓ seal, "Contract Executed" copy
  - UNDER_REVIEW: signing collapse gains subtle accent border + background

[2026-05-28] Step 7 — [id].astro right column thread + composer
  - thread bubbles wrapped in flex rows with avatar circles (outbound right / inbound left)
  - removed outbound left-accent border (right alignment alone communicates direction)
  - new "Sender · Jan 3 · 2:45 PM" timestamp under every bubble
  - chat-style composer: borderless auto-grow textarea, sticky bottom, shadow-raised
  - file input hidden behind label; selecting shows filename chip with × remove
  - send button disabled until textarea has content
  - optimistic append updated to render new row+avatar structure
  - userInitial passed through define:vars for client-side use

[2026-05-28] Step 8 — [id].astro signing wizard
  - two-step wizard inside the existing <details>
  - Step 1: signer cards in <bg-subtle> wrappers; pill-styled role select; × remove when ≥2 signers
  - Step 2: signers summary, optional collapsible note, warning-notice, large submit
  - existing POST /send-for-signature endpoint untouched
  - removed unused .signing-warning CSS

## Verification
- All 8 steps pass `cd frontend && npx astro check`: 0 errors / 0 warnings.
- No backend changes were required.
