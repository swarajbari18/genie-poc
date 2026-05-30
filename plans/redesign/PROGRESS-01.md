# Plan 01 — Brand Foundation — Progress Log

[12:15] ABOUT TO EDIT: frontend/src/styles/global.css — creating new file with all design tokens and primitive classes
[12:16] EDITED: frontend/src/styles/global.css — created with :root tokens, body reset, .btn-primary, .btn-ghost, .card, .badge, .badge-active, .badge-muted, .badge-warning

[12:16] ABOUT TO EDIT: frontend/src/layouts/AppLayout.astro — creating shared HTML shell with header, Inter font, global.css import
[12:17] EDITED: frontend/src/layouts/AppLayout.astro — created with Props (title, user, apiUrl), HTML shell, Inter font link, global.css link, sticky header with wordmark + sign-out, slot

[12:17] ABOUT TO EDIT: frontend/src/pages/index.astro — remove :root block, replace blue tokens, use AppLayout
[12:18] EDITED: frontend/src/pages/index.astro — removed :root block, wrapped in AppLayout (user=null), replaced blue with brand tokens, added landing-specific styles

[12:18] ABOUT TO EDIT: frontend/src/pages/dashboard.astro — remove :root block, remove duplicate header, use AppLayout, replace all inline blue with brand tokens
[12:19] EDITED: frontend/src/pages/dashboard.astro — removed :root block + old header + sign-out script, wrapped in AppLayout, replaced all blue inline styles with CSS classes using brand tokens, sign-out now handled by layout

[12:19] ABOUT TO EDIT: frontend/src/pages/upload.astro — remove :root block, remove duplicate header, use AppLayout, add missing viewport meta, replace blue with brand tokens
[12:20] EDITED: frontend/src/pages/upload.astro — removed :root block + old header, wrapped in AppLayout (with user), viewport meta now in AppLayout, replaced blue with brand tokens, field-input focus uses accent color

[12:20] ABOUT TO EDIT: frontend/src/pages/contracts/[id].astro — remove :root block, remove duplicate header, use AppLayout, replace all blue with brand tokens
[12:21] EDITED: frontend/src/pages/contracts/[id].astro — removed :root block + old header, wrapped in AppLayout, all blue replaced with brand tokens, signer badge colors updated, attachment link uses accent color, DiffViewer import path updated

[12:21] ABOUT TO EDIT: frontend/src/pages/sign/[token].astro — remove :root block, use AppLayout (user=null), replace blue with brand tokens
[12:22] EDITED: frontend/src/pages/sign/[token].astro — removed old style block, wrapped in AppLayout (user=null), added branded CSS classes for sign error/success states

[12:23] PROBLEM: global.css linked as /styles/global.css (public path) but file is in src/styles/ — Astro needs an import in frontmatter, not a link tag. Fixing AppLayout.astro.
[12:23] ABOUT TO EDIT: frontend/src/layouts/AppLayout.astro — change <link href="/styles/global.css"> to import in frontmatter
[12:23] EDITED: frontend/src/layouts/AppLayout.astro — added import '../styles/global.css' in frontmatter, removed <link rel="stylesheet"> tag

[12:24] PROBLEM: Astro scoped <style> blocks don't apply to body (body is in layout, not in page component). index.astro used body{display:flex} for centering. Fix: use a wrapper div instead of body styling.
[12:24] ABOUT TO EDIT: frontend/src/pages/index.astro — replace body{flex} styling with a wrapper div for centering
[12:24] EDITED: frontend/src/pages/index.astro — replaced body{display:flex} with .landing-center wrapper div

[12:25] TYPE CHECK RESULT: 3 errors (key prop on non-React HTML elements in dashboard.astro), 7 hints (define:vars warnings — pre-existing), 0 warnings that are new
[12:25] ABOUT TO EDIT: frontend/src/pages/dashboard.astro — remove key={} props from non-React HTML elements (li, div) to fix 3 type errors
[12:25] EDITED: frontend/src/pages/dashboard.astro — removed key={c.id} from <li> elements and key={groupTitle} from <div> (3 type errors resolved)

[12:25] TYPE CHECK (final): 0 errors, 0 warnings, 7 hints (all pre-existing define:vars informational hints — not errors)

[12:26] PLAN DONE — files changed:
  - frontend/src/styles/global.css (CREATED): all design tokens in :root, body reset, .btn-primary, .btn-ghost, .card, .badge, .badge-active, .badge-muted, .badge-warning
  - frontend/src/layouts/AppLayout.astro (CREATED): shared HTML shell, Inter font, global.css import, sticky header with Genie AI wordmark + user name + sign-out button, slot
  - frontend/src/pages/index.astro (MODIFIED): removed old :root block + inline styles, wrapped in AppLayout (user=null), replaced #2563eb with brand tokens, centering via .landing-center wrapper div
  - frontend/src/pages/dashboard.astro (MODIFIED): removed :root block + old header + sign-out script, wrapped in AppLayout (user passes), all inline blue styles replaced with CSS classes using brand tokens, key={} removed from non-React elements
  - frontend/src/pages/upload.astro (MODIFIED): removed :root block + old header, wrapped in AppLayout (with user), added missing viewport meta (now provided by AppLayout), replaced blue with brand tokens
  - frontend/src/pages/contracts/[id].astro (MODIFIED): removed :root block + old header, wrapped in AppLayout (with user), all inline blue replaced with brand token CSS classes, DiffViewer import path updated for new directory depth
  - frontend/src/pages/sign/[token].astro (MODIFIED): removed old style block, wrapped in AppLayout (user=null), added branded CSS classes for sign error/success states

