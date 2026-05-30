# Genie AI POC — UI/UX Revamp Master Prompt

## How to Use This File

Paste the entire contents of this file as your first message in a new Claude Code session.
It is fully self-contained. Read it completely before writing a single line of code.

---

## What This Session Is About (Read This First)

This is a continuation of a completed sprint. In the previous sprint we fixed 8 backend bugs and applied Genie's brand color tokens to every page. Both of those things are done and working. Do not redo them.

The result was disappointing for one reason: **a color swap is not a redesign**. Every page still has the same layout and the same interaction pattern — HTML forms with labels, inputs, and a submit button. That is not a product experience. In 2026, bare forms are not how people interact with software. The previous sprint fixed *what* the app shows. This sprint fixes *how* the user experiences it.

The goal of this session is to redesign every human touchpoint in the app — every moment where the user has to take an action — into something that feels intentional, guided, and modern. This is about interaction design, not color theory.

---

## What Was Already Built (Do Not Rebuild)

The previous sprint delivered:

**Backend (all correct, do not touch):**
- Dropbox Sign switched to email-link flow (`signatureRequestSend`)
- `generateDownloadSignedUrl` accepts a `filename` param
- Dashboard query uses a UNION CTE to include contracts where the user is a signer
- `GET /:id` uses `LEFT JOIN LATERAL` subqueries for threads and signers (one round-trip)
- Thread ordering is `ASC` (oldest first) in the SQL
- Case-insensitive email matching in webhook handler
- `'draft'` removed from `allowedStatuses` for send-for-signature
- 409 retry in the signed-file download webhook handler
- Rich email bodies (sender name, contract title, contextual message)
- `Cache-Control: no-store` on all signed URL endpoints

**Frontend infrastructure (keep, improve on top of):**
- `frontend/src/styles/global.css` — all brand tokens, `.btn-primary`, `.btn-ghost`, `.card`, `.badge`, `.skeleton`, `.error-banner`
- `frontend/src/layouts/AppLayout.astro` — shared HTML shell, sticky header, Inter font
- All pages use `AppLayout`, no `#2563eb` blue anywhere
- `contracts/[id].astro` — two-column layout (60/40), 5-stage journey indicator, direction-based thread bubbles, smart SSE (reload only on stage change)
- `dashboard.astro` — targeted SSE badge update, full-tile clickable rows, human-readable status labels
- `sign/[token].astro` — loading state with spinner, client-side redirect

**Do not touch:**
- Auth (Better Auth, Google OAuth, HttpOnly cookie)
- `DiffViewer.tsx` — React island, works correctly
- `aiAnalysis.ts` — AI pipeline, works correctly
- Any backend route logic beyond CSS/template changes

---

## The Actual Problem: Forms Are Not Flows

Every single interaction in this app is a form. Here is the current state of each touchpoint:

**Upload a contract** → A file picker + a text input for title + a submit button. That is it.

**Send for Review** → A card with two inputs (recipient name, email) and a "Send Email" button visible on the draft page.

**Reply to counterparty** → A textarea + a file input + a "Send Reply" button.

**Send for Signature** → A grid of inputs (name, email, role) for each signer, an "Add another signer" button, a textarea for a message, and a submit button.

**Dashboard** → A flat vertical list of cards. Every contract looks the same.

**Contract page header** → A title and a raw status badge. No context, no guidance.

None of these communicate what the product is actually about. None of them guide the user. None of them have any sense of moment — a contract being sent for signature is a legally significant event. The app treats it like a contact form submission.

---

## Design Direction: Principles for This Sprint

These are the rules that govern every design decision in this sprint.

**1. Replace every form with a flow.**
A form asks the user to fill in blanks and click submit. A flow presents one decision at a time, gives context for why that decision matters, and confirms before acting. No page should have more than one primary action visible at once.

**2. Every screen tells the user what to do next.**
The app should function like a guide, not a filing cabinet. When a contract is in draft state, the page should say "Send this contract to your counterparty for review" — not present a form and hope the user knows why it's there.

