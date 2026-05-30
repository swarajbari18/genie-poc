# Plan 03 — Contract Detail Page Redesign

## Purpose

Redesign `frontend/src/pages/contracts/[id].astro` — the most important page in the entire app. A user spends the majority of their time on this page. Currently it is a single-column form-with-cards page with no visual sense of where the contract is in its journey. The redesign introduces a two-column layout, a journey indicator strip, and a conversation thread view that is readable like a chat or email client — not like a developer log.

---

## Current Problems

1. **Brand**: all blue, no brand tokens
2. **Status displayed as a grey button**: the status badge in the header (`<span class="btn" style="background: #e2e8f0; color: #475569; pointer-events: none;">{contract.status}</span>`) displays the raw DB enum. It doesn't tell the user what stage they are in.
3. **Thread view is a log file**: all thread entries look identical — a dot, a line, then text. Outbound (you sent), inbound (counterparty replied), and system events (signing lifecycle) use the same visual treatment. There is no way to tell direction without reading the text.
4. **Thread ordered newest-first**: `orderBy: [desc(contractThreads.emailDate)]` — the most recent message is at the top, which means you read the conversation backwards. Correct order is oldest first (chronological), newest at the bottom.
5. **Reply composer only shows on `replied`**: the condition at line ~239 only checks `contract.status === 'replied'` or a received-origin variant. The `negotiating` status (which is what the contract moves to after a second round of back-and-forth) does not show the composer. This is a dead end — the user has no way to continue negotiating.
6. **Signing form shows on draft**: the conditions that control which actions appear on the page include `'draft'` in the `allowedStatuses` list, so the "Send for Signature" section appears before the contract has even been sent to anyone.
7. **"Send for Review" and "Send for Signature" as parallel peers**: they appear as two separate cards of equal weight, suggesting you can do either at any time. The product truth is: "Send for Review" initiates the contract journey; "Send for Signature" only happens after review/negotiation has been concluded.
8. **SSE causes full reload**: `window.location.reload()` on any status event. On this page, a smarter targeted update is possible for common transitions.
9. **No loading state after submit**: after clicking "Send for Review", the button disables and says "Sending..." but the page then reloads cold — there is no skeleton or progress indicator during the reload.
10. **Three separate DB queries**: Plan 07 fixes this on the backend (one `LEFT JOIN + json_agg` query). This plan assumes Plan 07 is done; it describes only the frontend rendering.

---

## Layout Design

### Two-Column Layout (desktop ≥ 768px)

```
[Header strip: contract title + stage indicator]
─────────────────────────────────────────────────
[Left column 60%]         [Right column 40%]
Document / Actions        Activity / Thread
```

Left column contains:
- Document metadata card (title, recipient, file download link)
- The primary action area (changes based on status — described in Plan 04)
- If a diff is available: the `DiffViewer` React island and version history panel (Plan 08)

Right column contains:
- The full email thread (conversation between you and counterparty)
- System timeline events (contract sent, signed, etc.)
- Reply composer (when applicable)

On mobile (< 768px): columns stack vertically. Right column (activity) comes second.

### Stage Indicator Strip

A horizontal row of 5 numbered stages sits immediately below the header. This is a "stepper" component.

```
① Draft → ② Sent → ③ Under Review → ④ Signing → ⑤ Executed
```

Each stage is a small circle with a number and a label beneath it. Active stage: `var(--color-accent)` fill, white number. Completed stages: `var(--color-brand-mid)` fill, white checkmark. Future stages: `var(--color-border-default)` fill, `var(--color-text-muted)` number.

Map DB status to active stage using the same table from Plan 00:
- `draft` → stage 1
- `sent`, `ai_processing` → stage 2
- `received`, `replied`, `negotiating`, `partially_signed` → stage 3
- `out_for_signature` → stage 4
- `completed`, `signed` → stage 5
- `declined` → special treatment: mark stage 3 with a red ✕ icon instead of a circle

The stage indicator is purely presentational, derived from the SSR'd `contract.status`. No client-side state needed.

---

## Thread / Activity Feed Redesign

### Data Shape

The thread array returned from `GET /api/contracts/:id` contains entries of two types:
1. **Email thread entries**: `direction = 'outbound' | 'inbound'`, `fromName`, `body`, optional `attachmentStorageKey`, `emailDate`
2. **System events**: `direction = 'system'`, `body` describes the event (e.g. "Contract sent for signature"), `emailDate`

