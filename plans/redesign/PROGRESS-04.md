# Plan 04 Progress Log

[START] Beginning Plan 04 targeted edits to frontend/src/pages/contracts/[id].astro

[STEP 1] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 1: add error banner CSS to <style> block
[STEP 1] EDITED: frontend/src/pages/contracts/[id].astro — added .error-banner CSS rule at end of <style> block

[STEP 2] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 1: add error banner <p> elements to HTML sections
[STEP 2] EDITED: frontend/src/pages/contracts/[id].astro — added sendError, signError, signNowError, downloadError, replyError, attachmentError <p> elements; removed Subject field (Change 4 coincides)

[STEP 3] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 1: replace all alert() calls in script with inline error banner display
[STEP 3] EDITED: frontend/src/pages/contracts/[id].astro — replaced all 6 alert() calls with per-element error banner display; reset banners on re-submit

[STEP 4] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 2: optimistic reply UI (already done inline with Change 1 script edit above)
[STEP 4] EDITED: frontend/src/pages/contracts/[id].astro — replyForm success path now appends optimistic outbound bubble, clears form, re-enables button; no page reload

[STEP 5] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 3: polish signing gateway (label, subtext, warning, origin check)
[STEP 5] EDITED: frontend/src/pages/contracts/[id].astro — showSigningForm now checks contract.origin !== 'received'; summary label changed to "Ready to finalise?"; added "Both parties agreed" subtext and warning note; added .signing-warning CSS

[STEP 6] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 4: remove Subject field from Send for Review form (already done in STEP 2 during error banner insertion)
[STEP 6] EDITED: (no further change needed — Subject field div was already removed in STEP 2)

[STEP 7] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — Change 5: update Awaiting card text with recipientName/recipientEmail
[STEP 7] EDITED: frontend/src/pages/contracts/[id].astro — awaiting card now shows "Awaiting reply from {name||email}" and "Sent to {email}" subtext

[STEP 8] Running astro check to verify no type errors
[STEP 8] astro check result: 0 errors, 0 warnings, 7 hints (all pre-existing hints about define:vars is:inline)

[PLAN DONE] All files changed:
  - frontend/src/pages/contracts/[id].astro
    Change 1: Replaced all 6 alert() calls with per-element inline error banners (sendError, signError, signNowError, downloadError, replyError, attachmentError); added .error-banner CSS; added error banner <p> elements in HTML
    Change 2: Reply form success path now appends optimistic outbound bubble to thread list, clears form, re-enables button without reloading
    Change 3: showSigningForm now guards contract.origin !== 'received'; signing collapse label changed to "Ready to finalise?"; updated subtext; added warning note with .signing-warning CSS
    Change 4: Removed Subject field div from Send for Review form
    Change 5: Awaiting card text updated to show "Awaiting reply from {name||email}" and "Sent to {email}" subtext