**3. Actions have weight.**
Sending a contract for signature is not the same as sending a chat message. The UX should reflect that. Big, committed actions (send, sign, confirm) deserve a moment — a confirmation step, a summary of what's about to happen, and a clear "go" button. Small actions (type a reply, attach a file) should feel lightweight and fast.

**4. The dashboard is a pipeline, not a list.**
The user needs to see at a glance: what needs my attention right now? Which contracts are moving? Which are stalled? A flat list sorted by date does not answer any of those questions. The dashboard should communicate status through visual hierarchy, not through reading every card individually.

**5. Inputs appear only when they are needed.**
A textarea for the reply composer should not be visible when there is nothing to reply to. The signing form should not appear until the user explicitly chooses to initiate signing. Progressive disclosure — reveal the next step only when the current step is done.

**6. Empty states are invitations.**
An empty dashboard should tell the user what the app does and invite them to upload their first contract. An empty thread should tell the user what will appear there. Never show a blank box.

---

## Brand Tokens (Already Extracted — No Research Needed)

These were extracted from genieai.co in the previous sprint. They are already in `global.css`. Do not look them up again.

```
--color-brand-deep:     #3D1152   logo, footer, wordmark
--color-brand-mid:      #5C0F8B   hover states, completed stage indicators
--color-accent:         #673AB7   all interactive elements, buttons, active borders

--color-gradient-blue:  #6C81FA
--color-gradient-indigo:#5D58FF
--color-gradient-purple:#673AB7
gradient: linear-gradient(180deg, #6C81FA 35%, #5D58FF 53%, #673AB7 90%)
(use ONLY on illustration icons — never as button or section background)

--color-text-primary:   #212121
--color-text-muted:     #828282
--color-text-on-dark:   #FFFFFF

--color-bg-white:       #FFFFFF
--color-bg-subtle:      #F9F9F9
--color-bg-footer:      #3D1152

--color-border-light:   #F2E7FE   highlight card background
--color-border-mid:     #D3B4F7   highlight card border
--color-border-default: #E5E7EB   general card borders

--font-family-base:     'Inter', 'DM Sans', system-ui, sans-serif
--font-weight-regular:  400
--font-weight-semibold: 600
--font-weight-bold:     700

--radius-card:    12px
--radius-button:  8px
--radius-pill:    999px
--radius-input:   6px

--shadow-card:    0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)
--shadow-raised:  0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)
```

Visual style: flat and minimal. White dominant. No gradients on backgrounds. No glassmorphism.
Buttons are solid `#673AB7`, white text, 8px radius. Hover goes to `#5C0F8B`.

---

## File Locations

```
frontend/src/
  layouts/AppLayout.astro          — shared HTML shell (116 lines)
  styles/global.css                — all tokens + primitives (232 lines)
  pages/
    index.astro                    — landing / sign-in
    dashboard.astro                — contract pipeline (477 lines)
    upload.astro                   — upload new contract (161 lines)
    contracts/[id].astro           — contract detail page (1622 lines)
    sign/[token].astro             — Genie-to-Genie signing redirect
  components/
    DiffViewer.tsx                 — React island, do not touch

backend/src/routes/
  contracts.ts                     — all contract endpoints
  webhooks.ts                      — Postmark + Dropbox Sign webhooks
  events.ts                        — SSE endpoint
```

---

## Tech Stack

- Frontend: Astro 6, React islands (client:visible), Cloudflare Workers
- Styling: plain CSS in `<style>` blocks and `global.css`. No Tailwind. No CSS-in-JS.
- Icons: use inline SVG or Unicode characters. Do not install an icon library.
- Animations: CSS only (keyframes, transitions). No JavaScript animation libraries.
- Backend: Hono (TypeScript), GCP Cloud Run — do not change routes unless needed for a new interaction
- Auth: Better Auth, HttpOnly cookie — do not touch
- SSE event shape: `{ contractId: string, status: string }` on event type `"status"`