### Visual Treatment

**Outbound messages (you sent)**:
- Right-aligned bubble or right-leaning card
- Background: `var(--color-border-light)` (`#F2E7FE`)
- Border-left: `3px solid var(--color-accent)`
- Label above: "You" in small caps, muted

**Inbound messages (counterparty replied)**:
- Left-aligned
- Background: `#FFFFFF`, border: `1px solid var(--color-border-default)`
- Label above: sender name/email in small caps, muted
- If attachment: show a PDF download chip (styled with an icon and the actual filename — not "contract.pdf" — this depends on Plan 07's filename fix)

**System events**:
- Centred narrow pill: `#F9F9F9` background, `var(--color-text-muted)` text
- No bubble / no border treatment
- Examples: "Contract sent to alice@example.com · 3 Jan", "Signature request sent", "Contract executed"

### Order

Reverse the current `orderBy: [desc(contractThreads.emailDate)]` query in the `GET /:id` handler (`contracts.ts`) to `asc`. Oldest message first, newest at the bottom. This is how every email client, chat app, and chat interface in the world works. Currently the thread reads in reverse — the most recent reply is at the top.

This change is in `contracts.ts` `GET /:id` endpoint. It's a one-word change in the Drizzle `orderBy`. Do it as part of this plan's implementation but note it is also referenced in Plan 07.

### Scroll

The thread column should have `overflow-y: auto` with a maximum height (e.g., `calc(100vh - 200px)`). When a new message arrives via SSE, the thread should scroll to the bottom. Use `element.scrollTop = element.scrollHeight` in the SSE client script.

---

## Reply Composer

The reply composer is a `<textarea>` plus file attachment input plus a "Send Reply" button. It currently only appears when `contract.status === 'replied'`. 

Fix the condition to: show the composer whenever `['replied', 'negotiating'].includes(contract.status)` for the contract owner, OR when `contract.origin === 'received' && ['received', 'replied', 'negotiating'].includes(contract.status)` for the receiving party.

The composer lives at the bottom of the right column (thread column). It sits below all thread entries, anchored to the bottom of the column.

Styling: white background card, `var(--radius-card)` radius, light border. The `<textarea>` uses `var(--color-bg-subtle)` background. The "Send Reply" submit button uses `.btn-primary`.

---

## Action Area (Left Column)

The primary action area is discussed in detail in Plan 04. In summary:

- If `status === 'draft'`: show the "Send for Review" form (recipient name, email)
- If `status` is in the "In Review" cluster (`received`, `replied`, `negotiating`): show the "Initiate Signing" section — but NOT as a visible form. Show it as a collapsed card or secondary action. The dominant action in this state is replying via the thread.
- If `status === 'out_for_signature'` or `partially_signed`: show the signing status timeline (Plan 05)
- If `status === 'completed'` or `signed`: show the "Download Executed Contract" card with the GCS signed URL
- Remove `'draft'` from any condition that currently shows signing options

---

## SSE Targeted Update (Contract Page)

The SSE handler at line ~459 of `[id].astro` calls `window.location.reload()`. Replace with a more surgical approach:

- If `newStatus` maps to the same stage as `currentStatus` in the 5-stage model: update the stage indicator's active stage and the status badge text in place. Scroll thread column to bottom.
- If `newStatus` moves to a different stage (e.g., `ai_processing → completed` moves from stage 2 to stage 3, or `replied → out_for_signature` moves from stage 3 to stage 4): the action area content changes substantially — fall back to `window.location.reload()`. This is acceptable because stage transitions are infrequent.
- If `newStatus === 'ai_processing'`: show a spinner in the left column action area and suppress the action buttons while processing.

---

## Files to Modify

| File | Changes |
|---|---|
| `frontend/src/pages/contracts/[id].astro` | Full layout, stage indicator, thread redesign, action area logic, SSE handler |
| `backend/src/routes/contracts.ts` (GET /:id) | Change thread `orderBy` from `desc` to `asc` |

## Files to Reference

| File | Why |
|---|---|
| `frontend/src/layouts/AppLayout.astro` | Shared header/shell (Plan 01) |
| `frontend/src/styles/global.css` | Token variables (Plan 01) |
| `frontend/src/components/DiffViewer.tsx` | React island — slot it into the left column when diff data is available (see Plan 08) |
| `approach.md` §4 | Defines the GET /:id response shape: contract + threads + signers + latestDiff |
