# Genie AI POC — Send, Negotiate, Sign
## Product Approach and Build Plan

**Last updated:** 2026-05-26
**Status:** Current. This document reflects the architecture actually being built. There is no Gmail API and no Pub/Sub. **The product's purpose is signing** — carrying a finished contract through review/negotiation to a legally captured signature from every party. Everything else (the per-user service address, the send pipeline, inbound capture, the negotiation loop, live updates, the AI diff) exists to support that one outcome: a fully executed contract. E-signature is delivered with the **Dropbox Sign API** (see Component 8 and the Signing Flow). An earlier rewrite wrongly bucketed Dropbox Sign with the genuinely-scrapped Gmail/Pub/Sub work and deferred it; that was a scoping error and is corrected here — signing is the headline deliverable, not a deferred extra.

> A short changelog lives at the very bottom of this file. Read top-to-bottom; nothing here is historical-only.

---

## The Problem

### Who has this problem

Anyone who uses Genie AI — or any contract drafting tool — to create a contract. Founders, freelancers, sales teams, procurement teams. Any business person who deals with contracts regularly but does not have a dedicated legal team running the process for them.

### What their day actually looks like

They have just finished drafting a contract. The document is ready. Now the real work begins — getting the other person to review it, agree to it, **and get every required party to sign it**. This entire phase has no tool helping them.

1. They download the contract, open Gmail, write an email by hand, attach the file, and send it.
2. The other person replies — comments in the email body, or an edited file as a new attachment. Now two versions float around one thread. Nobody knows which is current.
3. This repeats for days. Version 1, Version 2, Version 3. The email thread becomes the only record of what changed and when.
4. **Once both sides finally agree, signing is its own separate ordeal.** They download the final PDF, upload it into a *different* product (DocuSign / Dropbox Sign) by hand, type in every signer's email, set who signs first, send it, and then babysit it — refreshing to see who has signed, chasing the ones who haven't, and finally downloading the executed copy. The signer on the other end is forced to create an account or fight a clunky flow just to put their name on a page.

### What goes wrong

Contracts get lost across threads. The wrong version gets treated as final. **Worst of all, the moment that actually matters — signing — lives in a completely separate tool, disconnected from the negotiation that produced the document.** Nobody knows, in one place, "what changed, who agreed, and who has signed." A process that should be professional becomes chaos managed through Gmail, a downloads folder, and a second signing app glued on at the end.

---

## What We Are Building

A workflow app that takes over from the moment the contract is ready and carries it all the way to a fully executed, signed document. The stages, with **Sign** as the destination everything leads to:

**Send.** The user uploads a finished PDF and picks a recipient. The app sends the email via Postmark from the user's dedicated service address (e.g. `alice-x7k2@mail.usetend.in`). No Gmail access. No manual email writing.

**Receive.** Replies are captured automatically. The recipient's reply lands at the service address, whose MX record points at Postmark inbound; Postmark parses it (including attachments as base64) and POSTs it to our webhook. The reply — text and any attached document — surfaces in the contract thread. When the recipient is *also* a Genie user, the contract shows up in their in-app inbox as a received contract (see "Intra-domain inbox" below).

**Negotiate.** The conversation is multi-round, not one-shot. After a reply arrives, the user can counter from inside the app — a written response plus, optionally, their own revised version of the document — and the counterparty can reply again, for as many rounds as the negotiation needs. Every round threads correctly and preserves its document version (see "Reply / Negotiation Flow").

**See what changed (AI diff).** When a counterparty returns a modified document, the app shows a **git-style, colour-coded diff** of exactly what changed — additions in green, deletions in red, the way GitHub/VS Code show a code diff — computed by a deterministic algorithm with **no LLM** (the same way `git diff` works). A single optional LLM call then writes a plain-English summary *on top of* that computed diff. This is what lets a human decide "do I accept this and sign, or counter again?" (see Component 9 and the Diff Architecture).

**Sign (the point of the whole product).** Once the parties agree on a version, the user sends it for signature. We create a **Dropbox Sign** signature request with one or more signers in a defined order. Each signer — whether or not they use Genie, and **without creating any account** — gets an email with a secure link, opens it, reads the contract, and signs directly on Dropbox Sign's hosted page. They never reply to us: **Dropbox Sign fires a webhook to our backend** as each party views and signs, and we surface those events live on the contract thread ("Counterparty signed", "Awaiting your boss's signature"). When **every** party has signed, a final webhook tells us the executed PDF is ready; we pull it into storage and mark the contract `signed`. If a signer wants changes instead, they decline and the parties drop back into the negotiation loop above, then re-send for signature on the agreed version.

**Interact (live).** The dashboard and contract pages update in near-real time when a reply arrives or a signing event fires — no manual refresh. This is delivered with Server-Sent Events backed by Postgres `LISTEN`/`NOTIFY` (see "Live Updates Architecture").

### What we are NOT building in the POC