---

## Page-by-Page Redesign Specifications

Read each section in full before touching any file.

---

### Page 1: Dashboard (`dashboard.astro`)

**Current state:** Flat vertical list. Three section headers (Needs Attention / In Flight / Closed). Each contract is a row with title, recipient email, and a status badge. The whole row is clickable (fixed in Sprint 1).

**What is wrong:** Visual entropy — every row looks identical. The user has to read each row to understand what is happening. There is no sense of priority or urgency. An empty dashboard shows nothing.

**Target: Pipeline View**

Replace the vertical list with a three-column pipeline layout on desktop (≥ 900px). Each column is one stage group. On mobile, columns stack.

```
┌──────────────────┬──────────────────┬──────────────────┐
│  NEEDS ATTENTION │    IN FLIGHT     │      CLOSED      │
│  (sort_group=1)  │  (sort_group=2)  │  (sort_group=3)  │
│                  │                  │                  │
│  [Contract card] │  [Contract card] │  [Contract card] │
│  [Contract card] │                  │                  │
└──────────────────┴──────────────────┴──────────────────┘
```

Each column:
- Column header: pill badge with the group name + count of contracts in that group
- "Needs Attention" header pill: `var(--color-accent)` background, white text
- "In Flight" header pill: `var(--color-border-mid)` background, `var(--color-brand-deep)` text
- "Closed" header pill: `#F5F5F5` background, `var(--color-text-muted)` text
- Empty column: shows a subtle empty-state message ("Nothing here yet")

Each contract card within a column:
- White background, `var(--radius-card)` radius, `var(--shadow-card)` shadow
- `border-left: 3px solid` — color indicates status:
  - Needs Attention: `var(--color-accent)`
  - In Flight: `var(--color-border-mid)`
  - Closed (completed): `#16a34a` (green)
  - Closed (declined): `#dc2626` (red)
- Card body: contract title (weight 600, 0.95rem), recipient name/email below (0.8rem, muted)
- Card footer: status badge (right-aligned) + time since last update (e.g. "3h ago", left-aligned, 0.75rem muted)
- Full card is clickable via `position: absolute; inset: 0` anchor overlay (already done in Sprint 1 — replicate the pattern)

**"New Contract" button:**
A prominent `btn-primary` in the page header row, right side, linking to `/upload`.

**Awaiting My Signature strip:**
If any contract has `awaitingMySignature: true`, show a horizontal banner at the VERY TOP of the page content (above the pipeline columns), styled with `border-left: 4px solid var(--color-accent)` and `background: var(--color-border-light)`. List each contract as a row: name + "Sign Now →" link to `/contracts/{id}`. This already exists but gets improved styling here.

**Empty state (zero contracts):**
When `contracts.length === 0`, show a centered empty state instead of the pipeline columns:
```
[Large faint icon — e.g. a document outline in #F2E7FE]
You haven't uploaded any contracts yet.
[btn-primary: Upload your first contract →]
```

**SSE behavior:** unchanged from Sprint 1 (targeted badge update in place, reload on group change).

---

### Page 2: Upload (`upload.astro`)

**Current state:** A card with a file input, a title text input, and a submit button. Three lines of form.

**What is wrong:** It gives no guidance, no feedback during upload, no preview of what was selected. A file input `<input type="file">` is one of the least trustworthy UI elements in existence — it shows a system dialog and then displays a raw filename.

**Target: Guided Upload Experience**

Replace the bare form with a two-step guided flow.

**Step 1 — Choose file:**

