---
name: project-open-issues
description: Two known design gaps in Genie POC identified during end-to-end testing — intra-domain inbox and manual dashboard refresh
metadata:
  type: project
---

Two open issues logged in `plans/open-issues.md`. Both DESIGNED 2026-05-26 (decisions recorded in that file and scheduled as components in `approach.md`); neither implemented yet. Note: a new Component 5 (In-Thread Reply / Negotiation Loop — multi-round reply with counter-document) was inserted ahead of both, so the issue components are 6 and 7.

**Issue 1 — Intra-domain recipient has no inbox → Component 7**
Emails to `mail.usetend.in` go to Postmark inbound MX, not any readable inbox; a Genie-to-Genie send vanishes into processing.
**Decision:** build a full in-app inbox by REUSING the `contracts` table — add `origin` enum (`created`|`received`) + a `received` status. A received contract is a first-class `contracts` row owned by the recipient, so thread view / SSE / AI all work on it for free. No separate table. `recipient_*` holds the counterparty (the sender, for received). Webhook branches: `In-Reply-To` matches the user's outbound → reply; no match + address resolves to a Genie user → received-contract.
**How to apply:** when touching the inbound webhook or dashboard grouping, respect the `origin`/`received` model; received contracts surface in a "Received" group.

**Issue 2 — Dashboard manual refresh → Component 6**
Webhook updates the DB but the browser isn't told.
**Decision:** SSE backed by Postgres `LISTEN`/`NOTIFY` (cross-instance bus, since webhook and SSE connection can hit different Cloud Run instances). Scale-to-zero stays ON (an open SSE keeps an instance alive; otherwise scales to zero and the next load reads current state). Rejected pin-to-one-instance and SSE-polls-DB. Principle: DB is source of truth, `NOTIFY` is liveness-only (not durable); client refetches state on every (re)connect.
**How to apply:** applies to both dashboard list and contract detail; never rely on a pushed event to carry state that isn't persisted.
