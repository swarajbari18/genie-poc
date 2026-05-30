# Genie POC — v2 Spec: Correctness Fixes + Apple-Style Reduction Pass

**Date:** 2026-05-30
**Author:** review session (Opus) with Swaraj
**Scope:** Two themes, exhaustively. (A) The correctness/infrastructure fixes from the "extra push" list — **excluding BoldSign branding**, which is accepted as POC-appropriate. (B) A screen-by-screen *reduction* pass to move the human interface from "competent enterprise SaaS" toward Apple-grade.
**Status:** Specification only. No code has been changed. Every item cites the real file/line and gives intent + reasoning so it can be implemented or delegated without re-deriving context.

---

## 0. The two north-star principles (these govern every change below)

Everything in Part B is an application of exactly two rules. When in doubt on any screen, apply these:

### Principle 1 — The document is the hero
The user came to handle a *contract*. The contract itself should be the largest, most central, most beautifully-rendered thing on any screen where it's relevant. Metadata, status, and actions are quiet chrome arranged *around* the document, never in front of it. Today the document is a small grey "Could not load preview" box and the screen is dominated by metadata cards and labels. That inversion is the core visual problem.

**Definition — "chrome":** the UI framing around content (labels, cards, toolbars, status pills). Apple minimizes chrome so content dominates ("deference").

### Principle 2 — Turn every *input* into a *confirm*
For each field the UI asks the user to fill, ask: *does the system already know this, or could it?* If yes, pre-fill it and let the user confirm or correct — don't make them author it. The app's current feeling is "fill in the form so the app can work." The target feeling is "the app already did the work — just say yes." Every eliminated or pre-filled field moves it toward Apple.

A useful test for any screen: **count the decisions and the keystrokes the user must make to advance.** Lower is better. Most screens below have 2–4 that can become 0–1.

---

# PART A — Correctness & Infrastructure (the base must be solid before polish)

> Rationale for ordering: a reduction pass on top of a broken PDF viewer is wasted effort. Fix the base, then reduce.

## A1. GCS signed-URL signing — PDF preview/download must work everywhere
**Severity: demo-breaking. Highest priority.**

**Current:** `backend/src/lib/storage.ts:5` constructs the Storage client with only `projectId` and relies on Application Default Credentials (ADC). `generateDownloadSignedUrl` calls `getSignedUrl({ version: 'v4', ... })` (`storage.ts:16`). v4 signing is *cryptographic* — it needs a private key or an IAM signing identity. Local ADC (from `gcloud auth application-default login`) is a **user credential with no private key**, so every call throws `Error: Cannot sign data without 'client_email'` → `GET /download-url` returns 500. Confirmed on every contract load in the logs, and visible in the UI as **"Could not load the PDF preview"** on every page (including the executed contract).

**Change — two parts:**
1. **Make signing work in both environments.**
   - *Local dev:* set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON key (the SA needs `roles/storage.objectAdmin` or at least object read on the bucket). With a real key, `getSignedUrl` has the private key it needs. Document this in `.env.example` and the README.
   - *Cloud Run:* the runtime service account has no exported private key either, so `getSignedUrl` must sign via the IAM API. Grant the Cloud Run SA `roles/iam.serviceAccountTokenCreator` **on itself**, and ensure the `@google-cloud/storage` client is allowed to fall back to `signBlob`. (The library does this automatically when it has no private key but can reach IAM credentials API. Verify with a deployed smoke test.)
   - **Intent:** one code path that signs correctly whether a key file is present (local) or only an IAM identity is (Cloud Run).
2. **Keep the graceful fallback, but it should be rare.** The "Download PDF instead" link (`[id].astro` document section) is a good safety net; it should be the exception, not the default state.

**Reasoning:** This single fix removes the most visible flaw in the entire app. The signing infrastructure already works (BoldSign rendered the same PDF fine); only *our* read path is broken.

**Related cleanup:** `download-url` is currently fetched as a **separate** request on every page load (and 500s). After A1, fold it into A5's single-request collapse.

## A3. Signer email defaults — show real inboxes, never the relay address
**Severity: trust + unnecessary work. (A2 = branding, skipped.)**