A large drag-and-drop zone. Visual design:
- `background: var(--color-bg-subtle)`, `border: 2px dashed var(--color-border-mid)`, `border-radius: var(--radius-card)`
- Minimum height 200px, centered content
- Icon: a simple document-with-arrow-up SVG (draw inline, 48×48, stroke `var(--color-border-mid)`, stroke-width 1.5)
- Primary text: "Drag your contract here" (weight 600, `var(--color-text-primary)`)
- Secondary text: "or" (muted)
- A `btn-ghost` button: "Browse files"
- Accepted types: PDF only. Show "PDF only · max 10MB" in 0.75rem muted text below.

When a file is dragged over the zone: `border-color: var(--color-accent)`, `background: var(--color-border-light)` — the zone visually activates.

When a file is selected (either dragged or via browse):
- The zone transitions to a "selected" state: shows the filename, file size, a PDF icon, and a "Remove" link (×)
- The zone collapses to a compact bar (not full height) and the next step appears below it

**Step 2 — Name your contract:**

Appears AFTER a file is selected (not shown initially — progressive disclosure):
- A single prominent text input: "Contract name" with placeholder "e.g. NDA with Acme Corp"
- Pre-filled with a cleaned version of the filename (strip extension, replace underscores/hyphens with spaces, title-case)
- Below the input: a `btn-primary` button: "Upload Contract"

**During upload:**
- Button becomes disabled: "Uploading…" with the `.spinner` animation inside the button
- A progress bar below the drop zone animates from 0% to 100% (CSS animation — fake progress is fine for a POC; animate from 0 to 90% in 3s, then jump to 100% on success)

**On success:**
- Navigate to `/contracts/{id}` (the backend already returns `contractId` in the 201 response)

**Error:**
- Show `.error-banner` below the button, not an alert

**Implementation note:** The existing upload.astro has 161 lines. The script block sends `FormData` to `POST /api/contracts/upload` and navigates on success. Keep that logic. Replace only the HTML template and CSS.

---

### Page 3: Contract Detail — Header + Stage Indicator (`contracts/[id].astro`)

**Current state:** A page title row with the contract name and a raw status badge. Below it, a horizontal row of 5 numbered circles (Draft → Sent → Under Review → Signing → Executed). Both exist and are functional.

**What to improve:**

The header needs to communicate more than a title. It should tell the user: what is this contract, who is involved, and where is it right now — in one glance.

**New header design:**
```
← All Contracts
[Contract title, large weight 700]
[Counterparty name · Counterparty email]    [Stage indicator strip]
```

- The stage indicator strip moves to the right side of the header on desktop (flex row: title+meta on left, stages on right), and below the title on mobile
- Each stage circle: 32px × 32px (slightly larger than current 28px). Labels beneath each circle in 0.65rem.
- A connector line between circles. Completed segments: `var(--color-brand-mid)`. Remaining: `var(--color-border-default)`.
- Active stage circle: `var(--color-accent)` fill. Completed: `var(--color-brand-mid)` fill + ✓. Future: white fill with `var(--color-border-default)` border.

The contract status badge (the raw "draft" / "replied" etc. badge): remove it from the header entirely. The stage strip already communicates where the contract is. Having both is redundant.

---

### Page 4: Contract Detail — Left Column Action Area (`contracts/[id].astro`)

This is the most important part of this redesign. The left column is where the user takes action. Currently it is a collection of conditionally-rendered forms. It needs to become a contextual guidance panel.

**The governing principle: one primary action, always explained.**

Every state in the left column must have:
1. A clear statement of what is happening right now
2. Exactly one primary call-to-action (or a clear indicator that no action is needed)
3. No form fields visible until the user explicitly starts the action

---

**State 1: Draft**

Current: "Send for Review" form (two inputs, a button).

New design:

A card with:
- Icon: envelope with an arrow (SVG inline, 32px, stroke `var(--color-accent)`)
- Heading: "Ready to send?" (weight 700, 1.1rem)
- Body: "Send this contract to your counterparty for review. They'll receive it by email and can reply directly from their inbox."
- A single `btn-primary` button: "Send for Review →"

When the user clicks "Send for Review →", the card **expands in place** (not a new page, not a modal) to reveal the composer:

