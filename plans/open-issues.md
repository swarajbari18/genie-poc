# Genie AI — Open Issues / Design Gaps

These are known gaps identified during end-to-end testing. Each needs a dedicated brainstorm and design decision before implementation.

> **Status (2026-05-26):** Both issues now have agreed designs and are scheduled as components in `approach.md` (Component 7 for Issue 1, Component 6 for Issue 2). A new Component 5 (In-Thread Reply / Negotiation Loop) was inserted ahead of both, which is why these numbers shifted up by one. Decisions are recorded under each issue below. Neither is implemented yet.

---

## Issue 1: Intra-domain recipient has no inbox

**What the gap is:**
Every email sent to any address at `mail.usetend.in` is routed to Postmark's inbound processor via the MX record. There is no traditional inbox at that domain. If a Genie user sends a contract to another Genie user (whose service address is also at `mail.usetend.in`), the recipient has no place to read or even see that email. It lands in Postmark inbound, fires the webhook, and disappears into processing — never surfacing to the recipient as a readable message.

**Why this matters:**
Recipients are assumed to be external (Gmail, corporate email, etc.) in the current design. But as Genie grows, users on the same platform will send contracts to each other. An intra-platform send where the recipient cannot read the email is a broken flow.

**What needs to be designed:**
Genie needs an in-app inbox or notification surface for recipients on `mail.usetend.in`. When the inbound webhook processes an email addressed to a Genie user, it should surface that message inside the app for the recipient — not just process it as a reply thread entry on the sender's side. This is essentially an in-app messaging layer for intra-domain sends.

**Questions to answer in brainstorm:**
- Do we show a dedicated "Received Contracts" section in the dashboard for intra-domain sends?
- Does the recipient get a real-time notification inside the app?
- Does the current webhook handler need to distinguish between inbound-from-external vs inbound-from-another-genie-user?
- Should we decouple service addresses from the `mail.usetend.in` domain eventually to allow real inboxes?

**DECISION (2026-05-26) — full in-app inbox, modeled by reusing `contracts`:**
- Build a real in-app inbox. The recipient sees a dedicated "Received" group on the dashboard.
- **No new table.** Add `origin` enum (`created`|`received`) + a `received` status to the existing `contracts` table. A received contract becomes a first-class `contracts` row owned by the recipient, so the thread view, live SSE updates, and future AI analysis all work on it for free. Rejected a separate `received_contracts` table because it would duplicate status/thread/AI logic.
- `recipient_name`/`recipient_email` always hold the *counterparty* — for a `received` contract that is the sender.
- The webhook distinguishes reply vs new received contract by whether `In-Reply-To` matches one of *that user's* outbound threads. No match + address resolves to a Genie user → received-contract path.
- Recipient gets a real-time notification via the same SSE channel as Issue 2.
- Decoupling service addresses from `mail.usetend.in` to allow real inboxes is out of POC scope.
- **Scheduled as Component 7** in `approach.md`.

---

## Issue 2: Dashboard status update is manual (should be automatic)

**What the gap is:**
The implementation notes currently say: "Reply to the email, refresh the dashboard after 20 seconds, status should be 'replied'." This is a manual refresh. The entire backend is event-driven — Postmark fires a webhook, the backend processes it and updates the contract status in the database. But nothing tells the browser that the data has changed. The user has to manually reload to see the new status.

**Why this matters:**
A manual refresh instruction in a webhook-driven system is a placeholder, not a design. The value of the event-based architecture is that the UI reflects reality in near-real time. Making the user wait and then manually refresh defeats the purpose, especially in a demo context where the flow needs to feel live.

**What needs to be designed:**
The frontend needs a mechanism to detect that the contract status changed and re-render without a manual reload. Three approaches to evaluate:

- **Client-side polling:** The contract detail page polls `GET /api/contracts/:id` every few seconds while status is `sent`. Simple to implement in Astro with a `setInterval` in a script block. No new infrastructure. Works but is slightly wasteful.
- **Server-Sent Events (SSE):** The backend opens a long-lived HTTP connection and pushes an event when the status changes. The browser listens and triggers a re-render. More efficient than polling, no WebSocket complexity. Hono supports SSE natively.
- **WebSockets:** Full duplex. Overkill for a status update that happens once per contract lifecycle.

**Questions to answer in brainstorm:**
- Which mechanism fits the current Astro SSR + Hono stack with least added complexity?
- Should the polling/push only activate when the contract is in `sent` state (awaiting reply)?
- Does this belong in the contract detail page only, or also in the dashboard list?

**DECISION (2026-05-26) — SSE backed by Postgres `LISTEN`/`NOTIFY`:**
- Mechanism: **SSE**, with `LISTEN`/`NOTIFY` as the cross-instance event bus. The hard part on Cloud Run is that the webhook and the SSE connection can land on different instances (separate process memory); an in-memory emitter alone wouldn't reach across. Postgres — which every instance already connects to — is the shared meeting point. Rejected: pin-to-one-instance (no scaling, drops streams on restart) and SSE-that-polls-the-DB (polling in disguise, undercuts the event-driven story).
- Each instance opens one dedicated `LISTEN` connection on boot; `GET /api/events` streams to the logged-in user, filtered by their channel.
- **Scale-to-zero stays ON.** An open SSE connection keeps an instance alive; with no dashboard open, the backend scales to zero and the next page load reads current state from the DB.
- **Principle:** the DB is the source of truth; `NOTIFY` is liveness only (fire-and-forget, not durable). The client refetches current state on every (re)connect, so a dropped push is invisible.
- Applies to both the dashboard list and the contract detail page.
- **Scheduled as Component 6** in `approach.md`.