**Current:** In `frontend/src/pages/contracts/[id].astro`, `initialSignerRows` is built from `signingSuggestions` (`[id].astro:165`), whose "Counterparty" entry uses `contract.recipientEmail` (`[id].astro:150-151`). For a Genie-to-Genie negotiation, `recipientEmail` is the **service relay address** (e.g. `swarajbari-ovr4x0@mail.usetend.in`) — an inbound-only Postmark address no human reads. So the signing form pre-fills a scary internal address (seen in screenshot 20-17-22), which is why you felt you had to hunt for "the other person's real email."

**Important nuance:** the **backend already resolves this correctly at send time.** `send-for-signature` does "Two-Angle Resolution" (`contracts.ts:731-777`): if the typed email is a service address, it looks it up in `service_emails`, finds the owning user, and sends BoldSign the user's **identity (real Google) email** instead. The relay address can never reach BoldSign (`contracts.ts:772` hard-stops it). So this is **not a correctness bug — it's a display/reduction bug.** The user is shown plumbing and asked to fix something the backend would have fixed anyway.

**Change:**
1. **Resolve identity emails at read time too.** `GET /api/contracts/:id` (`contracts.ts:183`) should return, alongside `recipientEmail`, a `recipientIdentityEmail` (the resolved real email when the recipient is a Genie user). Reuse the same lookup logic as `send-for-signature`.
2. **Frontend uses identity email for signer defaults and for display.** `initialSignerRows` and the header counter (`[id].astro:253`) should show the real email, never `@mail.usetend.in`.
3. **Replace free-text email entry with a picker where possible.** The user said they had to *search* for the counterparty's address. The app already has `/api/contacts` and knows the negotiation counterparty — present them as one-tap chips (the `person-chip` UI already exists, `[id].astro:670`), so the default case is *zero typing*.