```
[Collapse back ↑]                        [heading: "Send for Review"]
To:  [______________________________]    ← name input, autofocus
     [______________________________]    ← email input
     
     [Multiline preview of the email
      they'll receive — non-editable,
      derived from the template]
      
[Send Contract]   [Cancel]
```

The expansion is a CSS max-height transition from 0 to auto (use a CSS custom property trick or a fixed max-height). The "collapse" link at the top of the expanded state collapses it back.

Implementation: render both the collapsed card AND the expanded form in the HTML. Use a `data-expanded="false"` attribute on the card wrapper and toggle it with JavaScript. CSS selects `[data-expanded="true"]` to show the form.

The email preview box shows:
```
Subject: {contract.title} — Review Requested

Hi {recipientName || "there"},

{user.name} has sent you a contract to review via Genie AI.

Contract: {contract.title}

Please review the attached PDF and reply to this email with your 
feedback or a revised version.

— Genie AI
```
Style the preview box: `background: var(--color-bg-subtle)`, `border: 1px solid var(--color-border-default)`, `border-radius: var(--radius-input)`, `padding: 0.75rem 1rem`, `font-size: 0.85em`, `color: var(--color-text-muted)`, `white-space: pre-wrap`. The name field in the preview updates in real-time as the user types (use a simple `input` event listener to update a `<span>` in the preview).

---

**State 2: Sent / AI Processing**

Current: A card saying "Contract Sent" or a spinner for AI processing.

This is conceptually correct. Improve the visual:
- Icon: a clock or hourglass SVG (inline, 32px, stroke `var(--color-text-muted)`)
- Heading: "Awaiting {contract.recipientName}'s reply" (weight 600)
- Body: "Sent to {contract.recipientEmail} · {formatted sentAt date}. You'll be notified when they respond."
- No action button — there is nothing to do here. This is the correct mental model.
- If `ai_processing`: add below the above: a separate pill (not a full card) — `background: var(--color-border-light)`, `border: 1px solid var(--color-border-mid)`, inline spinner + "Analysing their changes…" — this sits below the main awaiting card, not replacing it.

---

**State 3: Under Review (received, replied, negotiating)**

Current: Shows AI analysis card if available, then a collapsed signing gateway.

The left column in under-review state is mostly reference material (AI summary, diff). The dominant action is in the RIGHT column (the reply composer). The left column should communicate that.

- If AI analysis is available: show the AI card (already done in Sprint 1, keep it)
- If no AI analysis: a simple status card: "The counterparty has replied. Review their response in the thread."
- The signing gateway: keep it as a collapsible `<details>`. The trigger label: "Ready to finalise?" — already done in Sprint 1. Improve the collapsed appearance: add a subtle `border: 1px solid var(--color-border-mid)` and `background: var(--color-border-light)` so it reads as a distinct secondary action, not just another card.

---

**State 4: Signing (out_for_signature, partially_signed)**

Current: A "Signature Request" section showing a list of signers with their status badges.

Improve the signer list:
- Each signer row becomes a proper timeline item with a left-border indicator line
- Signed: green dot + name + "Signed on {date}"
- Waiting: grey hollow circle + name + email + "Waiting for signature"
- Viewed: purple hollow circle + name + "Viewed the document"
- Declined: red × + name + "Declined"

A horizontal progress bar above the list: `{signedCount} of {totalCount} signatures collected`. The bar fills from left to right in `var(--color-accent)`, greyed remainder. `border-radius: var(--radius-pill)`, height 6px.

---

**State 5: Executed (completed, signed)**

Current: Green card with "✓ Contract Fully Signed" and a download button.

Keep the structure, polish the visual:
- Larger ✓ circle (48px, `background: #DCFCE7`, `color: #166534`, `border-radius: 50%`, centered ✓ at 1.5rem)
- Heading: "Contract Executed"
- Body: "All parties have signed. The final document is ready to download."
- `btn-primary` button: "Download Executed PDF"

