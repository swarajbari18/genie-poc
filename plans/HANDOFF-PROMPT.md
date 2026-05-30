# HANDOFF — Implementing the Genie v2 Spec (orchestrator prompt for a fresh session)

Paste this as the opening instruction to a **fresh Claude Code session** (full context, not a sub-agent). It is written to be self-sufficient: everything needed is in the two spec files plus the live codebase. Your job is to implement the v2 spec **without guessing**, verifying every change against the running app.

---

## 0. Read these first, in full, before touching anything
1. `plans/v2-reduction-and-fixes-spec.md` — the spec. Read top to bottom. **Part E overrides Parts A/B where they conflict.**
2. `approach.md` — canonical architecture (note: the app actually uses **BoldSign**, not Dropbox Sign, despite the doc's wording).
3. This file.

Do not start coding until you have read all three.

## 1. The single most important rule: NEVER GUESS
The previous build cycle failed on quality because agents filled silence with assumptions and verified with `astro check`. You will not repeat that.

- **Verify before you edit.** Every `file:line` in the spec is from 2026-05-30 and the files change as you work. Before editing, re-open the file and confirm the cited code still matches. If it has moved or changed, re-locate it; do not edit by line number on faith.
- **When the spec is silent, ambiguous, or contradicted by the real code: STOP.** Write the question into `plans/PROGRESS-v2.md` (see §4) and surface it to the user. Do **not** approximate, do **not** invent a layout, do **not** pick "something reasonable." A surfaced question costs a minute; a wrong guess costs the user's trust and a re-do.
- If you find yourself writing a comment like "assuming…", that is the signal to stop and ask.

## 2. The verification gate: RUN IT AND LOOK (not `astro check`)
`tsc --noEmit` and `astro check` are necessary but **not sufficient**. They prove it compiles, not that it works. Every item is "done" only when you have:
1. Run the app (see §6) and exercised the **actual user flow** the change touches.
2. Observed the intended user-visible outcome (e.g. "PDF preview renders inline", "dashboard shows three actionability groups", "signing step shows real emails").
3. Captured a **screenshot** of the result and saved/referenced it in the PROGRESS log.

If you cannot run the app or reach the outcome, the item is **not done** — log why and surface it. Do not mark green on a compile.

## 3. Design-review checkpoints (mandatory for subjective screens)
Two items redesign subjective layouts: **E-B3 (dashboard)** and **E-B4 (create)**. For each:
1. Implement to the exact ASCII target in Part E.
2. Run it, screenshot it.
3. **Stop and show the user the screenshot. Get explicit approval before moving on.**
You may have strong taste, but these are the user's product. Do not finalize them solo. (Apply the same courtesy to any other screen where you deviate from the spec's described look.)

## 4. Orchestration model
The user prefers **sequential sub-agents — one at a time, never parallel** (delegating focused implementation work is fine; running several at once is not). You are the orchestrator.

- Maintain **one append-only log**: `plans/PROGRESS-v2.md`. Never rewrite earlier entries. Each entry: timestamp, item id, what was done, how it was verified (which flow + screenshot), and any surfaced questions.
- Delegate one spec item to one sub-agent at a time. When it returns, **you** verify it against the running app (§2) before logging it complete and starting the next.
- A sub-agent that hits an ambiguity must return with the question, not a guess. You then surface it to the user.

## 5. Order of work (from Part D, with the gates)
Do correctness before reduction. Within each, finish-and-verify before starting the next.

1. **A1 / E-A1** — GCS signing. *Unblocks every visual item.* Gate: PDF preview renders inline (screenshot). Needs the user's GCP creds — if absent, STOP and ask the user to provide `GOOGLE_APPLICATION_CREDENTIALS`; do not stub or fake it.
2. **A5** — stable webhook URL (before any live signing demo) + collapse the detail-page request waterfall to one fetch.
3. **A4 / E-A4** — `/versions` auth parity, clean received-contract titles, `nextAction` field + banner.
4. **A3** — identity-email resolution returned from `GET /:id`; signer defaults + display use real emails; contact-picker chips.
5. **B6** — contract detail: remove metadata card + `EMAIL` relay row + Review/Signature toggle; elevate the document; confirm-style signing (infer role, pre-fill real emails). Mechanical; still run-and-look.
6. **E-B3** — dashboard restructure. **Design-review checkpoint.**
7. **E-B4 / B5** — create one-intent-box + extraction endpoint; unify the two front doors. **Design-review checkpoint.**
8. **B9** — branded HTML email templates with a CTA button.
9. **C / B1** — Astro view transitions (kill white flash), targeted SSE, skeletons, toasts, micro-states.
10. **A6** — rehearse the demo through the `review/[token]` page so the AI diff is exercised end-to-end. Verify whether the AI *summary* (the `aiAnalysis.ts` path the webhook logs as a stub) actually runs; if not, wire or trigger it. The visual diff (`DiffViewer`) should already render when a counterparty version exists.

## 6. Environment / how to run
- Backend: `cd backend && npm run dev` → Hono on `:8080` (tsx watch). Needs `.env` (already present) and, for A1, `GOOGLE_APPLICATION_CREDENTIALS`.
- Frontend: `cd frontend && npm run dev` → Astro on `:4321`.
- A project skill may exist for launching the app (check the `/run` and `/verify` skills before hand-rolling). Two-user flows (owner + counterparty) need two sessions/browsers, as the user did on 2026-05-30.
- Type-check: `cd frontend && npx astro check`; `cd backend && npx tsc --noEmit`. Run these too — just never *only* these.

## 7. Scope guardrails (do not exceed)
- **BoldSign branding is OUT OF SCOPE.** Do not white-label the BoldSign field-placement or signer UI. Accepted as POC-appropriate. (You may still align stray "Dropbox Sign" copy in *our* UI/emails to reality, since that's our text — confirm with the user if unsure.)
- **Respect every "Keep" in the spec.** Do not redesign the stage strip, the executed seal, the upload dropzone, the generation progress overlay, the review-page workspace, or the auth/SSE/inbound infrastructure.
- **Do not refactor beyond the item.** Exception: the spec notes `[id].astro` (3,449 lines) may be split into components to make B6 safer — that is allowed *as part of B6*, not as a separate crusade.
- **Git discipline:** work on a branch (not `main`). Commit per completed+verified item with a clear message. Do **not** push or open a PR unless the user asks. End commit messages with the `Co-Authored-By` trailer per repo convention.

## 8. Definition of done (every item)
☐ Spec item implemented as written (Part E wins on conflicts).
☐ `file:line` references re-verified against current code before editing.
☐ App run; the specific user flow exercised; intended outcome observed.
☐ Screenshot captured and referenced in `PROGRESS-v2.md`.
☐ Type-check clean (`astro check` / `tsc`).
☐ Subjective screens (E-B3, E-B4): user approved the screenshot.
☐ Any ambiguity surfaced to the user, not guessed.
☐ Logged in `PROGRESS-v2.md` (append-only).

---

**The one sentence to keep in mind:** the previous cycle shipped a broken PDF viewer and a competitor's branding because it verified "it compiles" and guessed the gaps. You will verify "it works, and I looked," and you will ask instead of guess. That is the entire difference.