**Reasoning:** Direct application of Principle 2. The system knows who signs (you + the counterparty you've been negotiating with) and knows their real emails. The signing step should be a confirm, not a data-entry form.

## A4. Dual-record / "whose turn" clarity + `/versions` 404
**Severity: confusion (it confused even you) + a real 404.**

**Current — three linked issues:**
1. **`/versions` 404 for participants.** `GET /api/contracts/:id/versions` (`contracts.ts:942-949`) is **owner-only** (`eq(contracts.userId, user.id)`). But `GET /api/contracts/:id` grants access to *signers/participants* too (via the `contract_signers` subquery, `contracts.ts:265`). So when the counterparty (a Genie-to-Genie signer) opens the owner's contract, the page loads but `/versions` 404s (confirmed in logs at 14:52–14:54). Inconsistent authorization between two endpoints for the same resource.
2. **Two records, two titles for one negotiation.** When you send, the counterparty gets a **separate** `received` contract (`webhooks.ts:681`), titled from the **raw attachment filename** (`webhooks.ts:686`: `firstAttachment?.filename || subject`). So you see "Mutual NDA with Swaraj bari" and they see "Mutual-NDA-with-Swaraj-bari.pdf" — different titles, two stage strips, for the same deal.
3. **No explicit "whose turn."** Even *you* weren't sure who initiated signing. The detail page never states, for the current viewer, what their single next action is.

**Change:**
1. **Fix `/versions` authorization** to mirror `GET /:id`: allow owner **or** signer/participant. (Add the same `contract_signers` access check.)
2. **Clean the received-contract title at the source.** At `webhooks.ts:686`, derive a human title: prefer the email `subject` with the Genie suffix stripped (the subject was `"Mutual NDA with Swaraj bari — Review Requested"` → split on `" — "` and take the first part); fall back to a cleaned filename (strip extension, replace `-`/`_` with spaces, title-case). Never display a raw `.pdf` filename as a title anywhere.
3. **Add a per-viewer `nextAction` to `GET /:id`** computed on the backend: e.g. `"awaiting_you_sign"`, `"awaiting_them_sign"`, `"awaiting_their_reply"`, `"awaiting_your_review"`, `"none"`. Render it as **one** prominent banner at the top of the detail page ("It's your turn — sign to execute" / "Waiting on Bond to sign"). This replaces ambiguity with a single sentence.
4. **(Optional, larger) Link the two records.** Store a reference between the owner's contract and the counterparty's `received` contract so both sides show the same title and a consistent thread. Note as a follow-up; items 1–3 deliver most of the clarity.

**Reasoning:** Items 1–2 are correctness; item 3 is Principle 2 applied to navigation — the app should *tell* you whose turn it is instead of making you reconstruct it.

## A5. Stable webhook URL + collapse the request waterfall
**Severity: fragility + perceived slowness.**

**Current:**
1. **Stale tunnel.** Your first `send-for-signature` failed because the BoldSign webhook pointed at an **old cloudflared tunnel URL** (your note; logs show the retry at 14:50). Ephemeral tunnels rotate their hostname on restart — a demo landmine.
2. **Sequential request waterfall.** Every detail-page load fires, in series: `get-session` → `GET /contracts/:id` → `GET /contacts` → `GET /contracts/:id/versions` → `GET /download-url` → `GET /events` (logs show 300–1000 ms each, ~3–4 s total). The backend already returns contract+threads+signers in **one** SQL query (`contracts.ts:187-302`), but the frontend then makes 3 more round-trips anyway, undoing that win.

**Change:**
1. **Pin the public base URL.** Use a *named* cloudflared tunnel (stable hostname) or a config'd `PUBLIC_BASE_URL`, registered with BoldSign once. On boot, **fail loudly** if the configured webhook host is unreachable/unset, so a stale URL is caught before a demo, not during one.
2. **One request per page.** Extend `GET /contracts/:id` to also return `versions` and (after A1) a short-lived `documentUrl`, so the detail page needs a single fetch. `/contacts` can be fetched lazily only when the signer picker opens. Target: contract detail renders from **1** round-trip, not 4.

**Reasoning:** Reliability for the demo; and Principle 1/feel — a page that paints in one hop feels instant, four sequential hops feel like a government portal.

## A6. Demo must exercise the AI diff (your headline feature)
**Severity: missed opportunity.**

**Current:** In your run, the counterparty replied via the **in-app composer with text only** ("its fine proceed") — no revised document — so no counterparty version was created and the **colour-coded diff never appeared.** Worse, the inbound webhook logs say `AI pipeline stub — not yet implemented` even when an attachment was present (`webhooks.ts`). Meanwhile your *best* surface — `review/[token].astro` (edit + AI assistant + Preview-changes diff) — was never opened.

**Change (process, not code — but verify code):**
1. **Script the demo** so the counterparty opens the emailed **review link** (`/review/:token`), edits the contract (or uses the AI assistant to make a change), and clicks "Send changes back." That creates a counterparty version → triggers `showVersionDiff` (`[id].astro:77`) → the `DiffViewer` renders the git-style diff on the owner's page. This is the moment that proves the product.
2. **Verify what's actually wired.** The *visual* diff is computed client-side by `DiffViewer` from two version texts and should work whenever a counterparty version exists. The **AI plain-English summary** is the part the webhook log flags as a stub — confirm whether `aiAnalysis.ts` runs on inbound, and if not, wire it (or trigger on read). Don't demo a feature whose summary half is stubbed without knowing.

**Reasoning:** The diff is the differentiator vs "email + DocuSign." A demo that doesn't show it is selling the product short.

---

# PART B — Reduction pass, screen by screen

Format per item — **Cut / Pre-fill / Keep**, with the *why*. "Cut" = remove or hide. "Pre-fill" = the system supplies it; user confirms. "Keep" = already right, do not touch.

## B1. Global shell — `AppLayout.astro`
- **Keep:** the header is clean (wordmark + username + Sign out). Good.
- **Pre-fill/feel:** add **Astro View Transitions** so navigation cross-fades instead of white-flashing. The white flash between every page is the single loudest "hobby project" signal and is ~10 lines to fix globally.
- **Cut (minor):** the bare username text → a small avatar with a menu (Sign out lives inside). Lower priority; reduces header noise.

## B2. Landing — `index.astro`
- **Keep:** minimal, centered, single CTA ("Continue with Google"). This page is already close to Apple.
- **Fix copy:** the subtitle "Send, track, and analyse legal contracts with precision" omits the destination — **signing**, which `approach.md` calls "the point of the whole product." One line that names the whole arc: *"From draft to signed, without leaving one place."* Intent: the first sentence a Genie reviewer reads should state the wedge.

## B3. Dashboard — `dashboard.astro` (biggest reduction target)
The dashboard currently offers **four competing ways to view the same contracts** on one screen: `WORKSPACE / All contracts` (sidebar), `PROJECTS` (sidebar, `:153`), `ASSETS` (horizontal thumbnails, `:246`), and `IN PROGRESS` (process list, `:270`). A new user must learn your filing model before doing anything. Apple gives **one** organizing principle and **one** obvious primary action.

- **Cut — the dual representation.** Every contract appears **twice**: once as a static "asset" thumbnail and again (if active) as an "in progress" row. Two renderings of one object is pure cognitive tax. **Pick one.** Recommended: lead with the action-oriented list and drop the assets row (or make assets the *only* view and fold status into it). Don't show both.
- **Reframe the primary axis from "filing" to "what do I need to do?"** The dashboard should answer that question first. Group by **actionability**, not by project: *Needs you* (replied / received / awaiting-your-signature) → *Waiting on others* (sent / out-for-signature) → *Done* (executed). Your `urgency()` and `statusProse()` helpers (`dashboard.astro:36-95`) already compute exactly this — promote it to the primary structure. Projects become a *filter*, not a parallel layout.
- **Cut — creation entry-point sprawl.** There are at least four: `+ New project`, `+ Contract` (per project header), `+ New` (asset card), `Create a contract` (empty state). Reduce to **one** unmistakable primary "New contract" action; everything else is secondary.
- **Pre-fill — real thumbnails.** Once A1 lands, render the contract's **first page** as the thumbnail instead of a generic file glyph (`dashboard.astro:252`). Principle 1: even in a list, the document is the hero.
- **Fix — titles.** Mixed clean titles and `filename.pdf` (from A4). Resolve at source.
- **Feel — SSE.** `dashboard.astro:459` does `location.reload()` on **every** event (full white reload). Replace with a targeted DOM update of the affected card (the redesign claimed this was done; this file still reloads).
- **Keep:** the "needs your signature" pulse strip (`:184`), the empty state, the demo-seed banner (useful for the demo; already gated to empty/no-projects).

## B4. Create contract — `create.astro` (the "government form" surface)
This is the screen that gives the "old man / form" vibe: five labeled fields (Title*, Type, Your party name*, Counterparty name*, Additional details, Add to project) before anything happens.

- **Pre-fill / Cut — collapse five inputs into one intent box.** The app calls Gemini to *generate* the contract anyway (`POST /api/generate`). Gemini can extract title, type, and parties from a single sentence. So lead with **one** natural-language field: *"Describe the contract you need — e.g. 'Mutual NDA with Acme Corp, mutual, Delaware law.'"* Derive Title (editable later), Type, and Party names from it. Keep an "Advanced" disclosure for anyone who wants the explicit fields, collapsed by default.
- **Pre-fill — your own party.** "Your party name" is the signed-in user; default it (already does, `:73`) and hide it unless edited.
- **Keep:** the generation progress overlay with cycling messages (`:116-128`, `:265-298`) — that's a genuinely nice touch; the 20 s wait is well-handled.
- **Reasoning:** don't make the human pre-structure what the AI will structure. Capturing *intent* in one box, then letting AI fill the form, is the Apple move.

## B5. Upload existing — `upload.astro`
- **Keep:** the dropzone with empty/dragover/selected states, the file chip, the auto-derived title, the fake-progress bar (`upload.astro:33-77`). This page is already good — it's proof you can hit the bar; the rest of the app should match *this* page's quality.
- **Cut — the two-front-doors problem.** "Create with AI" (`create.astro`) and "Upload existing" (`upload.astro`) are two separate entry pages reached differently. Unify under one "New contract" that offers two clear paths (*Generate with AI* / *Upload a PDF*). One decision, clearly framed, beats two hidden doors.

## B6. Contract detail — `contracts/[id].astro` (3,449 lines; the heart of the app)
This page carries the most chrome and the most plumbing. Several cuts:

- **Cut — the metadata card duplicates the header.** The block labeled `CONTRACT / RECIPIENT / EMAIL / ORIGINAL PDF` repeats the title and counterparty already shown in `page-header` (`[id].astro:236-260`). Remove the card; the header already conveys identity. Uppercase schema-style labels are an engineer's view of a database row, not human language.
- **Cut — the `EMAIL: …@mail.usetend.in` row.** That's internal plumbing (the relay address). Users must never see it. (Ties to A3.)
- **Pre-fill — the header counter shows the relay email** (`:253`). Show the person's **name** (and real email if needed), never the relay.
- **Elevate — make the document the hero (Principle 1).** Today the preview is a small box *below* the metadata. After A1, the rendered first page should be the **largest element** on the page, centered, with status/actions as quiet rails around it.
- **Cut — the Review/Signature toggle.** `[id].astro:636-639` shows two `send-mode` buttons (Review / Signature) as if they're parallel choices. Your own model is **sequential**. Show **one** stage-appropriate action: draft → "Send for review"; replied/negotiating → "Send for signature." A toggle says "pick one of two"; a journey says "do the next thing." Removing it also kills the last remnant of the old "two-buttons" confusion.
- **Signing wizard — turn input into confirm.**
  - **Pre-fill** signer rows with **real identity emails** (A3), not relay addresses.
  - **Cut the role dropdown** (`[id].astro:659-663`, Creator/Counterparty/Other). "Role" is jargon a normal user neither knows nor cares about. Infer it: signer #1 = you, the rest = the counterpart(ies) you negotiated with. Expose role only in an advanced view if ever needed.
  - **Collapse to a confirm.** Default state should read: *"Send for signature to **you** and **Bond (bond@gmail.com)**? [Send]"* with a small "edit signers" link. Two-thirds of users will never edit. The current two-step wizard (steps 1+2) becomes one confirm screen when the roster is pre-resolved.
- **Clean the activity thread.** Bubbles render the raw plain-text email body, including boilerplate ("— Sent via Genie AI on behalf of…", "Reply to this email to continue the discussion") and a **raw review URL** (screenshots 20-16-18/30). Strip the boilerplate from the displayed bubble and render the review link as a **button**, not a naked URL. (Best fixed together with B9 — HTML emails.)
- **Add the `nextAction` banner** (A4 item 3): one sentence at the top stating the viewer's single next step.
- **Keep:** the 5-stage strip (`:90-98`, `:263`) — calm and clear, genuinely Apple-ish; the executed green seal; the directive under-review banner.
- **Structural note (not user-facing):** 3,449 lines of markup+CSS+JS in one file makes this exact polish work slow and error-prone (it's how the `display:flex`-vs-`[hidden]` wizard bug slipped in). Consider extracting the signing wizard, the thread, and the document panel into components. Not required for the demo, but it's why iteration feels heavy.

## B7. Counterparty review — `review/[token].astro`
- **Keep, and feature it.** This is your strongest surface: a two-panel workspace (`:94`) with an Edit/Preview-changes diff tab (`:99-113`) and an **AI Assistant** that edits the contract on request (`:117-125`). It's the proof of "negotiate + AI diff" in one place.
- **Pre-fill — guide the AI panel.** The empty state should suggest concrete prompts (*"Try: 'change governing law to Delaware'"*, *"'shorten the term to 1 year'"*) so a first-time counterparty knows what the assistant can do. An empty chat box is an input; a suggested prompt is a confirm.
- **Demo:** this is the screen A6 routes the counterparty through.

## B8. Signing redirect — `sign/[token].astro`
- Full-viewport BoldSign iframe (`:34-39`). Branding is **out of scope** per your decision. **Keep** as-is, with one note: the loading state between page open and iframe paint should show a spinner/skeleton (the CSS for `.sign-spinner` exists at `:139` but isn't mounted in the `signUrl` branch) so it isn't a blank flash.

## B9. Email templates — `postmarkClient.ts`
- **Upgrade — plain text → branded HTML.** Every send uses `TextBody` only (`postmarkClient.ts:49,140,183,226`); there's no `HtmlBody`. That's why the thread and the recipient's inbox show "---" separators and raw `http://localhost:4321/review/…` URLs. Emails are a **visible part of this product's flow** (the whole pitch is "it sends the email for you"), so a plain-text system notification undercuts it.
- **Change:** add branded `HtmlBody` templates with the Genie wordmark, a one-line context sentence, and a **CTA button** ("Review & propose changes" / "Review & sign") instead of a pasted URL. Keep the plain-text part as the fallback.
- **Reasoning:** Principle 1 extends to email — the thing the recipient acts on (the button) should be the hero of the message, not buried in boilerplate.

---

# PART C — Cross-cutting interaction & feel

These aren't single screens; they're the texture that separates "honest try" from "extraordinary."

1. **View transitions** (B1) — kill the white flash app-wide.
2. **One request per page** (A5) — instant paint instead of a 4-hop waterfall.
3. **Targeted SSE updates** (B3) — live changes update the one card/row, never a full reload.
4. **Skeletons that match final layout** — present in some states; ensure every async surface (dashboard list, detail document, signer roster) has one, so there are no blank/jumping frames.
5. **Toasts for ephemeral feedback** — "Sent for review," "Changes sent back," "Contract executed" — instead of relying only on inline text or silent state changes.
6. **Micro-states** — button press/disabled→enabled transitions on the composer and CTAs; the small motion that makes a UI feel responsive.

---

# PART D — Suggested sequencing

Do correctness first (a reduction pass on a broken base is wasted), then the highest-visibility reductions, then feel.

1. **A1** — GCS signing (unblocks the document-as-hero everywhere). *Must be first.*
2. **A5** — stable webhook URL (before any further live demos) + request-collapse.
3. **A4** — `/versions` auth fix, clean titles, `nextAction` banner.
4. **A3** — identity-email resolution + signer picker.
5. **B6** — contract detail: kill metadata card + EMAIL row + Review/Signature toggle; elevate document; confirm-style signing.
6. **B3** — dashboard: collapse to one organizing axis + real thumbnails + targeted SSE.
7. **B4 / B5** — create-as-one-intent-box; unify the two front doors.
8. **B9** — HTML emails.
9. **C / B1** — view transitions, toasts, skeletons, micro-states.
10. **A6** — rehearse the demo through the review page so the AI diff is the centerpiece.

**One-line summary of the whole spec:** the base has two genuine bugs (PDF signing, `/versions` auth) and one fragility (webhook URL); everything else is *reduction* — on every screen, delete or pre-fill 2–3 things, show the document bigger, and turn forms into confirms. That pass is what crosses it from enterprise-SaaS to Apple.

---

# PART E — Gap closures (authoritative; resolves the judgment items a fresh agent would otherwise guess)

> This section was added after the spec was reviewed for "what would a fresh implementer have to invent?" The four items below (A1, A4, B3, B4) carried decisions, not just mechanics. Where Part E conflicts with Parts A/B above, **Part E wins.** It also marks the screens that REQUIRE a user design-review checkpoint before they are considered done (see HANDOFF-PROMPT.md).

## E-A1. GCS signing — exact mechanism (both environments)

The problem is environmental, so the fix is mostly configuration + documentation, with a small code hardening. Do **not** change the bucket to public or abandon v4 signed URLs — the private-bucket model is correct.

**Why it fails today:** v4 `getSignedUrl` needs signing material. `gcloud auth application-default login` produces a **user** credential (no private key, can't call IAM signBlob) → `Cannot sign data without client_email`. Cloud Run's ADC is a **service account** (can call signBlob *if* permitted).

**Exact changes:**
1. **Local dev:** obtain a service-account JSON key (an SA with object read on the bucket), and set `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/key.json`. The `@google-cloud/storage` client auto-detects this env var and uses the key's private key to sign — no code change needed for local once the key is present. Add `GOOGLE_APPLICATION_CREDENTIALS=` (with a comment) to `.env.example`.
2. **Cloud Run:** grant the runtime service account `roles/iam.serviceAccountTokenCreator` **on itself**. With no key file present, `getSignedUrl` falls back to the IAM `signBlob` API, which this role authorizes. (Document this in `07-backend-fixes`-style notes or the README deploy section.)
3. **Code hardening in `backend/src/lib/storage.ts`:** wrap `getSignedUrl` so a signing failure logs a single clear line (`"GCS signing failed — set GOOGLE_APPLICATION_CREDENTIALS (local) or grant tokenCreator (Cloud Run)"`) and rethrows a typed error the route can turn into a clean 503 (not a raw 500). Keep the UI "Download PDF instead" fallback as the last resort.

**Definition of done (experiential gate):** with creds configured, open a contract detail page → the **PDF preview renders inline** (no "Could not load preview"). Screenshot it. Also confirm `download-url` returns 200 in the backend log.

**Do NOT** mark done on `tsc` passing — this bug type-checks fine today.

## E-A4. `nextAction` — exact enum, computation, and rendering

**Add to the `GET /api/contracts/:id` response** a `nextAction` field, computed server-side in `contracts.ts` (the same handler at `:183`). The enum and the viewer-aware mapping:

```ts
type NextAction =
  | 'awaiting_your_review'   // you must act: a contract you received, or counterparty replied with changes
  | 'awaiting_their_reply'   // you sent; waiting on the counterparty
  | 'ready_to_send_signature'// review complete; you (owner) can start signing
  | 'awaiting_you_sign'      // you are a signer who hasn't signed yet
  | 'awaiting_them_sign'     // out for signature; waiting on other signers
  | 'executed'               // fully signed
  | 'declined'               // declined
  | 'none'                   // draft, or nothing actionable
```

**Computation inputs:** `contract.status`, `contract.origin` (`'received'` vs owner-created), whether `currentUserId === contract.userId` (owner) vs appears in `signers` with a non-signed status, and the aggregate signer states already in the query (`contracts.ts:246-257`).

**Mapping (apply first match):**
| Condition | nextAction |
|---|---|
| status `draft` | `none` |
| status `sent`/`ai_processing`, you are owner | `awaiting_their_reply` |
| origin `received` AND status in {received, replied, negotiating} | `awaiting_your_review` |
| status `replied`/`negotiating`, you are owner | `ready_to_send_signature` |
| status in {out_for_signature, partially_signed} AND you are a signer with status≠signed | `awaiting_you_sign` |
| status in {out_for_signature, partially_signed} otherwise | `awaiting_them_sign` |
| status in {signed, completed} | `executed` |
| status `declined` | `declined` |
| else | `none` |

**Render:** one banner at the very top of `[id].astro` main column (above the document), only when `nextAction !== 'none'`. Copy + single CTA per value:
- `awaiting_your_review` → "It's your turn — review the proposed changes." · [Review changes] (scrolls to diff/thread)
- `awaiting_their_reply` → "Sent. Waiting on {firstName} to reply." · (no CTA, muted)
- `ready_to_send_signature` → "Review complete. Ready to send for signature." · [Send for signature]
- `awaiting_you_sign` → "It's your turn — sign to execute." · [Sign now]
- `awaiting_them_sign` → "Waiting on {remaining} to sign." · (muted)
- `executed` → "Executed. All parties have signed." · [Download executed PDF]
- `declined` → "{firstName} declined. You can revise and resend." · [Reply]

This single banner is the "whose turn" fix. It replaces ambiguity with one sentence and at most one action.

**Also in A4 (unchanged from Part A, restated for completeness):** fix `/versions` auth to allow owner OR signer (mirror `:265`); clean received-contract title at `webhooks.ts:686` (prefer `subject.split(' — ')[0]`, else title-cased filename sans extension).

## E-B3. Dashboard — exact target layout (REQUIRES design-review checkpoint)

Reorganize from "filing" (Projects/Assets) to "actionability." Single primary axis. Projects demote to a filter dropdown. One creation entry. Real first-page thumbnails (post-A1).

```
┌ Genie AI ─────────────────────────────────── Swaraj ▾ ┐
├───────────────────────────────────────────────────────┤
│  [ + New contract ]                     All projects ▾ │   ← one CTA, projects = filter
│                                                         │
│  NEEDS YOU  (2)                                         │   ← awaitingMySignature + replied/received/negotiating
│  ┌─────────────────────────────────────────────────┐  │
│  │ [pg1 thumb]  Mutual NDA — Acme                    │  │
│  │              Bond proposed changes · 3m   [Review→]│  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │ [pg1 thumb]  Services Agreement                   │  │
│  │              Your signature needed · 1d    [Sign→] │  │
│  └─────────────────────────────────────────────────┘  │
│                                                         │
│  WAITING ON OTHERS  (3)                                 │   ← sent / out_for_signature (lighter weight)
│  · DVLPB 2026        awaiting signatures · 1d   Track→  │
│  · Mutual NDA        waiting on Bond · 6m       View →  │
│                                                         │
│  DONE  (5)  ▸                                           │   ← executed; collapsed by default
└─────────────────────────────────────────────────────────┘
```

Rules:
- Three groups, in this order: **Needs you** → **Waiting on others** → **Done** (collapsed). Reuse `urgency()`/`statusProse()`/`cta()` (`dashboard.astro:36-95`) to assign group + label + CTA.
- **Remove the dual representation:** no separate "Assets" thumbnail row *and* "In progress" row for the same contract. One card per contract, in exactly one group.
- **Projects become a filter** (`All projects ▾` dropdown), not a sidebar of parallel layouts. The sidebar (`:138-178`) collapses into the filter.
- **One creation entry:** a single `+ New contract` (routes to the unified entry from E-B4/B5). Remove `+ New project` from the primary surface (move into the project filter menu), remove the per-project `+ Contract` and the `+ New` asset card.
- **Thumbnails:** render contract page 1 (post-A1); generic glyph only as fallback.
- **SSE:** targeted card update, not `location.reload()` (`:459`).

**Checkpoint:** build this, run it, screenshot it, and get Swaraj's approval *before* moving to the next item. This is a subjective layout — do not finalize on your own taste.

## E-B4. Create — exact one-intent-box flow + the backend extraction it needs (REQUIRES design-review checkpoint)

`/api/generate` today **requires** structured `title`, `partyA`, `partyB` and 400s without them (`generate.ts:19-22`). So "one intent box" needs a new extraction step; do not just hide the fields or the endpoint will reject the request.

**Frontend (`create.astro`):**
```
New contract
┌────────────────────────────────────────────────┐
│ Describe the contract you need                  │
│ ┌────────────────────────────────────────────┐ │
│ │ Mutual NDA with Acme Corp, mutual,          │ │
│ │ Delaware law, 2-year term…                  │ │
│ └────────────────────────────────────────────┘ │
│                                                  │
│ ▸ Advanced — title, type, parties, project       │  ← collapsed; auto-filled after extract, editable
│                                                  │
│ [ Generate contract ]   Cancel                   │
└────────────────────────────────────────────────┘
```
- Primary input is one freeform textarea. The existing five fields move into a collapsed "Advanced" disclosure, pre-filled by the extraction result, fully editable.
- Keep the generation progress overlay (`create.astro:116-128`) — it's good.

**Backend (new, minimal):** add `POST /api/generate/extract` (or an `extract` branch on generate) that runs **one fast Gemini call** returning strict JSON:
```json
{ "title": "...", "contractType": "...", "partyA": "...", "partyB": "..." }
```
Inputs: the freeform text + the signed-in user's name (hint for `partyA`). Constrain `contractType` to the existing dropdown's allowed values (`create.astro:57-65`); default to NDA if unclear. Then the frontend calls the **unchanged** `/api/generate` with those fields (so the existing required-field validation and prompt at `generate.ts:36` keep working). This adds extraction *in front of* the proven path; it does not modify the generation itself.

**Flow:** submit freeform → `extract` → fields populate the Advanced panel (visible for a beat / editable) → `generate` → open contract. If extraction fails, reveal the Advanced fields pre-filled with best-effort and let the user complete them (graceful degrade, never a dead end).

**Checkpoint:** subjective surface — build, run, screenshot, get Swaraj's approval before proceeding.

**Also (E-B5 restated):** unify the two front doors. The single `+ New contract` lands on a small chooser — *Generate with AI* (this page) or *Upload a PDF* (`upload.astro`, already good) — so there is one entry with two clear paths, not two hidden pages.