- Gmail integration of any kind (no `gmail.send`, no `gmail.readonly`, no Pub/Sub)
- **Embedded** signing (the in-iframe Dropbox Sign flow). We use the **email-link** signature flow instead — see the Signing Flow for why (embedded needs an approved API App + `client_id`, the `hellosign-embedded` JS, and domain whitelisting; email-link needs none of that and delivers the same outcome via webhooks).
- Outlook integration
- A dedicated version-history browser UI (multi-round replies and per-round documents *are* in scope — see Component 5 — but a side-by-side "compare any two arbitrary versions" browser is not; the diff is always new-vs-previous)
- Actual reminder push notifications (the dashboard is the notification surface; Dropbox Sign's own automatic signer reminders are left on)
- Mobile app
- Admin / team / org accounts
- Payment / billing

> **In scope and central:** **multi-party signing** (2, 3, or 4 parties, with signing order) and **signers who are not Genie users** (no account required). These are core to the signing story, not deferred.

---

## Engineering Principles

These are not style preferences. Each one prevents a class of bug or performance problem that would otherwise surface during the build or the demo. Read the reasoning, not just the rule.

### 1. Compute lives as close to the data as possible

The question to ask before writing any logic: which layer already holds the data this logic needs? Logic that runs where its data lives is cheaper, faster, and simpler than logic that ships data elsewhere to process it.

**Average approach:** fetch all contracts as a flat array, then sort/group in JavaScript before rendering.

**Problem:** every row crosses the network; the client burns CPU sorting; a grouping bug shows up at render time, not in a query you can test.

**What we do:** the SQL query computes a `sort_group` integer with a `CASE` expression and returns rows already in display order. The frontend iterates once and inserts a section header whenever `sort_group` changes. No JavaScript sorting, no grouping.

**The rule:** every API response must be directly renderable by the receiving component without transformation. If a component has to filter, sort, or group, the endpoint did not finish its job.

### 2. One database round trip per user action

Every query costs a connection acquisition, a network hop to Neon, execution, a hop back, and a release. The goal is to minimize how many times the backend asks the database a question per request — not lines of SQL.

**What we do:** the contract-detail page is a single query with `LEFT JOIN` + `json_agg()` that returns the contract row plus its full thread as one typed JSON array. The dashboard is a single query with a computed `sort_group`. (See "Key Queries".)

### 3. Authentication lives in the backend and only in the backend

Authentication is the decision about whether a request may proceed. It must be made by the layer that owns the protected resources — the backend, where contract files and sessions live.

- **HttpOnly cookie, not localStorage.** Define *HttpOnly*: a cookie the browser never exposes to JavaScript (`document.cookie` returns empty for it). It attaches to every request automatically and is readable only by the server. This removes the entire class of XSS-based token theft.
- **Session row in Postgres, not a JWT.** A session lookup is one indexed primary-key read (~1ms) and is instantly revocable by deleting the row. JWTs cannot be revoked before expiry and carry algorithm-confusion risk. For a single backend, sessions are simpler and safer.
- **Better Auth** encapsulates the whole Google OAuth flow (authorize URL, CSRF `state`, code exchange, id_token verification, user upsert, session creation, cookie setting) in one config object, using Postgres natively.

**The rule:** the frontend has no auth logic. It has one link to the backend login URL and one call to read session state. Everything else is backend.

### 4. Webhooks must be idempotent

Define *idempotent*: running the same operation twice has the same effect as running it once. Postmark retries an inbound delivery up to 10 times if the webhook returns anything other than HTTP 200, so the same email may arrive more than once.

**What we do:** the first thing the inbound handler does is `INSERT` into `inbound_emails` with `ON CONFLICT (postmark_message_id) DO NOTHING`. If the insert affected zero rows, we have seen this email before — return `200 {note:"duplicate"}` and do nothing else. The `200` is essential: a `4xx`/`5xx` tells Postmark to keep retrying.

### 5. The frontend receives, it does not decide

The frontend is the least trustworthy layer (DevTools, replayed requests, reverse-engineered clients). Decisions — what is allowed, valid, visible — are made by the backend and expressed in the response. The frontend renders the outcome.

- Can a contract be sent? `/send` checks `status === 'draft'` server-side and returns `409` otherwise. The button may be disabled for UX, but the backend enforces.
- Can a user view a contract? The query filters by `user_id = current_user.id`. The frontend never receives another user's rows to accidentally render.

### 6. Sensitive values never touch the frontend

Session secrets, the Postmark server token, the Postmark webhook password, and (later) the AI API key live in GCP Secret Manager and are injected as env vars into Cloud Run at deploy time. They are never returned in an API response, never logged, never serialized anywhere the frontend can read. The frontend receives only what a screen needs to render: name, email, contract metadata, thread entries, service address.

### 7. The database is the source of truth; live push is liveness, not durability

This principle exists because of Server-Sent Events. A pushed event (`NOTIFY`) is *fire-and-forget*: Postgres delivers it only to connections listening at that instant and drops it otherwise — it is never queued. That is acceptable **only because** the durable fact (the contract's new `status`) is already written to the row, and every page load reads the current row.

**The rule:** never rely on a pushed event to carry state that isn't also persisted. On every SSE connect/reconnect, the client (re)reads current state, so a push missed during a reconnect gap is invisible to the user. SSE exists only to make an already-open screen update without a manual refresh.

---

## Scope Boundary Map

```
INSIDE SCOPE                                 OUTSIDE SCOPE (deferred or removed)
──────────────────────────────────────      ──────────────────────────────────
Google OAuth (identity only)                Gmail API of any kind
Per-user service email address              Embedded (in-iframe) signing
Upload contract (PDF)                        Outlook integration
Send via Postmark service address           Reminder push notifications (ours)
Inbound reply via Postmark webhook           Version-history browser UI
Multi-round reply + counter-document         Mobile-optimised views
Pull PDF attachment from reply               Admin / team / org accounts
Intra-domain in-app inbox (received)         Payment / billing
Live dashboard via SSE + LISTEN/NOTIFY       Contract search / filtering
Git-style AI diff of returned document       Audit export to cold storage
E-SIGNATURE via Dropbox Sign  ◄── core
Multi-party signing, ordered  ◄── core
Signers with NO Genie account ◄── core
Dropbox Sign webhook → live thread events
Pull final executed PDF on completion
GCS storage with signed URLs
Dashboard grouped by contract state
```

---

## Tech Stack

| Layer | Choice | Why this, and why not the alternative |
|---|---|---|
| Frontend framework | Astro 6 + React islands | Astro ships static HTML; React loads only for interactive islands. Next.js would ship a React runtime for every page, including static shells. |
| Frontend hosting | Cloudflare Workers | Free 100k req/day, global CDN, no server to manage. Vergel is fine but costs more at scale. |
| Frontend auth | None — session cookie from backend | Zero auth code in the frontend; the HttpOnly cookie attaches automatically. |
| Backend framework | Hono (TypeScript, Node.js) | Async-native, TypeScript-first, fast, clean middleware. Express is older and not TS-native; Fastify is heavier to set up. |
| Backend hosting | GCP Cloud Run (`europe-west2`) | Runs the container, scales to zero, no CPU-time limit (PDF parsing + AI calls can run as long as needed). Cloudflare Workers' 10ms CPU limit would kill PDF extraction. |
| Auth library | Better Auth | Entire Google OAuth flow + Postgres sessions in one config object. Writing it by hand is ~200 lines of security-sensitive code. |
| Sessions | Postgres (Better Auth–managed) | One indexed read per request, instantly revocable. JWTs can't be revoked early. |
| Database | Neon Postgres 16 (`aws-eu-west-2`) | Full Postgres: `json_agg`, `CASE`, `LEFT JOIN`, and — critically for live updates — `LISTEN`/`NOTIFY`. Cloudflare D1 (SQLite) supports none of these. |
| ORM / query layer | Drizzle ORM (postgres-js driver) | Typed schema + migrations for the app tables; raw SQL where we need aggregation. Drizzle coexists with Better Auth, which manages its own four tables via a separate `pg` Pool. |
| File storage | GCP Cloud Storage (private bucket) | Files accessed via 15-min–1-hr v4 signed URLs generated by the backend. The frontend never touches GCS directly. |
| Email (send + inbound) | Postmark | Per-user service address `{slug}-{token}@mail.usetend.in`. MX → `inbound.postmarkapp.com` → webhook. No OAuth scopes, no inbox access. Gmail API was rejected: `gmail.send`/`gmail.readonly` trigger Google's CASA Tier 2 audit ($4k–$75k beyond 100 users) and grant full inbox access. |
| Live updates | SSE + Postgres `LISTEN`/`NOTIFY` | Server pushes status changes down an open HTTP connection; `NOTIFY` fans events across Cloud Run instances. WebSockets would be overkill (we only need server→browser). Plain polling wastes requests. |
| **E-signature** | **Dropbox Sign API** via official SDK **`@dropbox/sign` (v1.11.0, published 2026-05-19)** | The whole point of the product. Email-link signature requests: signers need **no account**, multi-party with ordered signing (`order` field), completion delivered by **webhook** (no polling). We do NOT use embedded signing — it needs an approved API App + `client_id` + iframe JS + domain whitelisting for no added value here. DocuSign was the alternative; Dropbox Sign has a cleaner API, a free test mode, and is the incumbent at this product's target audience. |
| Document diff | **`diff` (jsdiff) v9.0.0** + **`pdf-parse` v2.x** (extract) + **`react-diff-viewer-continued` v4.x** (render) | Deterministic **Myers diff** — *no LLM* — computes exactly what changed, the way `git diff` does. `pdf-parse` 2.x (rewritten, TS/ESM, maintained) pulls text; we diff at **word level** (`diffWords`), not line level, because legal prose reflows. `react-diff-viewer-continued` renders the GitHub/VS-Code-style side-by-side view in a React island. (Monaco's diff editor is the literal VS Code component but is far too heavy for read-only prose.) |
| AI summary (optional, minimal) | An LLM (Gemini Flash or Claude Haiku) over the **computed diff** | One short call that turns the deterministic diff into a plain-English summary. We feed it the *computed patch*, never the whole documents — cheaper, faster, and it can't hallucinate changes that aren't in the real diff. The diff itself is LLM-free. |
| Secrets | GCP Secret Manager | Versioned, access-controlled, injected at deploy. Never in git or logs. |
| CI/CD | GitHub Actions | Push to `main` deploys backend (Cloud Run) and frontend (Cloudflare). |

### Why no ORM for the read-heavy queries

For `INSERT`/simple `SELECT`, Drizzle is convenient and we use it. But the dashboard list, the contract-detail join, and the inbound-match query each need `json_agg`, `CASE`, conditional aggregation, or specific `ORDER BY`. We write those as raw SQL (parameterized via the driver, so injection is impossible by construction) to get one round trip instead of three.

---

## Project Structure

```
genie-poc/
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── index.astro            # Landing — "Continue with Google" anchor
│   │   │   ├── dashboard.astro        # Contract list grouped by state + service address
│   │   │   ├── upload.astro           # Upload + recipient details
│   │   │   └── contracts/
│   │   │       └── [id].astro         # Contract thread (sent, replies, AI summary)
│   │   ├── components/                # React islands (added as components land)
│   │   │   ├── ReplyComposer.tsx       # [Component 5] reply message + attach counter-doc
│   │   │   ├── LiveStatus.tsx         # [Component 6] EventSource → re-render on push
│   │   │   ├── SignerForm.tsx         # [Component 8] add signers (name/email/order/role) + "Send for Signature"
│   │   │   ├── SigningTimeline.tsx    # [Component 8] per-signer status (sent/viewed/signed) on the thread
│   │   │   ├── ReplyViewer.tsx        # [Component 9] text reply or doc reply + AI diff
│   │   │   └── DiffViewer.tsx         # [Component 9] react-diff-viewer-continued side-by-side diff
│   │   └── lib/
│   │       └── api.ts                 # Thin fetch wrapper — forwards cookie, no auth logic
│   ├── astro.config.mjs
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── index.ts                   # @hono/node-server entry; opens the LISTEN connection on boot
│   │   ├── app.ts                     # Hono app — mounts auth, routes, CORS
│   │   ├── lib/
│   │   │   ├── auth.ts                # Better Auth (Google identity-only) + provisioning hook
│   │   │   ├── storage.ts             # GCS client + signed-URL generation
│   │   │   ├── logger.ts              # structured logging
│   │   │   └── events.ts             # [Component 6] LISTEN/NOTIFY + in-process emitter
│   │   ├── middleware/
│   │   │   └── auth.ts                # requireAuth — session cookie → user on context
│   │   ├── routes/
│   │   │   ├── contracts.ts           # list, upload, send, reply [C5], send-for-signature [C8], detail, download-url
│   │   │   ├── webhooks.ts            # POST /webhooks/postmark/inbound; POST /webhooks/dropbox-sign/inbound [C8]
│   │   │   └── events.ts             # [Component 6] GET /api/events (SSE)
│   │   ├── services/
│   │   │   ├── serviceEmail.ts        # provision/look up {slug}-{token}@mail.usetend.in
│   │   │   ├── postmarkClient.ts      # send email + PDF; threading headers for replies [C5]
│   │   │   ├── dropboxSignClient.ts   # [Component 8] @dropbox/sign: send request, verify callback, download executed PDF
│   │   │   └── aiAnalysis.ts         # [Component 9] pdf-parse + jsdiff (word-level) + optional LLM summary
│   │   └── db/
│   │       ├── client.ts              # Drizzle over postgres-js (pooled URL)
│   │       └── schema.ts              # service_emails, contracts, contract_threads, inbound_emails, contract_signers [C8]
│   ├── drizzle.config.ts              # tablesFilter protects Better Auth's tables
│   ├── Dockerfile
│   └── package.json
│
└── .github/workflows/deploy.yml       # push to main → deploy both services
```

Files marked `[Component N]` do not exist yet; they are introduced by that component in the build plan.

**Two structural rules worth keeping:**
- **Routes vs services.** A route file handles HTTP (parse request, call a service, return a response). A service file handles logic (call Postmark, process data). A route never calls Postmark directly; a service never parses an HTTP request.
- **Better Auth owns its tables; Drizzle owns ours.** `drizzle.config.ts` uses `tablesFilter` so `drizzle-kit` never emits `DROP TABLE` for `user`/`session`/`account`/`verification`.

---

## Database Schema

This is the **actual** Drizzle schema in `backend/src/db/schema.ts`, plus the two additions Component 6 introduces (clearly marked). Better Auth auto-manages `user`, `session`, `account`, `verification` on the same database via its own `pg` Pool.

**`user.id` is TEXT (nanoid), not UUID.** Every FK that references a user uses `text()`.

### Enums

```ts
contract_status:  draft | sent | replied | ai_processing
                | completed | negotiating | declined
                | received               // [Component 7] a contract sent TO a Genie user
                | out_for_signature      // [Component 8] signature request created, awaiting signatures
                | partially_signed       // [Component 8] ≥1 but not all parties have signed
                | signed                 // [Component 8] every party signed; executed PDF stored

contract_origin:  created | received   // [Component 7] who this contract belongs to, by direction

thread_direction: outbound | inbound | system   // [Component 8] 'system' = a signing-lifecycle event (sent/viewed/signed)

signer_status:    pending | sent | viewed | signed | declined   // [Component 8] per-party signing state

signer_role:      creator | counterparty | other   // [Component 8] 'other' = e.g. the user's boss or client who actually signs
```

> **Why `signed` and `partially_signed` are separate from `completed`.** `out_for_signature → partially_signed → signed` is the **signing** lifecycle (Component 8). `ai_processing → completed | negotiating` is the **AI-diff** lifecycle (Component 9). They are orthogonal: a contract can be `negotiating` (diff showed changes, awaiting a human decision) and later go `out_for_signature` once agreed. The terminal success state of the whole product is `signed` — every party has signed and the executed PDF is in storage.

### `service_emails` — one dedicated address per user

| Column | Type | Notes |
|---|---|---|
| `id` | text PK (uuid) | |
| `user_id` | text | FK → Better Auth `user.id`; unique (one address per user) |
| `local_part` | text | e.g. `alice-x7k2`; globally unique; the inbound routing key |
| `address` | text | full `alice-x7k2@mail.usetend.in`; unique; denormalized for display |
| `is_active` | boolean | default true |
| `created_at` / `updated_at` | timestamptz | |

### `contracts` — one row per contract document

| Column | Type | Notes |
|---|---|---|
| `id` | text PK (uuid) | |
| `user_id` | text | owner (FK → `user.id`) |
| `title` | text | |
| `storage_key` | text | GCS object key, e.g. `contracts/{userId}/{contractId}/original.pdf` (bucket name lives in config, not here) |
| `original_filename` | text | |
| `mime_type` | text | default `application/pdf` |
| `file_size_bytes` | integer | |
| `recipient_name` / `recipient_email` | text | the **counterparty** — who we sent to (`created`) or who sent it (`received`, set by Component 7) |
| `status` | contract_status | default `draft` |
| `postmark_message_id` | text | unique; returned by the outbound send; matched against inbound `In-Reply-To` |
| `subject` | text | |
| `sent_at` | timestamptz | |
| `ai_analysis` | jsonb | AI diff output — summary + structured patch (Component 9) |
| `ai_started_at` / `ai_completed_at` | timestamptz | |
| `notes` | text | |
| `origin` | contract_origin | **[Component 7]** default `created` |
| `signature_request_id` | text | **[Component 8]** Dropbox Sign request id; unique; null until sent for signature; the webhook lookup key |
| `signed_storage_key` | text | **[Component 8]** GCS key of the final executed PDF, e.g. `contracts/{userId}/{contractId}/signed.pdf`; null until all-signed |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(user_id)`, `(status)`, `(user_id, status)` for the dashboard, unique `(postmark_message_id)`.

> **Counterparty convention (Component 7):** `recipient_name`/`recipient_email` always hold *the other party*. For a `created` contract that is the person we sent to; for a `received` contract it is the sender. This avoids adding a parallel column pair.

### `contract_threads` — each email in a contract's thread (in or out)

| Column | Type | Notes |
|---|---|---|
| `id` | text PK (uuid) | |
| `contract_id` | text | FK → contracts |
| `direction` | thread_direction | |
| `postmark_message_id` | text | unique per email; outbound = send API result, inbound = webhook `MessageID` |
| `in_reply_to_message_id` | text | inbound only; matches the original outbound `postmark_message_id` |
| `from_address` / `to_address` | text | |
| `cc_addresses` | jsonb (string[]) | |
| `subject` | text | |
| `body_text` / `body_html` | text | |
| `attachments` | jsonb | array of `{ filename, contentType, storageKey, sizeBytes }` — files in GCS, metadata here |
| `email_date` | timestamptz | from headers, not insert time |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(contract_id)`, `(contract_id, direction)`, `(in_reply_to_message_id)`, unique `(postmark_message_id)`.

### `inbound_emails` — raw Postmark webhook ledger (idempotency + debug)

Not user-facing. The system's receipt book. Every webhook POST is dumped here verbatim before any processing.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK (uuid) | |
| `postmark_message_id` | text | **unique — the dedup key** (`ON CONFLICT DO NOTHING`) |
| `to_address` / `from_address` | text | |
| `subject` | text | |
| `raw_payload` | jsonb | the entire Postmark JSON, for debug and replay |
| `processed` | boolean | default false |
| `thread_entry_id` | text | FK → `contract_threads.id`, set after success |
| `processing_error` | text | |
| `processed_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz | |

### `contract_signers` — one row per party on a signature request [Component 8]

A signature request has one or more signers. Each gets a row here so the Dropbox Sign webhook can update *that* party's state and the thread can show "who's signed, who hasn't". The set is arbitrary and may not include the creating user — e.g. the counterparty plus the user's *boss* who actually signs on their side.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK (uuid) | |
| `contract_id` | text | FK → contracts |
| `signature_request_id` | text | Dropbox Sign request id (denormalized so the webhook can resolve signer → contract fast) |
| `dropbox_signature_id` | text | Dropbox Sign's per-signer `signature_id`; set/confirmed from webhook payloads |
| `signer_email` | text | the address Dropbox Sign emails the signing link to (see "the two angles" in Signing Flow) |
| `signer_name` | text | |
| `signing_order` | integer | Dropbox Sign `order` — **lower signs first**; equal/empty ⇒ parallel |
| `role` | signer_role | `creator` \| `counterparty` \| `other` |
| `genie_user_id` | text | FK → `user.id`, **nullable** — set when this signer is a Genie user, so we surface an in-app "awaiting your signature" and email their *real* identity address, not their `mail.usetend.in` service address |
| `status` | signer_status | `pending` → `sent` → `viewed` → `signed` (or `declined`) |
| `signed_at` | timestamptz | set on the `signature_request_signed` event for this signer |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(contract_id)`, `(signature_request_id)`, `(contract_id, signing_order)`. Unique `(contracts.signature_request_id)`.

### Status state machine

```
draft ──send──► sent ──inbound webhook──► replied        (created, external reply)
                                            │
                                            └── attachment present ──► ai_processing   (Component 9, diff)
                                                                          ├─► completed     (diff shown, no further change pending)
                                                                          └─► negotiating   (diff shown, awaiting a human decision)

(intra-domain) inbound to a Genie user, not a reply ──► creates a contract with
                                                        origin='received', status='received'
                                                        in the RECIPIENT's account

(negotiation, Component 5) across rounds the status toggles:
    user replies  ──► sent     (awaiting counterparty, "in progress")
    they reply    ──► replied  (awaiting user, "needs attention")

(signing, Component 8) once a version is agreed:
    send-for-signature ──► out_for_signature
        signature_request_signed (one party)   ──► partially_signed
        signature_request_all_signed (everyone) ──► signed
        signature_request_downloadable          ──► fetch executed PDF → signed_storage_key set
        signature_request_declined (any party)  ──► negotiating   (drop back to the loop; resend after revising)
```

---

## Key Queries

### Dashboard list — one query, pre-sorted, pre-grouped

`CASE` assigns each status a `sort_group`; `ORDER BY sort_group, updated_at DESC` returns final display order. The frontend iterates once and breaks on `sort_group` changes. (When Component 6 lands, `origin='received'` rows surface as their own "Received" group via the same mechanism.)

```sql
SELECT id, title, status, origin, recipient_name, recipient_email,
       sent_at, updated_at,
       CASE status
         WHEN 'replied'      THEN 1   -- needs attention
         WHEN 'received'     THEN 1   -- new incoming contract
         WHEN 'sent'         THEN 2   -- in progress
         WHEN 'ai_processing' THEN 2
         WHEN 'negotiating'  THEN 2
         WHEN 'signed'       THEN 3
         WHEN 'completed'    THEN 3
         WHEN 'declined'     THEN 3
         WHEN 'draft'        THEN 4
       END AS sort_group
FROM contracts
WHERE user_id = $1
ORDER BY sort_group ASC, updated_at DESC;
```

### Contract detail with full thread — one round trip

`LEFT JOIN` + `json_agg` returns the contract plus its thread as a typed array. `FILTER (WHERE t.id IS NOT NULL)` makes a contract with no thread entries return `[]`, not `null` (which would crash `.map()`).

```sql
SELECT c.*,
  COALESCE(
    json_agg(
      json_build_object(
        'id', t.id, 'direction', t.direction, 'subject', t.subject,
        'body_text', t.body_text, 'attachments', t.attachments,
        'email_date', t.email_date
      ) ORDER BY t.email_date ASC
    ) FILTER (WHERE t.id IS NOT NULL),
    '[]'
  ) AS thread
FROM contracts c
LEFT JOIN contract_threads t ON t.contract_id = c.id
WHERE c.id = $1 AND c.user_id = $2
GROUP BY c.id;
```

### Inbound idempotency check — the first thing the webhook does

```sql
INSERT INTO inbound_emails (id, postmark_message_id, to_address, from_address, subject, raw_payload)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (postmark_message_id) DO NOTHING
RETURNING id;
-- zero rows returned → already seen → return 200 {note:"duplicate"} and stop
```

### Inbound routing — who owns this address, and is it a reply?

```sql
-- 1. which user owns the recipient address?
SELECT user_id, address FROM service_emails
WHERE local_part = $1 AND is_active = true;

-- 2. is this a reply to one of that user's sent contracts?
SELECT contract_id FROM contract_threads
WHERE postmark_message_id = $1;   -- $1 = the In-Reply-To header value
-- a match → reply path (Component 4)
-- no match but address resolves to a Genie user → received-contract path (Component 7)
```

---

## GCS Bucket Layout

```
gs://genie-poc-contracts/
└── contracts/
    └── {userId}/
        └── {contractId}/
            ├── original.pdf            ← uploaded (created) or attachment (received)
            ├── reply-{timestamp}.pdf   ← counterparty document(s)
            └── signed.pdf              ← [Component 8] final executed PDF, pulled from Dropbox Sign on completion
└── inbound/
    └── {userId}/
        └── {messageId}.pdf             ← fallback when an inbound PDF can't be matched to a contract
```

All objects are private. Downloads go through a backend-generated v4 signed URL (15 min – 1 hr TTL). After expiry the signature is invalid and the URL stops working, so a copied link becomes useless. The frontend never has standing GCS access.

---

## Authentication & Provisioning Flow

Google is an **identity provider only** — `openid email profile`, `accessType` online (no refresh token issued), no Gmail scopes.

1. User clicks "Continue with Google" → links to `{BACKEND_URL}/api/auth/signin/google`.
2. Better Auth redirects to Google's consent screen (name, email, profile picture only).
3. User approves → Google redirects to `{BACKEND_URL}/api/auth/callback/google`.
4. Better Auth exchanges the code, upserts the `user`, creates a `session`, sets the `better-auth.session` cookie (`HttpOnly`, `Secure`, `SameSite=None` for cross-origin Cloudflare→Cloud Run), redirects to `{FRONTEND_URL}/dashboard`.
5. **First login only:** `databaseHooks.user.create.after` fires → `provisionServiceEmail(user.id, user.name)` inserts a `service_emails` row `{slug}-{token}@mail.usetend.in`. `slug` = first 12 alphanumerics of the name; `token` = 6 random `[a-z0-9]`; retry loop on unique-violation. Idempotency guard: returns the existing address if one is present, so a re-run never creates a second row.
6. `requireAuth` middleware reads the cookie via `auth.api.getSession()` on every protected request and attaches `user`/`session` to the Hono context.

---

## Send Flow

1. Upload: multipart `POST /api/contracts/upload` → validate PDF + ≤20 MB → store at `contracts/{userId}/{contractId}/original.pdf` → insert `contracts` row `status='draft'`, `origin='created'`.
2. Send: `POST /api/contracts/:id/send` with `{ recipientName, recipientEmail, subject }` → verify owner + `status='draft'` (else 409) → re-read PDF from GCS → `postmarkClient.sendContractEmail()` from the user's service address with the PDF attached → Postmark returns `MessageID`.
3. Persist: `UPDATE contracts SET status='sent', postmark_message_id, recipient_*, subject, sent_at` and `INSERT contract_threads (direction='outbound', postmark_message_id)`.

Sending **from the service address** is what makes replies work: the recipient replies to `alice-x7k2@mail.usetend.in`, whose MX is Postmark inbound, so we capture it.

---

## Receive Flow

### External reply (counterparty is not a Genie user) — Component 4

1. Postmark POSTs `POST /webhooks/postmark/inbound`.
2. Verify Basic Auth header (reject non-Postmark POSTs with 401).
3. **Idempotency insert** into `inbound_emails` (`ON CONFLICT DO NOTHING`); zero rows → return `200 {note:"duplicate"}`.
4. Return `200` fast; process asynchronously (don't block Postmark).
5. Resolve `OriginalRecipient` local-part → owning user via `service_emails`.
6. Read the `In-Reply-To` header; find the matching outbound `contract_threads.postmark_message_id` → `contractId`.
7. For each PDF attachment: base64-decode → upload to `contracts/{userId}/{contractId}/reply-{ts}.pdf`.
8. `INSERT contract_threads (direction='inbound', in_reply_to_message_id, attachments, body_*)`; `UPDATE contracts SET status='replied'`; mark `inbound_emails.processed=true`.
9. `NOTIFY` the contract owner's channel so any open dashboard updates live (Component 6).

### Intra-domain received contract (counterparty IS a Genie user) — Component 7

Same webhook, different branch. If the inbound email resolves to a Genie user's address but has **no** `In-Reply-To` matching one of *their* sent contracts, it is a **new contract sent to them**, not a reply:

1. Create a `contracts` row owned by the recipient: `origin='received'`, `status='received'`, `recipient_*` = the sender's details (counterparty convention), `storage_key` = the uploaded attachment stored to `contracts/{recipientId}/{newContractId}/original.pdf`.
2. `INSERT contract_threads (direction='inbound', ...)` against that new contract.
3. `NOTIFY` the recipient's channel → their dashboard surfaces it under "Received" live.

This closes the original gap where an intra-platform send vanished into processing with nowhere to surface.

### Dropbox Sign webhook (signing lifecycle) — Component 8

A second inbound webhook, separate from Postmark, carries signing events: `POST /webhooks/dropbox-sign/inbound`. Three current-API specifics matter and are easy to get wrong:

1. **Payload shape (the gotcha).** Dropbox Sign POSTs **`multipart/form-data`** with a single form field named **`json`** containing the event JSON — *not* a raw JSON body. Parse it with Hono's `c.req.parseBody()`, then `JSON.parse(body['json'])`.
2. **Authenticity check.** Each event carries `event.event_hash` = **HMAC-SHA256 of `event_time + event_type`, keyed by the API key**. The SDK provides `EventCallbackHelper.isValid(apiKey, EventCallbackRequest.init(data))` — use it; reject with 401 on failure. This is the equivalent of Postmark's Basic Auth check (Principle 4 still applies — idempotency by `signature_request_id` + event type).
3. **Required response.** The handler **must** return HTTP 200 with the exact body text **`Hello API Event Received`**. Anything else is treated as failure; Dropbox Sign retries (1 + 6 attempts over ~30h) and after ~10 consecutive failures auto-clears the callback URL.

The handler resolves `signature_request_id` → contract, applies the state transitions listed in the Signing Flow, appends `system` thread entries, and calls `notifyUser` so open dashboards update live. We use the **account-level** callback URL (set in Dropbox Sign dev settings), since we send plain (non-embedded) requests without a `client_id`.

---

## Reply / Negotiation Flow (Component 5)

Negotiation is multi-round: send → they reply → **you counter** → they reply → … until someone agrees. Component 4 captures *their* replies for any number of rounds; this flow produces *our* side of each round so the conversation can continue inside the app.

```
R1  user SENDS            → outbound thread row (M1), status='sent'
R2  counterparty REPLIES  → inbound (M2, In-Reply-To=M1), status='replied'   ← needs you
R3  user COUNTERS         → POST /api/contracts/:id/reply
                            threads against the latest inbound (M2):
                            In-Reply-To/References=M2, subject 'Re: …',
                            optional revised PDF → GCS,
                            outbound thread row (M3), status='sent'           ← awaiting them
R4  counterparty REPLIES  → inbound (M4, In-Reply-To=M3) matches M3 → continues…
```

**Turn tracking reuses the existing toggle** (no new statuses): `sent` = awaiting the counterparty (in progress), `replied` = awaiting the user (needs attention). Each user reply flips it back to `sent`; each inbound reply flips it to `replied`. This maps directly onto the dashboard `sort_group`.

**Why threading headers are mandatory:** the reply must carry `In-Reply-To` and `References` pointing at the message it answers. Two reasons: (1) the counterparty's email client keeps the whole exchange in one visible thread; (2) *their* next reply's `In-Reply-To` will reference our message, which is exactly what the inbound matcher (Component 4) looks up. Skip the headers and round 4 onward can no longer be matched to the contract.

**Versions accumulate** as separate `reply-{ts}.pdf` objects and separate thread rows, so every round's document is preserved. The AI diff component (9) diffs each new version against the previous one. When the parties agree on a version, the user takes it into the **Signing Flow** below.

---

## Signing Flow (Component 8 — the core)

This is the destination of the whole product: turning an agreed document into a legally executed one, signed by every required party, without the user ever leaving Genie or hand-driving DocuSign. Delivered with **Dropbox Sign** (`@dropbox/sign` v1.11.0).

### Why email-link signing, not embedded

Dropbox Sign offers two flows. **Embedded** signing renders the signing UI inside an iframe in *our* app, but requires an approved API App with a `client_id`, the `hellosign-embedded` JS library, per-signer `sign_url` minting, and domain whitelisting. **Email-link** signing — the default `signatureRequestSend` — has Dropbox Sign host the signing page and email each signer a secure link directly. The signer clicks, reads, and signs **with no account and no login** (the "YC-style" link in an email). We choose email-link: it delivers exactly the outcome we need (a signed PDF) with zero frontend iframe work, no app-approval gate, and no domain whitelisting — and completion arrives by **webhook**, so we don't poll. Embedded is explicitly out of scope.

### The request

When the user clicks **"Send for Signature"** on an agreed contract (`POST /api/contracts/:id/send-for-signature`), they supply an ordered list of signers — `{ name, email, order, role }`. The backend:

1. Re-reads the agreed PDF from GCS (the latest agreed version — `original.pdf` or the relevant `reply-{ts}.pdf`).
2. Calls `dropboxSignClient.sendSignatureRequest()` → `SignatureRequestApi.signatureRequestSend({ title, subject, message, files:[stream], signers:[{ name, emailAddress, order }], testMode })`. **Signing order** is the per-signer `order` integer: lower signs first; Dropbox Sign emails signer `order:1` only after `order:0` completes. Equal/omitted `order` ⇒ everyone is emailed at once (parallel).
3. Persists `contracts.signature_request_id` + one `contract_signers` row per party (`status='sent'` for the first in order / `'pending'` for those waiting their turn), and flips `contracts.status='out_for_signature'`.
4. `notifyUser(ownerId, {contractId, status:'out_for_signature'})` (Component 6 seam) so the owner's open dashboard updates live.

**Test mode (`testMode:true`) is on for the POC:** a free Dropbox Sign developer account exercises the entire multi-party, ordered, email-link flow end-to-end for free. The trade-off is that test-mode executed PDFs are watermarked and not legally binding — fine for a demo; a paid API plan ($75/mo Essentials tier) is required for real binding signatures, and sending production requests without one returns HTTP 402. Documented in Known Risks.

### The two signer angles (both must work)

A signer is identified only by an email address, but *which* address we use differs:

- **Signer is NOT a Genie user (the common case).** We send to whatever email the user typed. Dropbox Sign emails them the no-auth signing link; they read and sign on Dropbox Sign's hosted page. They never touch Genie and never make an account. Nothing else is needed.
- **Signer IS a Genie user.** We set `contract_signers.genie_user_id`. Two adjustments: **(a)** we send the Dropbox Sign link to their **real Google identity email** (`user.email`), **never** their `…@mail.usetend.in` service address — that address routes to Postmark inbound and has no readable inbox, so a signing link sent there would vanish. **(b)** We *also* surface an in-app "This contract is awaiting your signature" card on their dashboard (driven by the webhook + SSE), so a logged-in Genie user sees it inside the app even before opening the email. The actual signing still happens on Dropbox Sign's hosted page (a fully in-app embedded experience is a future enhancement — see "Why email-link signing" above).

### Multi-party (the user may not be a signer)

The person *creating* the contract is not necessarily a *signer*. Common shapes the signer list must support:

- `[counterparty (order 0), me (order 1)]` — they sign, then I sign.
- `[counterparty (order 0), my boss (order 1)]` — they sign, then my boss (who never logged into Genie) signs. The creator orchestrates but does not sign.
- 3–4 parties in sequence (e.g. counterparty → my manager → my legal → me).

Each party is a `contract_signers` row with its own `order` and `status`. The thread shows the live roster: "Sent for signature → Counterparty viewed → Counterparty signed → Awaiting your boss…".

### Completion by webhook (no replying to us, no polling)

The signer never emails us back. Dropbox Sign POSTs lifecycle events to `POST /webhooks/dropbox-sign/inbound` (see Receive Flow → "Dropbox Sign webhook"). We map them onto state:

- `signature_request_sent` / `signature_request_viewed` → update the signer's `status`; append a `system` thread entry.
- `signature_request_signed` → fires **once per signer**; mark that `contract_signers` row `signed` + `signed_at`; contract → `partially_signed`; `notifyUser`.
- `signature_request_all_signed` → every party done; contract → `signed`; `notifyUser`.
- `signature_request_downloadable` → the executed PDF (with audit trail) is assembled; call `SignatureRequestApi.signatureRequestFiles(id, 'pdf')`, store it at `contracts/{userId}/{contractId}/signed.pdf`, set `signed_storage_key`. (We mark `signed` on all-signed and fetch the file on downloadable, which can arrive a moment later.)
- `signature_request_declined` → a party refused; contract → `negotiating`. The parties revise via the existing reply loop (Components 4/5), the AI diff (9) shows what changed, and the user sends a **new** signature request on the agreed version.

The user downloads the executed contract via `GET /api/contracts/:id/signed-document` (a v4 signed GCS URL to `signed.pdf`), available once `status='signed'`.

---

## Diff Architecture (Component 9 — git-style, LLM-free change detection)

When a counterparty returns a modified document, the user must see **exactly what changed** to decide "accept and sign, or counter again". This is computed the way `git diff` computes it — a deterministic algorithm, **no AI** — with an LLM used only afterward for a one-paragraph human summary.

- **Algorithm.** The **Myers diff** algorithm (1986), the same default `git diff` uses. Given old text and new text it computes the shortest edit script — pure dynamic programming, identical output every time, no model. Implemented by **`diff` (jsdiff) v9.0.0**.
- **Granularity = word level, not line level.** Legal contracts are long reflowed paragraphs; a one-word edit would mark an entire line/paragraph as changed under a line diff, and PDF-extracted text has unstable line breaks. We diff at **word level** (`diffWords`) so the highlight is the exact words added/removed. (`diffLines` is wrong for prose.)
- **Text extraction (the honest caveat).** We extract text from the two PDFs with **`pdf-parse` v2.x** (rewritten, TS/ESM, maintained). PDF is a page-description format with no logical paragraphs, so extraction is **lossy** — expect occasional rough output (reflowed wrapping, hyphenated line breaks). Mitigations, all applied before diffing: normalize whitespace, re-join hyphenated breaks (`/([a-z])-\n([a-z])/ → $1$2`), and diff at word level (kills the reflow noise). If a party ever returns a **DOCX**, `mammoth` extracts it with real paragraph structure preserved — a cleaner path noted for later.
- **Rendering (the "like VS Code" part).** `react-diff-viewer-continued` v4.x renders a GitHub/VS-Code-style **side-by-side** view in a React island — additions green, deletions red, unchanged regions collapsible. (Monaco's `DiffEditor` is the literal VS Code component but is far too heavy for read-only prose; `diff2html` over a unified-diff string is the lightweight alternative.)
- **The LLM's only job.** A single optional call takes the **computed diff** (jsdiff `structuredPatch`, a few hundred tokens) — *not* the whole documents — and writes a plain-English summary ("3 changes: payment term 30→45 days; liability cap added; signatory name updated"). Feeding it only the diff is cheaper, faster, and prevents it inventing changes that aren't in the real edit set. The change *detection* never involves the LLM.

---

## Live Updates Architecture (SSE + LISTEN/NOTIFY)

**The problem.** HTTP is request-response: the browser must speak first, and the server can't reach a browser it isn't already connected to. When a webhook changes a contract's status, an already-loaded dashboard has no idea. SSE keeps one connection open so the server can push; but on Cloud Run the webhook request and the SSE connection may land on **different instances** (separate processes with separate memory), so an in-memory event emitted by the webhook instance never reaches the SSE instance.

**The solution: Postgres `LISTEN`/`NOTIFY` as the cross-instance meeting point.** Define them: `NOTIFY <channel>, <payload>` publishes a message; `LISTEN <channel>` subscribes a connection to it. The database — which every instance already connects to — becomes the shared bus.

```
                    ┌──────────────┐
 BROWSER ──SSE────► │ Instance A   │── holds LISTEN "user_{id}" ──┐
                    └──────────────┘                              ▼
                                                           ┌─────────────┐
                    ┌──────────────┐                       │  POSTGRES   │
 POSTMARK ─webhook─►│ Instance B   │── NOTIFY "user_{id}" ─►│  (Neon)     │
                    └──────────────┘                       └──────┬──────┘
                                                                  │ broadcast
                    ┌──────────────┐                              │
                    │ Instance A   │◄──── receives notification ──┘
                    │ pushes event down the open SSE line to the browser │
                    └──────────────┘
```

**Mechanics:**
- On boot (`index.ts`), each instance opens **one dedicated** `LISTEN` connection (in `lib/events.ts`). Its callback re-emits notifications onto an in-process `EventEmitter`.
- `GET /api/events` (auth required) is the SSE endpoint. It subscribes the request to the in-process emitter, filtered to the logged-in user's channel/payloads, and writes `event: status` lines as they arrive.
- The webhook (and any status-changing path) calls `NOTIFY user_{ownerId}, '{contractId, status}'` after the DB write.
- **On connect, the SSE handler first sends the current state** (or the client refetches), per Principle 7 — so a `NOTIFY` dropped during a reconnect gap is invisible.

**Scale-to-zero compatibility (important and intended):**
- An open SSE connection is an in-flight request, so Cloud Run keeps ≥1 instance alive while any dashboard is open → its `LISTEN` is active → pushes work.
- With no dashboard open, no SSE connections exist → Cloud Run scales to zero → no `LISTEN`. That's fine: with nobody watching there is nothing to push to. The status change still gets written by the webhook (which spins up an instance to handle the POST, writes, returns 200, then scales back down).
- When the user next opens the dashboard, the SSR fetch reads the **current** row (already `replied`/`received`) — so they see the latest immediately. SSE only ever carries changes that happen *while* a screen is open.
- Cloud Run caps request duration (default 5 min, max 60); SSE connections are periodically force-closed and the browser's `EventSource` auto-reconnects. Combined with refetch-on-connect, this is seamless.

---

## API Endpoint Map

| Method | Path | Auth | Description | Component |
|---|---|---|---|---|
| `GET` | `/health` | No | Health check | 1 |
| `GET,POST` | `/api/auth/*` | No | Better Auth (login, callback, get-session, sign-out) | 1 |
| `GET` | `/api/me/service-email` | Yes | `{ address }` | 1 |
| `GET` | `/api/contracts` | Yes | Pre-sorted dashboard list | 2 |
| `POST` | `/api/contracts/upload` | Yes | Multipart `file`,`title` → `{ contractId }` | 2 |
| `GET` | `/api/contracts/:id` | Yes | Contract + thread (one query) | 2 |
| `GET` | `/api/contracts/:id/download-url` | Yes | v4 signed GCS URL | 2 |
| `POST` | `/api/contracts/:id/send` | Yes | `{recipientName,recipientEmail,subject}` → `{messageId}` | 3 |
| `POST` | `/api/contracts/:id/reply` | Yes | Multipart `message`, optional `file` → threaded reply, status→`sent` | 5 |
| `POST` | `/webhooks/postmark/inbound` | Basic Auth | Postmark inbound (reply + received-contract branches) | 4 / 7 |
| `GET` | `/api/events` | Yes | SSE stream of this user's contract status changes | 6 |
| `POST` | `/api/contracts/:id/send-for-signature` | Yes | `{ signers:[{name,email,order,role}], message? }` → Dropbox Sign request, status→`out_for_signature` | 8 |
| `POST` | `/webhooks/dropbox-sign/inbound` | `event_hash` HMAC | Dropbox Sign lifecycle (sent/viewed/signed/all_signed/downloadable/declined). Multipart `json` field; must reply `Hello API Event Received` | 8 |
| `GET` | `/api/contracts/:id/signed-document` | Yes | v4 signed GCS URL to the executed `signed.pdf` (once `status='signed'`) | 8 |

---

## Environment Variables

```bash
# NeonDB — DIRECT url for Better Auth's pg Pool + migrations; POOLED for Drizzle runtime
DATABASE_URL=postgresql://...neon.tech/genie_poc?sslmode=require
DATABASE_URL_POOLED=postgresql://...-pooler.neon.tech/genie_poc?sslmode=require

# Google OAuth (identity only)
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

# Better Auth
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:8080          # prod: Cloud Run URL

# GCP
GOOGLE_CLOUD_PROJECT=genie-poc
GCS_BUCKET_NAME=genie-poc-contracts

# Postmark
POSTMARK_SERVER_API_TOKEN=...
POSTMARK_INBOUND_WEBHOOK_USER=postmark-inbound
POSTMARK_INBOUND_WEBHOOK_PASS=<openssl rand -base64 16>

# Dropbox Sign (Component 8)
DROPBOX_SIGN_API_KEY=...                        # also the HMAC key for verifying webhook event_hash
DROPBOX_SIGN_TEST_MODE=true                     # POC: free, watermarked, NOT legally binding; flip off only with a paid plan
# DROPBOX_SIGN_CLIENT_ID=...                     # NOT needed — only for embedded signing, which we don't use

# Frontend
FRONTEND_URL=http://localhost:4321             # prod: Cloudflare Workers URL
PUBLIC_API_URL=http://localhost:8080           # frontend → backend (same as BETTER_AUTH_URL)

# AI diff summary (Component 9 only)
# GEMINI_API_KEY=...   or   ANTHROPIC_API_KEY=...
```

In production these are GCP Secret Manager entries injected into Cloud Run at deploy.

---

## Build Plan — Component by Component

### Why component-by-component

A day-by-day plan cuts horizontally (all backend, then all frontend) and you can't test anything end-to-end until late. A component-by-component plan cuts vertically: each component includes the backend endpoint(s) **and** the frontend screen(s) that use them, and ends with a real browser test using real data — no mocks.

**The rule:** do not start Component N+1 until Component N demonstrably works end-to-end in a browser.

**Legend:** ✅ done & tested · 🟡 built, end-to-end test blocked · ⬜ not started

---

### Component 1 — Skeleton + Auth + Service Email ✅ LOCKED

**Built and tested.** Both servers run; Google OAuth (identity only) works; sessions in Neon; per-user service address provisioned on first login; dashboard shows the address and is gated behind auth.

- Backend: Hono app, Better Auth (Google identity-only, `databaseHooks.user.create.after` → `provisionServiceEmail`), Drizzle schema (`service_emails`, `contracts`, `contract_threads`, `inbound_emails`), `drizzle.config.ts` with `tablesFilter`, `db:push`, Dockerfile, Cloud Run deploy.
- Frontend: Astro + Cloudflare + React; `index.astro` login anchor; `dashboard.astro` shows name + service address.
- **Verified:** consent screen shows no Gmail scopes; `service_emails` row created on first login, none on second; incognito `/dashboard` → redirect to `/`.

> Do not rebuild. Changes here are additive only (e.g. the `origin` enum/column added in Component 7).

---

### Component 2 — Upload + Dashboard + GCS ✅ LOCKED

**Built and tested.** Upload a PDF, see it on the dashboard grouped by status, download it.

- `lib/storage.ts` (`uploadToGCS`, `download`, `generateDownloadSignedUrl`); `POST /api/contracts/upload`; `GET /api/contracts` (dashboard `sort_group` query); `GET /api/contracts/:id` (detail + thread `json_agg`); `GET /api/contracts/:id/download-url`.
- Frontend: `upload.astro`; dashboard list grouped by `sort_group`; `contracts/[id].astro` shell; empty state.
- **Verified:** GCS object at `contracts/{userId}/{contractId}/original.pdf`; `contracts` row `status='draft'`; download opens the PDF.

---

### Component 3 — Send via Postmark ✅ LOCKED (tested up to send)

**Built and tested to the point of sending.** The email goes out from the user's service address with the PDF attached.

- `services/postmarkClient.ts`; `POST /api/contracts/:id/send` (owner + draft check, GCS re-read, Postmark send, status→`sent`, outbound `contract_threads` row); `GET /api/me/service-email`.
- Frontend: send form with non-editable "From: {service address}"; status flips to "Sent".
- **Verified:** recipient inbox receives the email + PDF; `contracts.status='sent'`, `postmark_message_id` set; one outbound thread row.

---

### Component 4 — Inbound Reply Capture 🟡 BUILT, TEST BLOCKED

**Code complete; full end-to-end test is blocked on Postmark account verification** (in progress, ~1 day). The webhook handler exists and is wired; what remains is exercising a real reply round-trip once Postmark is live.

- `POST /webhooks/postmark/inbound`: Basic Auth check; `inbound_emails` idempotency insert; async `processInbound()`; `OriginalRecipient` → user; `In-Reply-To` → contract; decode PDF → GCS; inbound `contract_threads` row; `contracts.status='replied'`; mark processed.
- Frontend: `contracts/[id].astro` thread shows outbound + inbound with timestamp, sender, body preview, and a signed-URL download for the attachment.

**How to finish (once Postmark is verified):**
1. Point the Postmark inbound webhook at the backend (locally: `cloudflared tunnel --url http://localhost:8080`, URL `…/webhooks/postmark/inbound`, with Basic Auth).
2. Send a contract, reply from an external account with a PDF attached.
3. Verify within ~30s: `inbound_emails.processed=true`, inbound `contract_threads` row, `contracts.status='replied'`, reply PDF in GCS, thread view shows the reply.
4. Idempotency: POST the same payload twice → second returns `{note:"duplicate"}`, one `inbound_emails` row.

**End state:** external replies captured and shown; attachment downloadable. *(This is the first test to run the moment Postmark clears.)*

---

### Component 5 — In-Thread Reply / Negotiation Loop ⬜

**What this builds:** the missing half of the conversation — the user replying *back* within an existing thread, with a message and (optionally) their own modified version of the document. This turns the one-way "send → they reply" into the real multi-round negotiation: send → they reply → you counter → they reply → … until someone agrees. Component 4 already captures *their* replies for unlimited rounds; this component produces *our* side of each round.

**Why it comes before SSE/inbox/AI:** a contract tool that can't respond to a counter-offer isn't a negotiation tool. This is the core product gap, so it is built immediately after inbound capture.

**Backend:**
- `services/postmarkClient.ts`: extend the send to set threading headers — `In-Reply-To` and `References` pointing at the message being answered, and a `Re: {subject}` subject — and to carry an optional PDF attachment. Without these headers the reply won't thread in the counterparty's client and *their* next reply won't match (see Known Risks).
- `POST /api/contracts/:id/reply` (`requireAuth`): verify owner; find the latest **inbound** thread row to thread against (its `postmark_message_id` → `In-Reply-To`/`References`); accept `{ message, file? }` (multipart); if a file is present, store it to `contracts/{userId}/{contractId}/reply-{ts}.pdf`; send via Postmark from the user's service address; insert an **outbound** `contract_threads` row with the new Postmark `MessageID` and the attachment metadata; flip `status` back to `sent` (awaiting counterparty).
- Turn model: reuse the existing toggle — user replies → `sent` (in progress, awaiting them); they reply → `replied` (needs you). No enum or `sort_group` change; it maps onto the current dashboard grouping directly.

**Frontend:**
- `components/ReplyComposer.tsx` on `contracts/[id].astro`: a message box + "attach modified version" file input + Send. Visible whenever the latest thread entry is inbound (it's the user's turn). On send, append the new outbound entry to the thread and set status to "awaiting reply".

**How to test end-to-end (depends on Component 4 being testable):**
1. From a `replied` contract, write a counter-message, attach a modified PDF, send.
2. Verify: outbound `contract_threads` row with a `postmark_message_id` and the attachment in GCS; `contracts.status='sent'`; the counterparty receives a properly threaded `Re:` email with the PDF.
3. Reply again from the counterparty → Component 4 matches the new `In-Reply-To` against *this* outbound message → thread continues, status → `replied`. Repeat once more to prove 3+ rounds chain correctly.
4. Threading sanity: confirm the whole exchange stays in one email thread in the counterparty's client.

**End state:** full multi-round negotiation — the user can counter with text and a revised document, and every round threads correctly.

---

### Component 6 — Live Dashboard Updates (SSE + LISTEN/NOTIFY) ⬜ — Issue 2

**What this builds:** the dashboard and contract page update in near-real time when a reply/received contract arrives — no manual refresh. Replaces the "refresh after 20 seconds" placeholder.

**Backend:**
- `lib/events.ts`: on boot, open one dedicated `LISTEN user_updates` connection (postgres-js); its callback re-emits onto an in-process `EventEmitter`. Export `notifyUser(userId, payload)` that runs `NOTIFY`.
- `routes/events.ts`: `GET /api/events` (SSE, `requireAuth`). On connect, send the current state for the user's open contracts (per Principle 7), then stream subsequent `event: status` messages filtered to that user. Set SSE headers (`text/event-stream`, `no-cache`, keep-alive); send periodic comment pings to keep intermediaries from closing the line.
- Call `notifyUser(ownerId, {contractId, status})` at the end of `processInbound()` (Component 4), from the reply path (Component 5), and from the received-contract branch (Component 7).

**Frontend:**
- `components/LiveStatus.tsx`: a React island that opens an `EventSource` to `/api/events`, updates the relevant row/badge on each event, and **refetches current state on (re)connect**. Mount on `dashboard.astro` and `contracts/[id].astro`.

**How to test end-to-end:**
1. Open the dashboard. Trigger a reply (Component 4) from another account.
2. Without refreshing, the contract moves to "Needs Attention"/`replied` within ~1–2s.
3. Kill the connection (DevTools → offline → online); confirm the island reconnects and the state is still correct (refetch-on-connect).
4. Confirm scale-to-zero: with no dashboard open, Cloud Run reports 0 instances; opening the dashboard spins one up and SSE connects.

**End state:** live status with no manual refresh; works across Cloud Run instances; idle cost stays at zero.

> Depends on Component 4 being testable. If Postmark is still verifying, develop and unit-exercise this against a manual `NOTIFY` from a `psql` session, then re-verify with a real reply once Postmark clears.

---

### Component 7 — Intra-domain Received-Contract Inbox ⬜ — Issue 1

**What this builds:** when a Genie user sends a contract to another Genie user's service address, the recipient sees it in-app as a received contract. Closes the gap where intra-platform sends vanished into processing.

**Schema (additive migration):**
- Add `origin` enum (`created` | `received`), column on `contracts` default `created`.
- Add `received` to the `contract_status` enum.
- `db:generate` + `db:push`. (No change to Better Auth tables; `tablesFilter` stays.)

**Backend (`processInbound` branch):**
- After resolving the recipient user, check for an `In-Reply-To` match among **that user's** outbound threads.
  - Match → existing reply path (Component 4).
  - No match, address resolves to a Genie user → **received-contract path:** create a `contracts` row owned by the recipient (`origin='received'`, `status='received'`, `recipient_*` = sender, PDF attachment → `contracts/{recipientId}/{newId}/original.pdf`), insert an inbound `contract_threads` row, then `notifyUser(recipientId, …)`.
- Keep the `inbound/{userId}/{messageId}.pdf` fallback only for genuinely unroutable mail.

**Frontend:**
- Dashboard "Received" group (driven by the existing `sort_group` query — `received` maps to group 1).
- `contracts/[id].astro` renders received contracts read-only-to-start: sender, received date, download, thread.

**How to test end-to-end (two Genie accounts):**
1. As User A, send a contract to User B's service address (`…@mail.usetend.in`).
2. As User B, see it appear under "Received" (live updates via Component 6), with the PDF downloadable.
3. Verify a new `contracts` row exists for B with `origin='received'`, `status='received'`.
4. As User B, use the reply composer (Component 5) to counter back to A; confirm A receives it as a threaded reply on contract A.
5. Regression: an external (non-Genie) reply still follows the Component 4 reply path, not this branch.

**End state:** Genie-to-Genie sends are visible to the recipient; the platform is no longer "external recipients only".

---

### Component 8 — E-Signature via Dropbox Sign ⬜ ★ THE CORE DELIVERABLE

**Why this is the headline.** Every component before this exists to get a document to the point of signature. This component is the product's reason to exist: the user gets a finished contract **signed by every required party**, multi-party and in order, with signers who need no Genie account, all without leaving the app or hand-driving DocuSign. Build it as the priority feature once the receive/live loop (4/6) is in place — it does not depend on the AI diff (9) and delivers the core story on its own.

**Reference:** the full design is in the "Signing Flow" section above. Grounded against `@dropbox/sign` **v1.11.0** (current 2026-05) — confirm the version at build time.

**Backend:**
- `npm install @dropbox/sign`. Add `DROPBOX_SIGN_API_KEY`, `DROPBOX_SIGN_TEST_MODE=true`.
- Schema migration (additive): `contract_signers` table; `signature_request_id` + `signed_storage_key` on `contracts`; new statuses `out_for_signature` / `partially_signed` / `signed`; `signer_status` + `signer_role` enums; add `system` to `thread_direction`. `db:generate` + `db:push` (enum-append caveat as in Component 7; `tablesFilter` still protects Better Auth tables — confirm no `DROP`).
- `services/dropboxSignClient.ts`: `sendSignatureRequest({ pdfStream, title, subject, message, signers })` using `SignatureRequestApi.signatureRequestSend` with `testMode`, per-signer `order`; `verifyCallback(apiKey, data)` via `EventCallbackHelper.isValid(apiKey, EventCallbackRequest.init(data))`; `downloadSignedFile(id)` via `signatureRequestFiles(id, 'pdf')` (handle the 409 "not ready yet" by waiting for the `downloadable` event).
- `POST /api/contracts/:id/send-for-signature` (`requireAuth`): owner check; resolve each signer's email — **if `genie_user_id`, use their real identity email, never the `…@mail.usetend.in` service address**; create the request; persist `contract_signers` + `signature_request_id`; status → `out_for_signature`; `notifyUser`.
- `POST /webhooks/dropbox-sign/inbound`: parse the **multipart `json` field** (`c.req.parseBody()`); verify `event_hash`; idempotency on `(signature_request_id, event_type, signature_id)`; apply the state machine (`signed`→per-signer + `partially_signed`; `all_signed`→`signed`; `downloadable`→fetch PDF→`signed_storage_key`; `declined`→`negotiating`); append `system` thread rows; `notifyUser`; **return `Hello API Event Received`**.
- `GET /api/contracts/:id/signed-document`: v4 signed URL to `signed.pdf`.

**Frontend:**
- `SignerForm.tsx`: add 1–4 signers (name, email, order, role); "Send for Signature". Show only when a version is agreed (status `replied`/`negotiating`/`sent`, owner's turn).
- `SigningTimeline.tsx`: the per-signer roster on the thread ("Counterparty viewed → signed → Awaiting your boss"), updated live via `LiveStatus` (Component 6). A "Download signed contract" button appears at `status='signed'`.
- For a Genie signer, an "Awaiting your signature" card on their dashboard (driven by the webhook + SSE).

**How to test end-to-end (Dropbox Sign test mode — free):**
1. Send a contract for signature to **two** signers in order (e.g. an external email `order:0`, your own second email `order:1`).
2. Signer 0 gets an email, opens the no-auth link, signs → webhook → that signer shows `signed`, contract `partially_signed`, dashboard updates live. Confirm signer 1 is emailed only now.
3. Signer 1 signs → `all_signed` → contract `signed`; `downloadable` → `signed.pdf` in GCS; "Download signed contract" returns the executed (watermarked, in test mode) PDF.
4. Decline path: a signer declines → contract → `negotiating`; the reply composer (5) reappears.
5. Verify webhook authenticity: a POST with a bad `event_hash` → 401; a correct one → `Hello API Event Received`.

**End state:** a contract goes from agreed document to fully executed PDF, multi-party and ordered, with non-Genie signers, entirely inside Genie — the product's core promise.

---

### Component 9 — AI Contract Diff Analysis ⬜ (git-style, LLM-free detection)

**Build trigger:** after the negotiation loop (5), the live loop (6), the inbox (7), and ideally signing (8) work end-to-end. This enhances the *negotiation* phase — it tells a human what changed so they can decide whether to sign.

**Reference:** full design in the "Diff Architecture" section above. The change *detection* uses **no LLM** — it is the deterministic Myers diff, exactly like `git diff`. An LLM is used only for an optional plain-English summary over the computed diff.

**What this builds:** when a counterparty returns a modified document, compare it to the **previous version** and show a git-style colour-coded diff plus a short plain-English summary, on the contract thread. Each new version is diffed against the immediately preceding one (negotiations run many rounds), not always the original.

**Backend:**
- `npm install diff pdf-parse` (jsdiff **v9** ships its own types — do **not** add `@types/diff`) and the chosen LLM SDK.
- `services/aiAnalysis.ts`: download the new + previous version from GCS → extract text with `pdf-parse` v2.x → normalize whitespace + re-join hyphenated breaks → `diffWords` (word level) for the rendered diff and `structuredPatch` for the LLM input → optional single LLM call over the **patch** (not the documents) for a short summary → write `ai_analysis` (`{ summary, patch }`) to `contracts`; set `ai_started_at`/`ai_completed_at`; status `replied → ai_processing → completed|negotiating`.
- Trigger async at the end of `processInbound()` when an inbound PDF is present (non-blocking). `notifyUser` on completion.
- Graceful failure: on LLM error, still resolve (`completed`, diff present, empty summary) — never an infinite spinner. The deterministic diff always succeeds even if the LLM is down.

**Frontend:**
- `ReplyViewer.tsx`: when `ai_analysis` is present, show the summary + "View Full Diff" + "Download Their Version".
- `DiffViewer.tsx`: **`react-diff-viewer-continued`** side-by-side, word-level green/red, collapsible unchanged regions. (`diff2html` is the lightweight unified-diff-string alternative; Monaco is too heavy for read-only prose.)
- `LiveStatus` handles the `ai_processing → completed` transition (skeleton → populated).

**How to test end-to-end:**
1. Reply with a modified PDF. Watch status go `replied → ai_processing → completed` live.
2. The side-by-side diff shows the exact words added/removed; the summary reads plainly; "Download Their Version" works.
3. Honest check: confirm the diff is sane on real reflowed PDF text (word-level + normalization); note any roughness.
4. Failure path: invalidate the LLM key, send a reply — the diff still renders, summary is empty, no infinite spinner.

**End state:** automatic, git-style change detection with a plain-English summary on every returned document — feeding the human's decision to sign or counter.

---

### Component 10 — Polish + Demo Prep ⬜

**What this builds:** on-brand UI, loading states, and a rehearsed demo.

- Extract Genie AI design tokens (color, radius, font, button style) into the Tailwind config.
- Loading skeletons on the dashboard while data fetches; verify all screens at 375px.
- Empty/error states for every page.
- Full smoke test across Components 1–9 from a clean browser session.
- Demo accounts: two Genie users (for the intra-domain demo), one external recipient mailbox, one external signer mailbox, one pre-sent contract ready for the counter-offer path, and one agreed contract ready for the signing demo.
- Record Loom: signing happy path (~3 min — send for signature → external party signs with no account → second party signs → executed PDF), and the negotiate + AI-diff path (~3 min).

**End state:** polished, on-brand, reliable end-to-end; demo runnable in under 5 minutes from a standing start.

---

## Key Technical References

### Hono
Lightweight TS HTTP framework. Register handlers/middleware; `c` carries request, response helpers, and values set by middleware (`c.get('user')`). Better Auth interoperates directly: `app.on(['GET','POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))` — both speak the Web Fetch API.

### Better Auth
Google social provider, identity-only (omit `scopes` → defaults to `openid email profile`; omit `accessType` → online → no refresh token). `database` is a `pg` Pool on the **direct** Neon URL. `session.cookieCache:false` avoids a v1.x silent-expiry bug. `advanced.defaultCookieAttributes:{sameSite:'none',secure:true}` for cross-origin. `databaseHooks.user.create.after` runs after commit — safe to query/insert there.

### Drizzle (postgres-js)
App tables only. `client.ts` uses the **pooled** Neon URL (`max:10`). `drizzle.config.ts` uses the **direct** URL for migrations and `tablesFilter` to protect Better Auth's tables. Use `db.query.*` for simple reads/writes; drop to raw SQL for the aggregation queries above.

### Postmark
`new postmark.ServerClient(token)`; `client.sendEmail({ From, To, Subject, TextBody, HtmlBody, Attachments:[{Name,Content(base64),ContentType}], MessageStream:'outbound' })` → `{ MessageID }`. Inbound webhook payload key fields: `OriginalRecipient` (route by local-part), `MessageID` (idempotency key), `Headers[].In-Reply-To` (link to contract), `Attachments[].Content` (base64). Postmark retries non-200 up to 10×.

### Postgres LISTEN/NOTIFY (Component 6)
`NOTIFY channel, 'payload'` publishes; a connection running `LISTEN channel` receives it. Fire-and-forget — not queued. With postgres-js, a dedicated connection's `listen(channel, cb)` keeps the line open. One LISTEN connection per Cloud Run instance; in-process `EventEmitter` fans out to that instance's SSE clients.

### SSE
Response headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Write `event: <type>\ndata: <json>\n\n` per message; send `: ping\n\n` comments periodically. Browser side: `new EventSource('/api/events', { withCredentials:true })`; it auto-reconnects on drop — refetch current state in `onopen`.

### Dropbox Sign (Component 8)
SDK `@dropbox/sign` **v1.11.0** (current 2026-05; verify at build time). `new api.SignatureRequestApi(); apiCaller.username = API_KEY` (HTTP Basic). Send: `signatureRequestSend({ title, subject, message, files:[stream], signers:[{ name, emailAddress, order }], testMode })` → `{ signatureRequestId }`. **Ordered signing:** per-signer `order` integer, lower signs first; equal/omitted ⇒ parallel. **Email-link flow needs no signer account** (default; embedded is the only flow needing a `client_id`+iframe — we don't use it). **Webhook:** `multipart/form-data` with a field named `json`; verify `event.event_hash` (HMAC-SHA256 of `event_time+event_type`, key = API key) via `EventCallbackHelper.isValid(apiKey, EventCallbackRequest.init(data))`; **must respond `Hello API Event Received`** or it retries (1+6 over ~30h, auto-clears the URL after ~10 failures). Events: `signature_request_sent|viewed|signed|all_signed|downloadable|declined`. **Download executed PDF:** `signatureRequestFiles(id,'pdf')` (409 until assembled — fetch on the `downloadable` event). **Test mode:** free dev account runs the whole flow; PDFs are watermarked/non-binding — production binding signatures need a paid plan (402 without one).

### diff / pdf-parse / LLM (Component 9 — git-style, LLM-free detection)
`diff` (**jsdiff v9.0.0**) implements **Myers diff** — deterministic, no AI, like `git diff`. Use **`diffWords`** (word level — correct for legal prose; `diffLines` is too coarse) for rendering and **`structuredPatch`** for the LLM input. jsdiff v8+ bundles its own types — do not install `@types/diff`. **`pdf-parse` v2.x** (rewritten, TS/ESM, maintained) extracts text; PDF extraction is **lossy** — normalize whitespace + re-join hyphenated breaks before diffing; `mammoth` is a cleaner path for DOCX. Render with **`react-diff-viewer-continued` v4.x** (side-by-side, word-level highlight, collapsible) — Monaco's diff editor is too heavy for read-only prose; `diff2html` v3.x is the unified-diff-string alternative. The optional LLM summary runs over the **computed patch**, never the whole documents.

### GCS signed URLs
SA needs `roles/iam.serviceAccountTokenCreator` on itself for v4 SignBlob. `file.getSignedUrl({version:'v4',action:'read',expires,responseDisposition})`. ADC is automatic on Cloud Run; local dev uses `gcloud auth application-default login`.

---

## Known Risks

- **Postmark verification (active blocker).** Outbound send is tested; inbound is built but unverified end-to-end until the Postmark account clears. Components 4–8 all depend on real inbound, so verifying Postmark is the critical path. Component 6 (SSE) can be developed against manual `NOTIFY` in the meantime.
- **`In-Reply-To` ↔ `MessageID` matching (verify first).** The inbound matcher compares the reply's `In-Reply-To` header against the stored Postmark `MessageID`, but the email `Message-ID:` header Postmark emits is usually `<{MessageID}@domain>`. The handler strips `< >` but may leave an `@domain` suffix — if so it won't match even on round 2. All multi-round threading (Components 4 & 5) depends on this; normalize and test it as the very first inbound check once Postmark clears.
- **Reply threading.** Outbound replies (Component 5) must set `In-Reply-To`/`References`, or the counterparty's next reply can't be matched back to the contract. This is a hard requirement, not a nicety.
- **SSE behind proxies.** Cloudflare and Cloud Run buffer/timeout long connections. Mitigated by keep-alive pings, refetch-on-connect, and `EventSource` auto-reconnect.
- **`NOTIFY` is not durable.** Acceptable by design (Principle 7) — the row is the truth and is read on every load.
- **Intra-domain addressing.** A user must send to the *service* address (`…@mail.usetend.in`) for the received-contract path to fire. Sending to a counterparty's personal email is just the normal external flow.
- **Signing link must use a signer's REAL email.** Never send a Dropbox Sign request to a Genie user's `…@mail.usetend.in` service address — that routes to Postmark inbound (no readable inbox) and the signing link is lost. Use the Genie user's Google identity email; non-Genie signers use whatever address the user typed. (See Signing Flow → "the two angles".)
- **Dropbox Sign test mode is watermarked / non-binding.** The POC runs in `testMode` (free, full flow). Executed PDFs are watermarked and not legally valid; real binding signatures need a paid API plan ($75/mo Essentials), and sending production requests without one returns HTTP 402. Acceptable for a demo — call it out explicitly.
- **Dropbox Sign webhook shape + response.** The payload is `multipart/form-data` with a `json` field (not a JSON body), and the handler **must** reply with the literal `Hello API Event Received` or Dropbox Sign retries and eventually disables the callback URL. Verify `event_hash` before trusting any event.
- **`all_signed` vs `downloadable`.** Mark the contract `signed` on `all_signed`, but fetch the executed PDF on `downloadable` — `signatureRequestFiles` returns 409 until the file is assembled, which can lag `all_signed` slightly.
- **AI diff latency/cost + PDF lossiness.** Text extraction + the optional LLM summary run async; the UI shows a skeleton and never blocks; failures resolve cleanly (the deterministic diff still renders without the LLM). PDF-extracted text is lossy — word-level diff + whitespace normalization keep it readable but expect occasional roughness on heavily reflowed documents.

---

## Demo Script

**Signing happy path (~3 min — the headline):** Login (no Gmail consent) → upload an agreed PDF → **Send for Signature** to two parties in order (an external party with no Genie account, then yourself/your boss) → the external party opens the emailed link, reads, and signs **without any account** → the contract thread updates live ("Counterparty signed") and the second signer is emailed → second party signs → status flips to **`signed`** live → download the **executed PDF**. The whole signing ceremony happened inside Genie, driven by webhooks — no DocuSign, no manual chasing.

**Negotiate + AI-diff path (~3 min):** Send a contract for review → recipient replies with edits → dashboard updates live (no refresh) → a **git-style diff** shows exactly what changed, with a plain-English summary → **counter back from the app with a revised version** → once agreed, hand off into the signing flow above.

**Intra-domain path (~2 min):** As User A, send a contract to User B (a Genie user). Switch to User B's dashboard — the contract appears under "Received" live, with the document attached and the thread intact.

**The pitch:** the product takes a contract from "drafted" to "signed by everyone" in one place. Multi-party, ordered e-signature via Dropbox Sign with signers who need no account; a webhook-driven signing timeline that updates live; git-style change detection (no LLM in the loop) so a human can decide before signing; identity-only OAuth (no inbox blast radius); per-user service addresses; and an event-driven pipeline on a scale-to-zero backend — built the way a production system would be from day one.

---

## Changelog

- **2026-05-26** — Full rewrite. Removed all Gmail API / Pub/Sub / Dropbox Sign content (never built). Replaced the old SQL schema with the actual Drizzle schema. Standardized on `mail.usetend.in`. Locked Components 1–4 to reflect built state (4 test-blocked on Postmark verification). Added the Live Updates Architecture section and Principle 7.
- **2026-05-26 (later)** — Added Component 5 (In-Thread Reply / Negotiation Loop: multi-round reply with counter-document, threading headers, sent/replied turn toggle) right after inbound, and renumbered forward: SSE → Component 6 (Issue 2), intra-domain inbox → Component 7 (Issue 1), AI analysis → Component 8 (now version-over-version), Polish → Component 9. Added the Reply / Negotiation Flow section and two threading risks (Message-ID matching, reply headers).
- **2026-05-26 (signing reinstated)** — **Corrected the scoping error that removed e-signature.** Signing is the product's purpose and is restored as a first-class, headline component. Added **Component 8 — E-Signature via Dropbox Sign** (`@dropbox/sign` v1.11.0): email-link signing (signers need no account), multi-party ordered signing, webhook-driven lifecycle, executed-PDF retrieval, the two signer-address angles (real identity email vs service address), and the decline→renegotiate loop. Renumbered the former Component 8 (AI analysis) → **Component 9**, now specced as **git-style, LLM-free** diff (jsdiff v9 word-level + `pdf-parse` v2.x + `react-diff-viewer-continued`), with the LLM used only for an optional summary over the computed patch. Polish → **Component 10**. New: Signing Flow and Diff Architecture sections; `contract_signers` table + signing statuses/enums + `signature_request_id`/`signed_storage_key`; Dropbox Sign webhook subsection; `send-for-signature`/`dropbox-sign webhook`/`signed-document` endpoints; Dropbox Sign env vars; signing + diff entries in Tech Stack, Key Technical References, Known Risks, and the Demo Script. Reframed the title (→ "Send, Negotiate, Sign"), the Problem, "What We Are Building", and the Scope Boundary Map around signing. Grounded against current (May 2026) Dropbox Sign docs/SDK and diff-library versions via dedicated research.
