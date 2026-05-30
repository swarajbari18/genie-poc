# Plan 03 — Contract Detail Page Redesign — Progress Log

[START] PLAN BEGINS — implementing two-column layout, stage indicator, thread redesign, action area logic fix, SSE handler update

[START] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — full redesign: two-column layout, 5-stage journey indicator, direction-based thread styling, action area logic fix (remove draft from signing form, add negotiating to reply composer), SSE smart reload

[STEP-1] EDITED: frontend/src/pages/contracts/[id].astro — rewrote entire file: two-column grid layout (60/40), 5-stage strip with SSR stage mapping, outbound/inbound/system thread bubbles, t.body field fix (was t.bodyText), attachment chip with storageKey/storage_key fallback, action area split by status (draft→send form, sent/ai_processing→awaiting card, under review→AI card + collapsed signing, out_for_signature→roster, completed→download, declined→declined card), reply composer condition expanded to ['replied','negotiating'] + received origin, SSE smart reload (only full reload on stage change), data-current-status attribute on main

[STEP-1] ABOUT TO RUN: astro check to verify TypeScript

[STEP-2] astro check result: 0 errors, 0 warnings — two unused-variable hints (isFuture, showSigningRoster) cleaned up; re-ran check: 0 errors, 0 warnings, 7 hints (all pre-existing define:vars hints affecting every file in the project)

[PLAN DONE] — Files changed:
  - frontend/src/pages/contracts/[id].astro
    * Two-column layout (60/40 grid, mobile stack)
    * 5-stage journey indicator strip (Draft → Sent → Under Review → Signing → Executed) with SSR stage mapping
    * Stage circles: active=accent fill, completed=brand-mid fill+checkmark, future=gray, declined=red tint
    * Thread redesigned: outbound bubbles (right-aligned, accent border-left), inbound bubbles (left-aligned, white), system events (centered pill)
    * t.body field fix (was t.bodyText — broken after Plan 07)
    * Attachment chips with storageKey/storage_key fallback, actual filename shown
    * Action area split by status: draft→send form, sent/ai_processing→awaiting card, under review→AI analysis + collapsed signing section, out_for_signature→signing roster, completed→download card, declined→declined card
    * Signing form condition fixed: only shown for ['replied','negotiating'] — removed 'draft','sent','completed' from old condition
    * Reply composer condition expanded: ['replied','negotiating'] OR received-origin contracts with ['received','replied','negotiating']
    * SSE smart reload: only full reload when stage changes; same-stage transitions update badge text only
    * data-current-status attribute on <main> for SSE stage comparison
    * Back link added to page header
