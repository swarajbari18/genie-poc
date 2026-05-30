# Plan 05 — Signing Ceremony Progress Log

[START] PLAN STARTED — Files to modify:
  - frontend/src/pages/contracts/[id].astro
  - frontend/src/pages/sign/[token].astro

[EDIT-1] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Fix SSR getStage(): move partially_signed from stage 3 to stage 4; add declined to stage 3 only
[EDIT-1] EDITED: frontend/src/pages/contracts/[id].astro — SSR getStage() now maps partially_signed to stage 4, declined separate at stage 3

[EDIT-2] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Fix showUnderReview (remove partially_signed), add showSigningRoster const
[EDIT-2] EDITED: frontend/src/pages/contracts/[id].astro — showUnderReview no longer includes partially_signed; showSigningRoster = out_for_signature|partially_signed

[EDIT-3] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Add id="contractStatusBadge" to status badge; consolidate two signing roster sections into one; polish signer labels; add data-signer-id/status attrs; update section title and subtitle
[EDIT-3] EDITED: frontend/src/pages/contracts/[id].astro — Status badge gets id="contractStatusBadge"; two signing roster blocks replaced by single showSigningRoster block with human-readable labels and data attrs

[EDIT-4] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Fix client-side getStage() (partially_signed to stage 4); update SSE handler to always reload in stage 4; use id="contractStatusBadge" for badge update
[EDIT-4] EDITED: frontend/src/pages/contracts/[id].astro — Client-side getStage() fixed; SSE handler now reloads when newStage===4 even if stage unchanged; badge update uses getElementById

[EDIT-5] ABOUT TO EDIT: frontend/src/pages/sign/[token].astro — Replace server-side redirect with loading card + client-side redirect; add back-to-dashboard link on error states; add spinner styles
[EDIT-5] EDITED: frontend/src/pages/sign/[token].astro — Server-side redirect removed; loading card with spinner shown on success; JS redirect via define:vars; back-to-dashboard link on both error states; spinner styles added

[PROBLEM] astro check — TS errors in signing roster block: TypeScript generic Record<string,string> inside JSX expression causes parse errors; local consts in arrow function body also fail. Need to refactor: move labelMap and logic outside the JSX map. Resolved by computing signer display data in frontmatter and passing plain objects to the template.

[EDIT-6] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Refactor signing roster to avoid TS generics inside JSX; compute display data in frontmatter instead
[EDIT-6] EDITED: frontend/src/pages/contracts/[id].astro — signersDisplay array computed in frontmatter with label/badgeClass pre-computed; JSX uses simple s.label/s.badgeClass expressions

[CHECK] npx astro check — 0 errors, 0 warnings (8 pre-existing define:vars hints, not introduced here)

[PLAN DONE] Files changed:
  - frontend/src/pages/contracts/[id].astro
      * SSR getStage(): partially_signed moved to stage 4; declined isolated to stage 3
      * Client-side getStage() (script block): same fix
      * showUnderReview: removed partially_signed
      * showSigningRoster: new const for out_for_signature|partially_signed
      * Status badge: added id="contractStatusBadge"
      * Signing roster: two duplicate sections consolidated into one using showSigningRoster
      * Signer labels: human-readable (Pending, Waiting…, Viewed, Signed ✓, Declined ✗)
      * Signer rows: data-signer-id and data-signer-status attributes added
      * Section title changed to "Signature Request" with Dropbox Sign subtitle
      * signersDisplay array computed in frontmatter (avoids TS generics in JSX)
      * SSE handler: reloads when newStage===4 even if stage unchanged
      * SSE badge update: uses getElementById('contractStatusBadge')
  - frontend/src/pages/sign/[token].astro
      * Server-side Astro.redirect removed
      * Loading card with spinner shown when signUrl is available
      * Client-side JS redirect via define:vars script
      * Back-to-dashboard link added to both error states (409 and generic error)