---

### Page 5: Contract Detail — Right Column (Thread + Reply Composer) (`contracts/[id].astro`)

**Thread redesign** (directional bubbles were done in Sprint 1 — enhance):

The thread currently shows outbound messages right-aligned with accent border and inbound messages left-aligned white. This is correct. Improvements:

- Add sender avatar: a 28px circle with the first letter of the sender's name. Outbound: `var(--color-accent)` background, white letter. Inbound: `var(--color-border-default)` background, `var(--color-text-primary)` letter. Position it to the left of inbound bubbles and right of outbound bubbles.
- Outbound message: remove the left border accent — the right alignment already communicates direction. Keep the `var(--color-border-light)` background.
- System events: the centered muted pill is correct, keep it.
- Timestamps: show on every message. Format: "Jan 3 · 2:45 PM". Position: below the bubble, in 0.7rem muted, same alignment as the bubble.

**Reply Composer redesign:**

Current: A card with heading "Send Counter-Reply", a textarea, a file input, and a "Send Reply" button. This looks like a support ticket form.

New design — a chat-style composer pinned to the bottom of the right column:

```
┌─────────────────────────────────────────────────┐
│                                                  │
│  [textarea, placeholder: "Write your reply…"]   │
│                                                  │
├─────────────────────────────────────────────────┤
│  [📎 Attach revised PDF]         [Send Reply →] │
└─────────────────────────────────────────────────┘
```

- The composer box: `background: white`, `border: 1px solid var(--color-border-default)`, `border-radius: var(--radius-card)`, `box-shadow: var(--shadow-raised)` — slightly elevated to indicate it's pinned
- The textarea: borderless, no background (`background: transparent`, `border: none`, `outline: none`), resize: none, minimum 3 rows, auto-grows with content (use `rows` + CSS `field-sizing: content` or a JS auto-resize listener)
- The footer row inside the composer: flex, space-between
- "Attach revised PDF" — a ghost button that, when clicked, reveals a file input (hidden by default): `<label class="attach-label"><input type="file" ...> 📎 Attach revised PDF</label>`
- When a file is selected: replace "Attach revised PDF" with a chip showing the filename + an × to remove it
- "Send Reply →": `btn-primary`, disabled until the textarea has content

The composer is `position: sticky; bottom: 1.5rem` inside the right column.

**Optimistic append** (already done in Sprint 1 — keep the behavior, update the visual to match the new bubble design).

---

### Page 6: Signing Gateway — Expanded State (`contracts/[id].astro`)

When the user opens the "Ready to finalise?" details in the left column, they see the signing form. Currently: a grid of inputs per signer, an "Add signer" button, a message textarea, and a submit button. This feels like a settings form.

**Target: a step-by-step mini-wizard inside the expanded `<details>` element.**

The wizard has two steps, rendered inline (no navigation, just show/hide):

**Step 1 — Who needs to sign?**

```
Step 1 of 2 · Who needs to sign?            [Step indicator pills]

[Signer card — first signer always shown]
  Name:  [_______________________]
  Email: [_______________________]
  Role:  Counterparty ▾            ← select, but styled as a pill dropdown

[+ Add another signer]              ← text link, adds a new signer card above it

[Next: Review →]   [Cancel]
```

Each signer is a card (`background: var(--color-bg-subtle)`, `border-radius: var(--radius-input)`, `padding: 0.75rem`). The remove button (×) on each card removes that signer.

"Next: Review →" validates that all signer fields are filled, then advances to step 2.

**Step 2 — Review and confirm**

```
Step 2 of 2 · Confirm signing request

You are about to send this contract for legal e-signature.
Dropbox Sign will email each signer with a link to review 
and sign the document.

Signers:
  ● Alice Jones (alice@example.com) — Counterparty
  ● You (you@genie.ai) — Creator

[Optional message to signers]
[___________________________]     ← textarea, collapsible: "Add a note (optional)"

⚠  Once sent, the contract can no longer be edited.

[Send for Signature]   [← Back]
```

The warning line uses: `color: #854d0e`, `background: #FEF9C3`, `border-radius: var(--radius-input)`, `padding: 0.5rem 0.75rem`, `font-size: 0.85em`.

The "Send for Signature" button: large, full-width `btn-primary`. This is a significant action — give it visual weight.

**Implementation:** render both steps in HTML. Step 1 has `id="signing-step-1"`, step 2 has `id="signing-step-2"` with `style="display:none"`. JavaScript toggles between them. Collect signer data on step 1, display summary on step 2, submit on step 2 confirmation. This is a client-side only change — the backend endpoint is unchanged.

---

## Implementation Order

Do these in sequence. Each builds on the previous.

```
Step 1: global.css additions
        (new utility classes, pipeline layout vars, composer styles)

Step 2: AppLayout.astro
        (header improvements — no structural change, just polish)

Step 3: upload.astro
        (drag-and-drop zone, two-step flow, progress feedback)

Step 4: dashboard.astro
        (pipeline three-column layout, card design, empty state)

Step 5: contracts/[id].astro — header + stage indicator
        (header layout, remove redundant status badge)

Step 6: contracts/[id].astro — left column action area
        (state 1 expand-in-place, states 2–5 improvements)

Step 7: contracts/[id].astro — right column thread + composer
        (avatar initials, timestamp, chat composer)

Step 8: contracts/[id].astro — signing gateway wizard
        (two-step wizard inside the existing <details>)
```

---

## What Success Looks Like

After this sprint, a first-time visitor to any page of this app should be able to:

1. **Dashboard**: understand immediately which of their contracts need attention, without reading every row
2. **Upload**: drag their PDF in, name it, and upload — without touching a file picker dialog
3. **Contract draft state**: see exactly what the next step is and understand what will happen when they take it
4. **Contract under-review state**: feel like they are in a conversation, not filling out forms
5. **Signing initiation**: feel the weight of the action — a clear two-step confirmation before anything legal is sent

The test is: show the app to someone who has never seen it. They should be able to figure out what to do on every screen without reading a label.

---

## Logging Protocol (Same as Sprint 1)

Create `PROGRESS.md` at `/home/swarajbari/Projects/GENEAI_POC/plans/ui-revamp/PROGRESS.md`:

```markdown
# UI/UX Revamp — Progress

## Status
- [ ] Step 1 — global.css additions
- [ ] Step 2 — AppLayout header polish
- [ ] Step 3 — upload.astro drag-and-drop
- [ ] Step 4 — dashboard.astro pipeline view
- [ ] Step 5 — [id].astro header
- [ ] Step 6 — [id].astro left column
- [ ] Step 7 — [id].astro right column + composer
- [ ] Step 8 — [id].astro signing wizard

## Log
[TIME] SESSION START
...
```

Update it before and after each step. If the session is interrupted, the next session reads this file and resumes.

After each step, run: `cd /home/swarajbari/Projects/GENEAI_POC/frontend && npx astro check`
After any backend changes: `cd /home/swarajbari/Projects/GENEAI_POC/backend && npx tsc --noEmit`

---

## Environment Note

- `.env` is at `/home/swarajbari/Projects/GENEAI_POC/.env` (project root, not in frontend/ or backend/)
- To start servers: `source /home/swarajbari/Projects/GENEAI_POC/.env`, then `cd frontend && npm run dev` or `cd backend && npm run dev`
- The frontend runs on Cloudflare Workers locally (`wrangler dev`)

---

## Start

1. Check if `PROGRESS.md` exists at `/home/swarajbari/Projects/GENEAI_POC/plans/ui-revamp/PROGRESS.md`
2. If yes — read it, resume from the last incomplete step
3. If no — create it, then begin with Step 1 (global.css additions)
4. Do not ask the user for clarification — everything you need is in this document
