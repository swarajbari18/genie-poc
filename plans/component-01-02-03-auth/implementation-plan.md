# Genie AI POC — Master Implementation Plan
## Postmark-based Contract Workflow (Replaces Gmail Architecture)

**Written:** 2026-05-24  
**Verified against live docs:** 2026-05-24  
**Replaces:** previous plan using Gmail API + Pub/Sub (rejected — see architecture decision below)

---

## Architecture Decision Record

The original plan used Gmail API with `gmail.readonly` + `gmail.send` OAuth scopes and Pub/Sub push notifications. This is rejected:

- `gmail.readonly` grants full inbox access — unacceptable on a personal Google account
- Google requires a CASA Tier 2 security audit ($4k–$75k) to exceed 100 users with restricted scopes
- Pub/Sub watching a personal inbox is a security liability
- A legal AI company would flag this as a serious design flaw

**Chosen architecture:** Google OAuth for identity only (`openid email profile`). Email via Postmark — each user gets a dedicated service address (e.g. `alice-x7k2@mail.usetend.in`). MX record for `mail.usetend.in` → Postmark inbound. Replies are delivered via Postmark webhook.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              GENIE AI POC                                        │
└─────────────────────────────────────────────────────────────────────────────────┘

  BROWSER                CLOUDFLARE WORKERS             CLOUD RUN (europe-west2)
  ───────                ──────────────────             ───────────────────────────
  Astro frontend    ←──→  Astro SSR (no auth logic)  ←──→  Hono backend (Node.js)
  (index, dashboard,                                         │
   upload, thread)        Forwards session cookie            │
                          to backend on every SSR            │
                          fetch                              │
                                                            ├── Better Auth
                                                            │   (Google OAuth identity)
                                                            │
                                                            ├── Drizzle ORM
                                                            │   (postgres driver)
                                                            │
                                                            ├── @google-cloud/storage
                                                            │   (contract PDFs)
                                                            │
                                                            └── postmark SDK
                                                                (send + inbound)

  EXTERNAL SERVICES
  ─────────────────
  Google OAuth          → identity only (openid email profile)
                          NO Gmail access. NO refresh tokens for email.

  NeonDB Postgres 16    → application data
  (aws-eu-west-2)         Better Auth tables (user, session, account, verification)
                          App tables (service_emails, contracts, contract_threads,
                                      inbound_emails)

  GCS europe-west2      → contract PDF storage
  (genie-poc-contracts)   Private bucket, signed URLs for download

  Postmark              → outbound sending + inbound parsing
                          Domain: mail.usetend.in
                          MX record: inbound.postmarkapp.com

  DNS (mail.usetend.in)
  MX  10  inbound.postmarkapp.com       ← all inbound email
  TXT     DKIM record (Postmark-provided)
  CNAME   pm-bounces.mail.usetend.in → pm.mtasv.net   (bounces)
  TXT     v=spf1 a mx include:spf.mtasv.net ~all

  SEND FLOW
  ─────────
  User uploads PDF + enters recipient email
    → Backend stores PDF in GCS
    → Postmark sends: From: alice-x7k2@mail.usetend.in, To: recipient@company.com
    → contracts row: status = 'sent', postmarkMessageId stored

  INBOUND REPLY FLOW
  ──────────────────
  Recipient replies to alice-x7k2@mail.usetend.in
    → MX routes to Postmark
    → Postmark POSTs JSON to POST /webhooks/postmark/inbound
    → Backend extracts OriginalRecipient local-part → looks up user
    → Idempotency check on MessageID → skip if already seen
    → PDF attachment decoded from base64 → uploaded to GCS
    → contract_threads row inserted
    → contracts status → 'replied'
    → AI pipeline stub triggered (async)
```

---

## 2. Prerequisites Checklist

Complete every item before writing a line of code.

### 2.1 GCP Setup

- [ ] Create GCP project (e.g. `genie-poc`)
- [ ] Enable APIs: Cloud Run API, Cloud Build API, Cloud Storage API, Secret Manager API
- [ ] GCS bucket `genie-poc-contracts` already exists in `europe-west2` — confirm uniform access control is on:
  ```bash
  gcloud storage buckets update gs://genie-poc-contracts --uniform-bucket-level-access
  ```
- [ ] Create a Service Account for Cloud Run (e.g. `genie-poc-backend@genie-poc.iam.gserviceaccount.com`)
- [ ] Grant the SA these roles on the bucket:
  ```bash
  gcloud storage buckets add-iam-policy-binding gs://genie-poc-contracts \
    --member="serviceAccount:genie-poc-backend@genie-poc.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"
  ```
- [ ] Grant the SA `serviceAccountTokenCreator` on itself (required for signed URL generation):
  ```bash
  gcloud iam service-accounts add-iam-policy-binding \
    genie-poc-backend@genie-poc.iam.gserviceaccount.com \
    --member="serviceAccount:genie-poc-backend@genie-poc.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountTokenCreator"
  ```
- [ ] Delete Pub/Sub resources (no longer needed):
  ```bash
  gcloud pubsub subscriptions delete gmail-push-sub
  gcloud pubsub topics delete gmail-push-notifications
  ```

### 2.2 Google OAuth Setup

- [ ] Google Cloud Console → APIs & Services → OAuth 2.0 Client IDs → Web Application
- [ ] Authorized redirect URIs:
  - `http://localhost:8080/api/auth/callback/google`
  - `https://YOUR_CLOUD_RUN_URL/api/auth/callback/google`
- [ ] Authorized JavaScript origins:
  - `http://localhost:4321`
  - `https://YOUR_CLOUDFLARE_WORKERS_URL`
- [ ] OAuth consent screen → Testing mode → add your own email as test user
- [ ] **Do NOT enable Gmail API** — it is not needed

### 2.3 Postmark Setup

- [ ] Create a Postmark account at postmarkapp.com
- [ ] Create a Server (e.g. "Genie POC")
- [ ] In the server, go to **Default Transactional Stream** → note the **Server API Token**
- [ ] Go to **Settings → Inbound** → set the inbound domain to `mail.usetend.in`
  - This gives you a unique inbound address like `abc123@inbound.postmarkapp.com`
  - Set the **Webhook URL** to: `https://YOUR_BACKEND_URL/webhooks/postmark/inbound`
  - Set **Basic Auth** credentials on the webhook URL (you configure these — note them as `POSTMARK_INBOUND_WEBHOOK_USER` and `POSTMARK_INBOUND_WEBHOOK_PASS`)
- [ ] Add `mail.usetend.in` as a **Sending Domain** (not a Sender Signature):
  - Postmark UI: **Sender Signatures → Add Domain**
  - Postmark will show you the exact DKIM and Return-Path DNS records to add

### 2.4 DNS Records for `mail.usetend.in`

Add these to your DNS provider (the exact DKIM record values come from Postmark):

```
# Inbound routing
mail.usetend.in.                    MX  10  inbound.postmarkapp.com.

# Outbound DKIM (values provided by Postmark after adding the domain)
{selector}pm._domainkey.mail.usetend.in.  TXT  "k=rsa; p={KEY_FROM_POSTMARK}"

# Bounce handling
pm-bounces.mail.usetend.in.         CNAME  pm.mtasv.net.

# SPF (optional but recommended)
mail.usetend.in.                    TXT  "v=spf1 a mx include:spf.mtasv.net ~all"
```

Allow up to 24 hours for DNS propagation. Verify in Postmark dashboard.

### 2.5 NeonDB Setup

- [ ] NeonDB project already exists at `aws-eu-west-2`, database `genie_poc` — confirm it is accessible
- [ ] Get both connection strings from the NeonDB console:
  - **Direct** (for migrations): `postgresql://user:pass@ep-xxx.eu-west-2.aws.neon.tech/genie_poc?sslmode=require`
  - **Pooled** (for app runtime): `postgresql://user:pass@ep-xxx-pooler.eu-west-2.aws.neon.tech/genie_poc?sslmode=require`
- [ ] Store both in your password manager

### 2.6 Cloudflare Setup

- [ ] Cloudflare account with your account ID noted
- [ ] Cloudflare API token with "Edit Cloudflare Workers" permission

### 2.7 Generate Secrets Locally

```bash
# BETTER_AUTH_SECRET — Better Auth's official recommended command
openssl rand -base64 32

# POSTMARK_INBOUND_WEBHOOK_PASS — a password for Postmark's basic auth
openssl rand -base64 16
```

---

## 3. Database Schema

Better Auth auto-creates its own tables (`user`, `session`, `account`, `verification`) on first request. We create our application tables via Drizzle migrations. The two schemas coexist on the same NeonDB database without conflict — Better Auth uses a `pg Pool`, Drizzle uses a `postgres` client.

### 3.1 Drizzle Schema (`backend/src/db/schema.ts`)

```typescript
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const contractStatusEnum = pgEnum('contract_status', [
  'draft',        // created but not sent
  'sent',         // Postmark accepted the send
  'replied',      // Postmark inbound webhook received with attachment
  'ai_processing', // AI pipeline running
  'completed',    // AI done, no issues
  'negotiating',  // AI flagged open terms
  'signed',       // parties agreed
  'declined',     // rejected
])

export const threadDirectionEnum = pgEnum('thread_direction', [
  'outbound', // we sent it
  'inbound',  // recipient replied
])

// ---------------------------------------------------------------------------
// serviceEmails — one dedicated address per user
// ---------------------------------------------------------------------------

export const serviceEmails = pgTable(
  'service_emails',
  {
    id: id(),

    // FK → Better Auth's user.id (TEXT/nanoid, not UUID)
    userId: text('user_id').notNull(),

    // The local-part before @, e.g. "alice-x7k2"
    // Used as the inbound routing key — must be globally unique
    localPart: text('local_part').notNull(),

    // Full address, e.g. "alice-x7k2@mail.usetend.in"
    // Denormalized for fast lookups and display
    address: text('address').notNull(),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('se_user_id_uidx').on(t.userId),
    uniqueIndex('se_local_part_uidx').on(t.localPart),
    uniqueIndex('se_address_uidx').on(t.address),
  ],
)

// ---------------------------------------------------------------------------
// contracts — one row per contract document
// ---------------------------------------------------------------------------

export const contracts = pgTable(
  'contracts',
  {
    id: id(),

    // FK → Better Auth's user.id
    userId: text('user_id').notNull(),

    title: text('title').notNull(),

    // GCS object key (relative path inside the bucket)
    // e.g. "contracts/user-123/contract-456/original.pdf"
    // Do NOT store the full gs:// URI — bucket name is in config
    storageKey: text('storage_key').notNull(),

    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull().default('application/pdf'),
    fileSizeBytes: integer('file_size_bytes').notNull(),

    recipientName: text('recipient_name'),
    recipientEmail: text('recipient_email'),

    status: contractStatusEnum('status').notNull().default('draft'),

    // Postmark MessageID returned by the outbound send API
    // Used to match In-Reply-To headers on inbound replies
    postmarkMessageId: text('postmark_message_id'),

    subject: text('subject'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),

    // AI analysis output (stub for now)
    aiAnalysis: jsonb('ai_analysis'),
    aiStartedAt: timestamp('ai_started_at', { withTimezone: true, mode: 'date' }),
    aiCompletedAt: timestamp('ai_completed_at', { withTimezone: true, mode: 'date' }),

    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('contracts_user_id_idx').on(t.userId),
    index('contracts_status_idx').on(t.status),
    index('contracts_user_status_idx').on(t.userId, t.status),
    uniqueIndex('contracts_postmark_msg_id_uidx').on(t.postmarkMessageId),
  ],
)

// ---------------------------------------------------------------------------
// contractThreads — each email in a contract's thread
// ---------------------------------------------------------------------------

export const contractThreads = pgTable(
  'contract_threads',
  {
    id: id(),

    contractId: text('contract_id').notNull(),

    direction: threadDirectionEnum('direction').notNull(),

    // Unique per email across both outbound and inbound
    // Outbound: returned by Postmark send API
    // Inbound: from Postmark webhook's `MessageID` field
    postmarkMessageId: text('postmark_message_id'),

    // Inbound only: the In-Reply-To header, matching the original outbound messageId
    inReplyToMessageId: text('in_reply_to_message_id'),

    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    ccAddresses: jsonb('cc_addresses').$type<string[]>(),

    subject: text('subject').notNull(),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),

    // Array of { filename, contentType, storageKey, sizeBytes }
    // Files live in GCS; only metadata here
    attachments: jsonb('attachments').$type<Array<{
      filename: string
      contentType: string
      storageKey: string
      sizeBytes: number
    }>>(),

    // From email headers, not DB insert time
    emailDate: timestamp('email_date', { withTimezone: true, mode: 'date' }),

    ...timestamps,
  },
  (t) => [
    index('ct_contract_id_idx').on(t.contractId),
    index('ct_direction_idx').on(t.contractId, t.direction),
    index('ct_in_reply_to_idx').on(t.inReplyToMessageId),
    uniqueIndex('ct_postmark_msg_id_uidx').on(t.postmarkMessageId),
  ],
)

// ---------------------------------------------------------------------------
// inboundEmails — raw Postmark webhook store for idempotency + debugging
// ---------------------------------------------------------------------------

export const inboundEmails = pgTable(
  'inbound_emails',
  {
    id: id(),

    // PRIMARY deduplication key — Postmark may POST the same webhook twice
    // (10 retries on non-200 response). INSERT ... ON CONFLICT DO NOTHING
    // prevents double-processing.
    postmarkMessageId: text('postmark_message_id').notNull(),

    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject'),

    // Full raw Postmark JSON stored for debugging and replay
    rawPayload: jsonb('raw_payload').notNull(),

    processed: boolean('processed').notNull().default(false),

    // FK → contractThreads.id, set after successful processing
    threadEntryId: text('thread_entry_id'),

    processingError: text('processing_error'),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('ie_postmark_msg_id_uidx').on(t.postmarkMessageId),
    index('ie_to_address_idx').on(t.toAddress),
    index('ie_processed_idx').on(t.processed),
  ],
)

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type ServiceEmail    = typeof serviceEmails.$inferSelect
export type NewServiceEmail = typeof serviceEmails.$inferInsert
export type Contract        = typeof contracts.$inferSelect
export type NewContract     = typeof contracts.$inferInsert
export type ContractThread  = typeof contractThreads.$inferSelect
export type NewContractThread = typeof contractThreads.$inferInsert
export type InboundEmail    = typeof inboundEmails.$inferSelect
export type NewInboundEmail = typeof inboundEmails.$inferInsert
```

### 3.2 Contract Status State Machine

```
draft
  │
  ▼  (POST /contracts/:id/send → Postmark API success)
sent
  │
  ▼  (POST /webhooks/postmark/inbound received + processed)
replied
  │
  ├──► (manual) ──────────► signed / declined
  │
  └──► (AI job queued) ──► ai_processing
                                │
                                ├──► completed   (clean, no issues)
                                ├──► negotiating (open terms found)
                                ├──► signed      (AI detected agreement)
                                └──► declined    (rejection detected)

Terminal states: completed, signed, declined
```

---

## 4. Authentication Flow

**Google is used purely as an identity provider.** No Gmail access. No refresh token stored.

### 4.1 Better Auth Configuration (`backend/src/lib/auth.ts`)

```typescript
import { betterAuth } from 'better-auth'
import { Pool } from 'pg'
import { provisionServiceEmail } from '../services/serviceEmail.js'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,  // use DIRECT (non-pooled) URL here
})

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,   // Cloud Run backend URL
  secret: process.env.BETTER_AUTH_SECRET!,

  database: pool,

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      // accessType omitted → defaults to "online" → NO refresh token issued
      // scopes omitted → defaults to ["openid", "email", "profile"]
      // prompt omitted → no forced re-consent
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    cookieCache: { enabled: false },
  },

  trustedOrigins: [process.env.FRONTEND_URL!],

  // SameSite: none + secure: true are required in production because the frontend
  // (Cloudflare Workers) and backend (Cloud Run) are on different origins.
  // In local dev both run on localhost over HTTP, so none+secure would break the cookie.
  advanced: {
    defaultCookieAttributes: process.env.NODE_ENV === 'production'
      ? { sameSite: 'none', secure: true }
      : { sameSite: 'lax', secure: false },
  },

  // Fires ONLY on first login (new user creation). NOT on subsequent logins.
  // v1.5+ executes this AFTER the DB transaction commits — safe to query DB here.
  // Do NOT await the provisioning call — the auth session must complete immediately.
  // The dashboard shows a loading state while provisioning runs.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const attempt = async (retriesLeft: number): Promise<void> => {
            try {
              await provisionServiceEmail(user.id, user.name)
            } catch (err: any) {
              if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 3000)
            }
          }
          attempt(2) // fire-and-forget, up to 3 total attempts
        },
      },
    },
  },
})
```

**What gets stored by Better Auth (identity-only OAuth):**

| Table | Key columns |
|---|---|
| `user` | `id` (TEXT/nanoid), `email`, `name`, `image`, `emailVerified: true` |
| `session` | `token` (session cookie value), `userId`, `expiresAt` |
| `account` | `providerId: 'google'`, `accessToken` (short-lived, useless after login), `refreshToken: null` |
| `verification` | Used internally — we don't touch it |

**`user.id` is TEXT** (nanoid format), not UUID. All FK columns referencing it use `text()` in Drizzle.

### 4.2 Session Validation Middleware (`backend/src/middleware/auth.ts`)

```typescript
import { createMiddleware } from 'hono/factory'
import { auth } from '../lib/auth.js'

export const requireAuth = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })

  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('user', session.user)
  c.set('session', session.session)
  await next()
})
```

### 4.3 OAuth Flow (step-by-step)

**Happy path — new user:**
1. User arrives at `/`. The SSR session check runs server-side; no session found, landing page is rendered.
2. User clicks "Continue with Google". The button JavaScript POSTs to `{BACKEND_URL}/api/auth/sign-in/social` with `{ provider: 'google', callbackURL: window.location.origin + '/dashboard' }`. The button disables itself and shows "Redirecting to Google…".
3. Backend returns `{ url: "https://accounts.google.com/o/oauth2/auth?..." }`. JavaScript navigates to that URL.
4. User approves on Google's consent screen → Google redirects to `{BACKEND_URL}/api/auth/callback/google`.
5. Better Auth exchanges the code, creates the user + session rows in NeonDB.
6. `databaseHooks.user.create.after` fires (new users only) → `provisionServiceEmail()` is called asynchronously (fire-and-forget with 2 retries). Auth session completes immediately.
7. Better Auth sets the `better-auth.session` cookie and redirects to `{FRONTEND_URL}/dashboard`.

**Already logged in:**
- User visits `/`. SSR calls `GET /api/auth/get-session`, finds a valid session, issues `Astro.redirect('/dashboard')` before any HTML is sent. The landing page is never rendered.

**OAuth cancelled:**
- User clicks Cancel on Google's consent screen. Google sends `?error=access_denied` to `{BACKEND_URL}/api/auth/callback/google`.
- Better Auth reads `errorURL` from the OAuth state. This value was set from `errorCallbackURL` in the original sign-in body. If not set, Better Auth falls back to `onAPIError.errorURL` from the server config, and if that is also unset, to its own built-in `{BACKEND_URL}/api/auth/error` page.
- With `errorCallbackURL: window.location.origin + '/'` in the sign-in body and `onAPIError.errorURL` set in `auth.ts`, Better Auth redirects to `{FRONTEND_URL}/?error=access_denied`.
- Landing page SSR: reads `?error=access_denied` → renders "Sign-in was cancelled" banner.

**Sign-out:**
- User clicks the "Sign out" button on the dashboard.
- Button JavaScript fires `fetch POST` to `{BACKEND_URL}/api/auth/sign-out` with `credentials: 'include'`.
- Better Auth deletes the session row from NeonDB and clears the cookie.
- On response (success or network error), JavaScript navigates to `/`.
- Next visit to `/dashboard` — SSR session check finds no valid session → redirects to `/`.

**Cookie flags (by environment):**

| Environment | SameSite | Secure |
|---|---|---|
| Local dev (`NODE_ENV` ≠ `production`) | `lax` | `false` |
| Production | `none` | `true` |

`SameSite: none` is required in production because the frontend (Cloudflare Workers) and backend (Cloud Run) are on different origins. `SameSite: lax` is used in local dev because both run on `localhost` and `none` requires `secure: true` which requires HTTPS.

---

## 5. Service Email Provisioning

### 5.1 The Pattern

Each user gets exactly one dedicated address: `{slug}-{token}@mail.usetend.in`

- `slug` = first 12 chars of user's display name, lowercased, non-alphanumeric stripped
- `token` = 6 random chars from `[a-z0-9]` using nanoid

Example: user "Swaraj Bari" → `swaraj-a3x9k2@mail.usetend.in`

### 5.2 Service (`backend/src/services/serviceEmail.ts`)

```typescript
import { customAlphabet } from 'nanoid'
import { db } from '../db/client.js'
import { serviceEmails } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)

const DOMAIN = 'mail.usetend.in'
const MAX_RETRIES = 5

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)
    || 'user' // fallback if name produces empty string
}

export async function provisionServiceEmail(
  userId: string,
  displayName: string,
): Promise<string> {
  // Idempotency guard: return existing address if already provisioned
  const existing = await db.query.serviceEmails.findFirst({
    where: eq(serviceEmails.userId, userId),
  })
  if (existing) return existing.address

  const slug = slugify(displayName)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const token = nanoid()
    const localPart = `${slug}-${token}`
    const address = `${localPart}@${DOMAIN}`

    try {
      await db.insert(serviceEmails).values({
        userId,
        localPart,
        address,
      })
      return address
    } catch (err: any) {
      // Postgres unique_violation code = '23505'
      if (err?.code === '23505') continue
      throw err
    }
  }

  throw new Error(`Failed to provision service email after ${MAX_RETRIES} retries`)
}

export async function getServiceEmailByLocalPart(
  localPart: string,
): Promise<{ userId: string; address: string } | null> {
  const row = await db.query.serviceEmails.findFirst({
    where: eq(serviceEmails.localPart, localPart),
  })
  if (!row || !row.isActive) return null
  return { userId: row.userId, address: row.address }
}

export async function getServiceEmailByUserId(
  userId: string,
): Promise<string | null> {
  const row = await db.query.serviceEmails.findFirst({
    where: eq(serviceEmails.userId, userId),
  })
  return row?.address ?? null
}
```

---

## 6. Contract Send Flow

### Step by step

1. User uploads PDF via the dashboard (multipart POST to `/api/contracts/upload`)
2. Backend validates: PDF, ≤20 MB, user is authenticated
3. Backend generates a `contractId` (UUID), stores PDF in GCS at `contracts/{userId}/{contractId}/original.pdf`
4. Backend inserts `contracts` row: `status: 'draft'`, `storageKey`, `userId`, `title`
5. User fills in recipient email + name + subject → submits
6. Backend sends email via Postmark:
   - `From: alice-x7k2@mail.usetend.in` (user's service address)
   - `To: recipient@company.com`
   - `Subject: {subject}`
   - Attachment: the PDF from GCS (re-read from storage, encoded as base64)
7. Postmark returns a `MessageID`
8. Backend updates contracts row: `status: 'sent'`, `postmarkMessageId`, `sentAt`
9. Backend inserts a `contractThreads` row: `direction: 'outbound'`, `postmarkMessageId`

### Upload + Send API (`backend/src/routes/contracts.ts`) — skeleton

```typescript
import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth.js'
import { contractsBucket, generateDownloadSignedUrl } from '../lib/storage.js'
import { sendContractEmail } from '../services/postmarkClient.js'
import { db } from '../db/client.js'
import { contracts, contractThreads } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'

const contractsRouter = new Hono()

contractsRouter.post('/upload', requireAuth, async (c) => {
  const user = c.get('user')
  const formData = await c.req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }
  if (file.type !== 'application/pdf') {
    return c.json({ error: 'Only PDF files accepted' }, 400)
  }
  if (file.size > 20 * 1024 * 1024) {
    return c.json({ error: 'File too large (max 20 MB)' }, 413)
  }

  const contractId = crypto.randomUUID()
  const storageKey = `contracts/${user.id}/${contractId}/original.pdf`

  const buffer = Buffer.from(await file.arrayBuffer())
  await contractsBucket.file(storageKey).save(buffer, {
    metadata: { contentType: 'application/pdf' },
    resumable: false,
  })

  await db.insert(contracts).values({
    id: contractId,
    userId: user.id,
    title: formData.get('title') as string || file.name,
    storageKey,
    originalFilename: file.name,
    fileSizeBytes: file.size,
  })

  return c.json({ contractId }, 201)
})

contractsRouter.post('/:id/send', requireAuth, async (c) => {
  const user = c.get('user')
  const contractId = c.req.param('id')
  const { recipientName, recipientEmail, subject } = await c.req.json()

  const contract = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
  })
  if (!contract || contract.status !== 'draft') {
    return c.json({ error: 'Contract not found or already sent' }, 404)
  }

  // Re-read PDF from GCS to attach
  const [fileContents] = await contractsBucket.file(contract.storageKey).download()
  const pdfBase64 = fileContents.toString('base64')

  const { messageId } = await sendContractEmail({
    fromAddress: await getServiceEmailByUserId(user.id) as string,
    toAddress: recipientEmail,
    toName: recipientName,
    subject,
    contractId,
    pdfBase64,
    pdfFilename: contract.originalFilename,
  })

  await db.update(contracts)
    .set({ status: 'sent', postmarkMessageId: messageId, recipientEmail, recipientName, subject, sentAt: new Date() })
    .where(eq(contracts.id, contractId))

  await db.insert(contractThreads).values({
    contractId,
    direction: 'outbound',
    postmarkMessageId: messageId,
    fromAddress: await getServiceEmailByUserId(user.id) as string,
    toAddress: recipientEmail,
    subject,
    emailDate: new Date(),
  })

  return c.json({ ok: true, messageId })
})

contractsRouter.get('/:id/download-url', requireAuth, async (c) => {
  const user = c.get('user')
  const contractId = c.req.param('id')

  const contract = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
  })
  if (!contract) return c.json({ error: 'Not found' }, 404)

  const url = await generateDownloadSignedUrl(contract.storageKey)
  return c.json({ url, expiresIn: 3600 })
})

export default contractsRouter
```

---

## 7. Inbound Email Flow

### Step by step

1. Recipient replies to `alice-x7k2@mail.usetend.in`
2. DNS MX record routes to `inbound.postmarkapp.com`
3. Postmark parses the email → POSTs JSON to `POST /webhooks/postmark/inbound`
4. Backend verifies Basic Auth header (rejects non-Postmark POSTs with 401)
5. Backend extracts `OriginalRecipient` → splits on `@` → gets local-part `alice-x7k2`
6. DB lookup: `SELECT user_id FROM service_emails WHERE local_part = 'alice-x7k2'`
7. Idempotency check: `INSERT INTO inbound_emails ... ON CONFLICT DO NOTHING`
   - If already seen: return 200 immediately (no processing)
8. For each attachment with `ContentType: application/pdf`:
   - Decode base64 → Buffer
   - Find the linked contract (via `postmarkMessageId` ↔ `In-Reply-To` header)
   - Upload to GCS: `contracts/{userId}/{contractId}/reply-{timestamp}.pdf`
   - Record `storageKey` in `contractThreads.attachments`
9. Insert `contractThreads` row: `direction: 'inbound'`, `inReplyToMessageId`, `attachments`
10. Update matching `contracts` row: `status: 'replied'`
11. Update `inbound_emails` row: `processed: true`, `threadEntryId`
12. Trigger AI pipeline stub (async, non-blocking)
13. Return 200 immediately (Postmark retries on non-200, up to 10 times)

### Postmark Webhook Payload (key fields)

```typescript
interface PostmarkInboundPayload {
  From: string               // "John Doe <john@company.com>"
  FromFull: { Email: string; Name: string; MailboxHash: string }
  To: string
  ToFull: Array<{ Email: string; Name: string; MailboxHash: string }>
  OriginalRecipient: string  // "alice-x7k2@mail.usetend.in" — USE THIS for routing
  MailboxHash: string        // The +hash portion (empty if no + in address)
  Subject: string
  MessageID: string          // Postmark's ID — idempotency key
  ReplyTo: string
  Date: string
  TextBody: string
  HtmlBody: string
  StrippedTextReply: string  // Postmark's attempt to strip quoted text
  Headers: Array<{ Name: string; Value: string }>  // includes In-Reply-To
  Attachments: Array<{
    Name: string
    Content: string          // base64-encoded file content
    ContentType: string      // e.g. "application/pdf"
    ContentLength: number    // decoded byte count
  }>
}
```

### Webhook Handler (`backend/src/routes/webhooks.ts`)

```typescript
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { inboundEmails, contractThreads, contracts } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { getServiceEmailByLocalPart } from '../services/serviceEmail.js'
import { contractsBucket } from '../lib/storage.js'

const webhooksRouter = new Hono()

const POSTMARK_BASIC = Buffer.from(
  `${process.env.POSTMARK_INBOUND_WEBHOOK_USER}:${process.env.POSTMARK_INBOUND_WEBHOOK_PASS}`
).toString('base64')

// Postmark's known webhook IP addresses (as of 2025)
const POSTMARK_IPS = new Set([
  '3.134.147.250',
  '50.31.156.6',
  '50.31.156.77',
  '18.217.206.57',
])

function verifyPostmark(authHeader: string | undefined): boolean {
  return authHeader === `Basic ${POSTMARK_BASIC}`
}

webhooksRouter.post('/postmark/inbound', async (c) => {
  if (!verifyPostmark(c.req.header('authorization'))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const payload = await c.req.json()
  const messageId: string = payload.MessageID

  // Step 1: idempotency — store raw payload, skip if already seen
  const inserted = await db
    .insert(inboundEmails)
    .values({
      postmarkMessageId: messageId,
      toAddress: payload.OriginalRecipient,
      fromAddress: payload.FromFull?.Email ?? payload.From,
      subject: payload.Subject,
      rawPayload: payload,
    })
    .onConflictDoNothing({ target: inboundEmails.postmarkMessageId })
    .returning({ id: inboundEmails.id })

  if (inserted.length === 0) {
    // Already processed — return 200 to prevent Postmark retry
    return c.json({ ok: true, note: 'duplicate' })
  }

  const inboundId = inserted[0].id

  // Process asynchronously — return 200 fast, don't block Postmark
  processInbound(inboundId, payload).catch((err) => {
    console.error('Inbound processing error', { inboundId, error: err.message })
    db.update(inboundEmails)
      .set({ processingError: err.message, processedAt: new Date() })
      .where(eq(inboundEmails.id, inboundId))
      .catch(console.error)
  })

  return c.json({ ok: true })
})

async function processInbound(inboundId: string, payload: any) {
  const localPart = payload.OriginalRecipient.split('@')[0].toLowerCase()
  const serviceEmail = await getServiceEmailByLocalPart(localPart)

  if (!serviceEmail) {
    console.warn(`No service email found for local-part: ${localPart}`)
    return
  }

  // Find the related contract via In-Reply-To header
  const inReplyTo = (payload.Headers as Array<{ Name: string; Value: string }>)
    ?.find(h => h.Name === 'In-Reply-To')?.Value
    ?.replace(/<|>/g, '')
    ?.trim()

  let contractId: string | undefined

  if (inReplyTo) {
    const thread = await db.query.contractThreads.findFirst({
      where: eq(contractThreads.postmarkMessageId, inReplyTo),
    })
    contractId = thread?.contractId
  }

  // Upload PDF attachments to GCS
  const attachmentRecords: Array<{
    filename: string
    contentType: string
    storageKey: string
    sizeBytes: number
  }> = []

  for (const att of (payload.Attachments ?? [])) {
    if (!att.ContentType?.includes('pdf')) continue

    const buffer = Buffer.from(att.Content, 'base64')
    const timestamp = Date.now()
    const storageKey = contractId
      ? `contracts/${serviceEmail.userId}/${contractId}/reply-${timestamp}.pdf`
      : `inbound/${serviceEmail.userId}/${payload.MessageID}.pdf`

    await contractsBucket.file(storageKey).save(buffer, {
      metadata: { contentType: att.ContentType },
      resumable: false,
    })

    attachmentRecords.push({
      filename: att.Name,
      contentType: att.ContentType,
      storageKey,
      sizeBytes: att.ContentLength,
    })
  }

  // Insert thread entry
  const [threadRow] = await db.insert(contractThreads).values({
    contractId: contractId ?? 'unknown',
    direction: 'inbound',
    postmarkMessageId: payload.MessageID,
    inReplyToMessageId: inReplyTo ?? null,
    fromAddress: payload.FromFull?.Email ?? payload.From,
    toAddress: payload.OriginalRecipient,
    subject: payload.Subject,
    bodyText: payload.TextBody,
    bodyHtml: payload.HtmlBody,
    attachments: attachmentRecords,
    emailDate: new Date(payload.Date),
  }).returning({ id: contractThreads.id })

  // Update contract status → replied
  if (contractId) {
    await db.update(contracts)
      .set({ status: 'replied', updatedAt: new Date() })
      .where(eq(contracts.id, contractId))
  }

  // Mark inbound email as processed
  await db.update(inboundEmails)
    .set({
      processed: true,
      threadEntryId: threadRow.id,
      processedAt: new Date(),
    })
    .where(eq(inboundEmails.id, inboundId))

  // AI pipeline stub — trigger here when implemented
  // await triggerAiPipeline(contractId, attachmentRecords)
}

export default webhooksRouter
```

---

## 8. AI Pipeline Hook Points

The AI pipeline is **deferred** (not built in this POC phase), but the architecture leaves clear seams.

**Trigger point:** At the end of `processInbound()`, after `contracts.status → 'replied'`, call an async function `triggerAiPipeline(contractId, attachments)`. This function:
- Enqueues a job (future: Cloud Tasks or a simple in-process queue)
- Updates `contracts.status → 'ai_processing'`
- Downloads the original contract PDF and the reply PDF from GCS
- Sends both to Gemini Flash (or Claude) for diff analysis
- Writes the result to `contracts.aiAnalysis`
- Updates `contracts.status` to one of: `completed`, `negotiating`, `signed`, `declined`

**Stub to add now:**

```typescript
async function triggerAiPipeline(
  contractId: string,
  attachments: Array<{ storageKey: string }>
): Promise<void> {
  console.log(`[AI STUB] Would process contract ${contractId} with ${attachments.length} attachment(s)`)
  // TODO: implement in AI component
}
```

---

## 9. Frontend Pages

All pages use Astro SSR on Cloudflare Workers (`output: 'server'` in `astro.config.mjs`). No page uses `prerender = true`. Auth logic lives entirely on the backend — the frontend only forwards cookies and renders pre-shaped data.

| Page | Path | Purpose |
|---|---|---|
| Landing | `/` | Session check → redirect to `/dashboard` if logged in, otherwise show sign-in button |
| Dashboard | `/dashboard` | Contract list, service email display, upload button, sign-out |
| Upload | `/upload` | PDF upload form + recipient details |
| Thread | `/contracts/[id]` | Contract timeline: sent email, reply, AI analysis |

### Landing Page (`frontend/src/pages/index.astro`)

Key design decisions:
- **No `prerender = true`.** The page must be SSR so the server can check the session cookie on every request.
- **Server-side redirect for logged-in users.** `Astro.redirect('/dashboard')` is issued before any HTML is sent — no flash, no client-side round-trip.
- **`?error=` param handling.** Errors forwarded from the OAuth callback or other SSR redirects are rendered as a banner. Known values: `access_denied` (user cancelled Google), `service_unavailable` (backend down).
- **Sign-in uses `fetch POST`, not an anchor link.** Better Auth's sign-in endpoint (`/api/auth/sign-in/social`) is a POST endpoint that returns `{ url }`. The button posts to it, gets back the Google OAuth URL, and navigates to it. An anchor link would be a GET and would not work.
- **Try/catch on all fetches.** Network errors show an inline error message; they do not silently swallow.

```astro
---
const apiUrl = import.meta.env.PUBLIC_API_URL || 'http://localhost:8080'

try {
  const sessionRes = await fetch(`${apiUrl}/api/auth/get-session`, {
    headers: { cookie: Astro.request.headers.get('cookie') ?? '' },
  })
  if (sessionRes.ok) {
    const data = await sessionRes.json()
    if (data?.user) return Astro.redirect('/dashboard')
  }
} catch {
  // Backend unreachable — show the landing page so the user isn't stranded
}

const rawError = Astro.url.searchParams.get('error')
let errorMessage: string | null = null
if (rawError === 'access_denied') {
  errorMessage = 'Sign-in was cancelled. Click the button below to try again.'
} else if (rawError === 'service_unavailable') {
  errorMessage = 'The service is temporarily unavailable. Please try again in a moment.'
} else if (rawError) {
  errorMessage = 'Something went wrong during sign-in. Please try again.'
}
---
<html lang="en">
<body>
  <main>
    <h1>Genie AI</h1>
    {errorMessage && <div class="error-banner" role="alert">{errorMessage}</div>}
    <button id="google-signin">Continue with Google</button>
    <div id="signin-error" style="display:none"></div>
  </main>
  <script define:vars={{ apiUrl }}>
    const btn = document.getElementById('google-signin');
    const errorDiv = document.getElementById('signin-error');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Redirecting to Google…';
      errorDiv.style.display = 'none';
      try {
        const res = await fetch(`${apiUrl}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: `${window.location.origin}/dashboard`,
          }),
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Server responded with ${res.status}`);
        const data = await res.json();
        if (data.url) { window.location.href = data.url; }
        else throw new Error('No redirect URL returned from server.');
      } catch {
        errorDiv.textContent = 'Could not connect to the sign-in service. Please check your connection and try again.';
        errorDiv.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Continue with Google';
      }
    });
  </script>
</body>
</html>
```

### Dashboard Page (`frontend/src/pages/dashboard.astro`)

Key design decisions:
- **Session fetch in try/catch.** If the backend is unreachable, redirect to `/?error=service_unavailable` instead of crashing.
- **OAuth error forwarding.** If `?error=` is present in the URL (arriving from the Google callback via Better Auth), forward it to `/?error=...` so the landing page can render a banner.
- **Data fetches in a separate try/catch.** If contracts or service-email fetches fail, render an empty/degraded dashboard rather than crashing.
- **Sign-out is a `<button>` with `fetch POST`, not an anchor link.** Better Auth's sign-out endpoint is `POST /api/auth/sign-out`. An anchor link would send a GET and receive a 404.

```astro
---
const apiUrl = import.meta.env.PUBLIC_API_URL || 'http://localhost:8080'
const cookieHeader = Astro.request.headers.get('cookie') ?? ''

let user: any = null
let contracts: any[] = []
let address: string | null = null
let serviceEmailError = false

try {
  const sessionRes = await fetch(`${apiUrl}/api/auth/get-session`, { headers: { cookie: cookieHeader } })
  if (!sessionRes.ok) {
    const oauthError = Astro.url.searchParams.get('error')
    return Astro.redirect(oauthError ? `/?error=${oauthError}` : '/')
  }
  const session = await sessionRes.json()
  if (!session?.user) {
    const oauthError = Astro.url.searchParams.get('error')
    return Astro.redirect(oauthError ? `/?error=${oauthError}` : '/')
  }
  user = session.user
} catch {
  return Astro.redirect('/?error=service_unavailable')
}

try {
  const [contractsRes, emailRes] = await Promise.all([
    fetch(`${apiUrl}/api/contracts`, { headers: { cookie: cookieHeader } }),
    fetch(`${apiUrl}/api/me/service-email`, { headers: { cookie: cookieHeader } }),
  ])
  if (contractsRes.ok) contracts = (await contractsRes.json()).contracts ?? []
  if (emailRes.ok) address = (await emailRes.json()).address ?? null
  else serviceEmailError = true
} catch {
  // Show empty state
}
---
<html>
<body>
  <header>
    <span>{user.name}</span>
    <button id="signout-btn">Sign out</button>
  </header>
  <section>
    {address
      ? <code>{address}</code>
      : serviceEmailError
        ? <p>Address provisioning failed. Sign out and sign back in.</p>
        : <p>Provisioning… refresh in a moment.</p>
    }
  </section>
  <!-- contracts list … -->
  <script define:vars={{ apiUrl }}>
    document.getElementById('signout-btn').addEventListener('click', async () => {
      const btn = document.getElementById('signout-btn');
      btn.disabled = true;
      btn.textContent = 'Signing out…';
      try {
        await fetch(`${apiUrl}/api/auth/sign-out`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'include',
        });
      } catch (_) { /* best-effort */ }
      window.location.href = '/';
    });
  </script>
</body>
</html>
```

---

## 10. Backend API Routes

Full route list for the backend Hono server.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check |
| `GET,POST` | `/api/auth/*` | No | Better Auth handles all OAuth routes |
| `GET` | `/api/me/service-email` | Yes | Return user's `{ address }` |
| `GET` | `/api/contracts` | Yes | List user's contracts `[{ id, title, status, recipientEmail, sentAt }]` |
| `POST` | `/api/contracts/upload` | Yes | Multipart: `file`, `title`. Returns `{ contractId }` |
| `POST` | `/api/contracts/:id/send` | Yes | Body: `{ recipientEmail, recipientName, subject }`. Returns `{ messageId }` |
| `GET` | `/api/contracts/:id` | Yes | Full contract + thread entries |
| `GET` | `/api/contracts/:id/download-url` | Yes | Signed GCS URL, 1 hour TTL |
| `POST` | `/webhooks/postmark/inbound` | Basic Auth | Postmark inbound email webhook |

### App Wiring (`backend/src/app.ts`)

```typescript
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './lib/auth.js'
import contractsRouter from './routes/contracts.js'
import webhooksRouter from './routes/webhooks.js'

const app = new Hono()

app.use('*', cors({
  origin: [process.env.FRONTEND_URL!],
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'User-Agent'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.get('/health', (c) => c.json({ status: 'ok' }))

app.route('/api/contracts', contractsRouter)
app.route('/webhooks', webhooksRouter)

app.get('/api/me/service-email', requireAuth, async (c) => {
  const user = c.get('user')
  const address = await getServiceEmailByUserId(user.id)
  if (!address) return c.json({ error: 'Not provisioned' }, 404)
  return c.json({ address })
})

export default app
```

---

## 11. Environment Variables

### `backend/.env` (local dev — never commit)

```bash
# NeonDB — use the DIRECT URL for Better Auth's pg Pool
# and POOLED URL for Drizzle's postgres client
DATABASE_URL=postgresql://user:pass@ep-xxx.eu-west-2.aws.neon.tech/genie_poc?sslmode=require
DATABASE_URL_POOLED=postgresql://user:pass@ep-xxx-pooler.eu-west-2.aws.neon.tech/genie_poc?sslmode=require

# Google OAuth
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx

# Better Auth
BETTER_AUTH_SECRET=<64-char hex string>
BETTER_AUTH_URL=http://localhost:8080

# GCP
GOOGLE_CLOUD_PROJECT=genie-poc
GCS_BUCKET_NAME=genie-poc-contracts

# Postmark
POSTMARK_SERVER_API_TOKEN=<from Postmark server settings>
POSTMARK_INBOUND_WEBHOOK_USER=postmark-inbound
POSTMARK_INBOUND_WEBHOOK_PASS=<random hex — you chose this when setting up the webhook URL>

# Frontend
FRONTEND_URL=http://localhost:4321
```

### `frontend/.env` (local dev)

```bash
PUBLIC_API_URL=http://localhost:8080
```

### Cloud Run Environment Variables (production — use Secret Manager)

```bash
DATABASE_URL         # Direct NeonDB URL (for Better Auth pg pool)
DATABASE_URL_POOLED  # Pooled NeonDB URL (for Drizzle)
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
BETTER_AUTH_SECRET
BETTER_AUTH_URL      # https://YOUR_CLOUD_RUN_SERVICE_URL
GCS_BUCKET_NAME      # genie-poc-contracts
GOOGLE_CLOUD_PROJECT # genie-poc
POSTMARK_SERVER_API_TOKEN
POSTMARK_INBOUND_WEBHOOK_USER
POSTMARK_INBOUND_WEBHOOK_PASS
FRONTEND_URL         # https://YOUR_CLOUDFLARE_WORKERS_URL
```

---

## 12. Package List

### Backend (`backend/package.json`)

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push"
  },
  "dependencies": {
    "@google-cloud/storage": "^7.19.0",
    "@hono/node-server": "^2.0.3",
    "better-auth": "^1.6.11",
    "drizzle-orm": "^0.43.0",
    "hono": "^4.12.21",
    "nanoid": "^5.0.0",
    "pg": "^8.21.0",
    "postmark": "^4.0.0",
    "postgres": "^3.4.9",
    "tsx": "^4.22.3",
    "typescript": "^6.0.3"
  },
  "devDependencies": {
    "@types/node": "^25.9.1",
    "@types/pg": "^8.20.0",
    "drizzle-kit": "^0.31.0"
  }
}
```

**Removed vs. current:** `googleapis` is removed entirely. `drizzle-orm`, `drizzle-kit`, `postmark`, `nanoid` are new.

### Frontend (`frontend/package.json`) — unchanged from current

---

## 13. Drizzle Configuration

### `backend/drizzle.config.ts`

```typescript
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',

  dbCredentials: {
    // Use DIRECT URL for migrations (not pooled — PgBouncer can conflict with migration SET statements)
    url: process.env.DATABASE_URL!,
  },

  // CRITICAL: Prevents drizzle-kit from touching Better Auth's auto-managed tables.
  // Without this, drizzle-kit generate would emit DROP TABLE for user/session/account/verification.
  tablesFilter: [
    'service_emails',
    'contracts',
    'contract_threads',
    'inbound_emails',
  ],

  verbose: true,
  strict: true,
})
```

### `backend/src/db/client.ts`

```typescript
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'

// Use the POOLED URL for application queries
const queryClient = postgres(process.env.DATABASE_URL_POOLED!, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  ssl: 'require',
})

export const db = drizzle(queryClient, { schema })
```

---

## 14. GCS Storage Client

### `backend/src/lib/storage.ts`

```typescript
import { Storage } from '@google-cloud/storage'

// ADC is automatic on Cloud Run (metadata server provides credentials)
// For local dev: run `gcloud auth application-default login`
export const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
})

export const contractsBucket = storage.bucket(process.env.GCS_BUCKET_NAME!)

export async function generateDownloadSignedUrl(
  storageKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const [url] = await contractsBucket.file(storageKey).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInSeconds * 1000,
    responseDisposition: 'attachment; filename="contract.pdf"',
    responseType: 'application/pdf',
  })
  return url
}
```

**Note:** Signed URL generation requires `roles/iam.serviceAccountTokenCreator` granted to the Cloud Run service account on itself (see Prerequisites §2.1). Without it, you get a `403 The caller does not have permission` error from the IAM SignBlob API.

---

## 15. Postmark Client

### `backend/src/services/postmarkClient.ts`

```typescript
import * as postmark from 'postmark'

const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_API_TOKEN!)

interface SendContractEmailParams {
  fromAddress: string   // user's service address, e.g. alice-x7k2@mail.usetend.in
  toAddress: string
  toName: string
  subject: string
  contractId: string
  pdfBase64: string
  pdfFilename: string
}

export async function sendContractEmail(params: SendContractEmailParams): Promise<{ messageId: string }> {
  const response = await client.sendEmail({
    From: params.fromAddress,
    To: params.toAddress,
    Subject: params.subject,
    TextBody: `Please review the attached contract and reply with your feedback.`,
    HtmlBody: `<p>Please review the attached contract and reply with your feedback.</p>`,
    Attachments: [
      {
        Name: params.pdfFilename,
        Content: params.pdfBase64,
        ContentType: 'application/pdf',
      },
    ],
    MessageStream: 'outbound',
    TrackOpens: false,
  })

  return { messageId: response.MessageID }
}
```

---

## 16. Deployment

### `backend/Dockerfile`

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### Cloud Run Deploy Command

```bash
gcloud builds submit --tag gcr.io/genie-poc/backend:latest ./backend

gcloud run deploy backend \
  --image gcr.io/genie-poc/backend:latest \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --service-account genie-poc-backend@genie-poc.iam.gserviceaccount.com \
  --set-secrets "DATABASE_URL=database-url:latest,DATABASE_URL_POOLED=database-url-pooled:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,BETTER_AUTH_SECRET=better-auth-secret:latest,POSTMARK_SERVER_API_TOKEN=postmark-server-token:latest,POSTMARK_INBOUND_WEBHOOK_USER=postmark-webhook-user:latest,POSTMARK_INBOUND_WEBHOOK_PASS=postmark-webhook-pass:latest" \
  --set-env-vars "BETTER_AUTH_URL=https://YOUR_CLOUD_RUN_URL,FRONTEND_URL=https://YOUR_WORKERS_URL,GCS_BUCKET_NAME=genie-poc-contracts,GOOGLE_CLOUD_PROJECT=genie-poc" \
  --min-instances 0 \
  --max-instances 5
```

### GitHub Actions (`.github/workflows/deploy.yml`)

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}
      - uses: google-github-actions/setup-gcloud@v2
      - run: |
          cd backend
          gcloud builds submit --tag gcr.io/${{ secrets.GCP_PROJECT_ID }}/backend:${{ github.sha }}
          gcloud run deploy backend \
            --image gcr.io/${{ secrets.GCP_PROJECT_ID }}/backend:${{ github.sha }} \
            --region europe-west2 \
            --platform managed

  deploy-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd frontend && npm ci && npm run build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: frontend
```

**GitHub Secrets required:**
- `GCP_SERVICE_ACCOUNT_KEY` — base64-encoded service account JSON with Cloud Run Admin + Cloud Build Editor roles
- `GCP_PROJECT_ID` — GCP project ID
- `CLOUDFLARE_API_TOKEN` — Cloudflare token with Workers Edit permission

---

## 17. Step-by-Step Build Order

Each step has a concrete **done criterion**. Do not start the next step until the criterion passes.

### Step 1 — Delete existing code and re-initialize

```bash
rm -rf /home/swarajbari/Projects/GENEAI_POC/backend
rm -rf /home/swarajbari/Projects/GENEAI_POC/frontend
mkdir backend frontend
```

**Done:** Both directories are empty.

### Step 2 — Backend scaffold

```bash
cd backend
npm init -y
npm pkg set type=module
npm pkg set scripts.dev="tsx watch src/index.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/index.js"
npm pkg set scripts.db:generate="drizzle-kit generate"
npm pkg set scripts.db:migrate="drizzle-kit migrate"
npm pkg set scripts.db:push="drizzle-kit push"

npm install hono @hono/node-server better-auth pg postgres \
  drizzle-orm nanoid postmark @google-cloud/storage typescript tsx

npm install --save-dev @types/node @types/pg drizzle-kit
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Create `src/index.ts` and `src/app.ts` (minimal health-only version first).

**Done:** `npm run dev` starts without errors. `curl http://localhost:8080/health` returns `{"status":"ok"}`.

### Step 3 — Database

Create `src/db/schema.ts` (from §3.1 above).  
Create `drizzle.config.ts` (from §13 above).  
Create `src/db/client.ts` (from §13 above).  
Set `DATABASE_URL` and `DATABASE_URL_POOLED` in `backend/.env`.

```bash
npm run db:push   # Creates tables in NeonDB directly (no migration file needed for first run)
```

**Done:** Log into NeonDB console and verify that `service_emails`, `contracts`, `contract_threads`, `inbound_emails` tables exist. The `contract_status` and `thread_direction` enums should also be visible.

### Step 4 — Better Auth

Create `src/lib/auth.ts` (from §4.1 above).  
Create `src/middleware/auth.ts` (from §4.2 above).  
Update `src/app.ts` to mount `app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))`.

Start the server and hit `http://localhost:8080/api/auth/get-session`. Better Auth does NOT auto-create its tables — you must run `npx @better-auth/cli migrate` from inside `backend/src/lib/` first (see implementation-notes.md §Step 1b).

**Done:** NeonDB shows the four Better Auth tables (`user`, `session`, `account`, `verification`). `curl http://localhost:8080/api/auth/get-session` returns `{"session":null}` (not an error — null means no one is logged in, which is correct at this stage).

### Step 5 — Service email provisioning

Create `src/services/serviceEmail.ts` (from §5.2 above).  
Wire `provisionServiceEmail` into `databaseHooks.user.create.after` in `auth.ts`.

**Done (requires login):** After completing the OAuth flow for the first time, check NeonDB: `SELECT * FROM service_emails;` — one row should appear with the user's address. On second login, no new row is created.

### Step 6 — GCS storage client

Create `src/lib/storage.ts` (from §14 above).  
For local dev: `gcloud auth application-default login`.

**Done:** Write a quick test script:
```typescript
import { contractsBucket } from './src/lib/storage.js'
await contractsBucket.file('test.txt').save(Buffer.from('hello'))
console.log('Upload OK')
```
Run with `npx tsx test-gcs.ts` — file appears in GCS.

### Step 7 — Frontend scaffold

```bash
cd ../frontend
npm create astro@latest . -- --template minimal --no-git
npx astro add cloudflare
npx astro add react
```

Create `src/pages/index.astro` and `src/pages/dashboard.astro` (from §9 above).

**Critical:** `astro.config.mjs` must have `output: 'server'`. Do not add `export const prerender = true` to any page — every page must be SSR so session checks run on every request.

**Done:** `npm run dev` in frontend folder.
- Visit `http://localhost:4321` while not logged in — landing page loads.
- Visit `http://localhost:4321` while logged in — immediate server-side redirect to `/dashboard`, no flash.
- Clicking "Continue with Google" redirects to Google.
- After login, land on `/dashboard` and see the user's name and service email address.
- Clicking "Sign out" clears the session and redirects to `/`. Subsequent visit to `/dashboard` redirects back to `/`.

### Step 8 — Contract upload + send

Create `src/routes/contracts.ts` (from §6 above, expand as needed).  
Wire into `app.ts`.  
Create `src/services/postmarkClient.ts` (from §15 above).

**Done (requires Postmark account):** Upload a PDF via the upload form. Verify:
- GCS bucket has the file at `contracts/{userId}/{contractId}/original.pdf`
- NeonDB `contracts` table has a row with `status='draft'`
- Click "Send" — row updates to `status='sent'`
- Recipient's inbox receives the email with the PDF attached
- `contract_threads` has one `direction='outbound'` row

### Step 9 — Inbound webhook

Create `src/routes/webhooks.ts` (from §7 above).  
Wire into `app.ts`.  
Configure Postmark webhook URL to point to your backend.  
For local testing, use `cloudflared tunnel --url http://localhost:8080` to get a public URL.

**Done:** Reply to a sent contract email from a different address. Within seconds:
- Postmark posts to the webhook
- `inbound_emails` gets a row with `processed: true`
- `contract_threads` gets a row with `direction='inbound'`
- `contracts.status` changes to `'replied'`
- Reply's PDF is in GCS

### Step 10 — Thread page + download URL

Create `frontend/src/pages/contracts/[id].astro`.  
Wire `GET /api/contracts/:id` on the backend to return thread entries.  
Wire `GET /api/contracts/:id/download-url` for signed URL generation.

**Done:** Visiting `/contracts/{id}` on the frontend shows the full thread — the outbound email, the inbound reply, and a working "Download" link.

### Step 11 — CI/CD

Set up GitHub Actions (from §16 above).  
Add all GitHub Secrets.  
Push to main.

**Done:** Both deploy jobs complete green. Backend is live at the Cloud Run URL. Frontend is live at the Cloudflare Workers URL. Full OAuth → upload → send → reply flow works end-to-end in production.

---

## 18. End-to-End Test Checklist

Run these manually after Step 11. All must pass before the POC is considered complete.

- [ ] **T1 — Login:** Click "Continue with Google", approve, land on dashboard with name displayed
- [ ] **T2 — Service email shown:** Dashboard shows `{slug}-{token}@mail.usetend.in`
- [ ] **T3 — Session persistence:** Open new tab, navigate to `/dashboard` — not redirected to login
- [ ] **T4 — Cookie flags (local dev):** DevTools → Application → Cookies → `better-auth.session` has `HttpOnly`, `SameSite=Lax`. In production it will be `SameSite=None; Secure`.
- [ ] **T5 — Unauthenticated access blocked:** Incognito → `/dashboard` → redirected to `/`
- [ ] **T6 — Already-logged-in redirect:** While logged in, navigate to `/` — server immediately redirects to `/dashboard`, no landing page is shown, no flash.
- [ ] **T7 — Sign-out works:** Click "Sign out" on the dashboard — session is deleted, browser navigates to `/`. Pressing back to `/dashboard` redirects to `/` again (server re-validates the now-invalid cookie).
- [ ] **T8 — OAuth cancel:** Click "Continue with Google" → Cancel on Google's consent screen → return to `/` with a visible "Sign-in was cancelled" banner.
- [ ] **T9 — Sign-in network error:** Stop the backend, click "Continue with Google" — an inline error message appears below the button, button re-enables.
- [ ] **T10 — Upload:** Upload a PDF, verify GCS file appears and DB row created with `status='draft'`
- [ ] **T11 — Send:** Fill in recipient details, click Send, recipient receives the email with PDF attached
- [ ] **T12 — Reply capture:** Reply to the email from a different address, wait ~30 sec, check dashboard — contract shows `status='replied'`, reply PDF is downloadable
- [ ] **T13 — Download URL:** Click download on any contract PDF — file downloads, link expires after 1 hour
- [ ] **T14 — Duplicate webhook:** Use `curl` to POST the same Postmark webhook JSON twice — second request returns `{"ok":true,"note":"duplicate"}`, DB has only one `inbound_emails` row
- [ ] **T15 — CI/CD:** Push a trivial change, both GitHub Actions jobs complete green, change is live
- [ ] **T16 — Health check:** `GET {BACKEND_URL}/health` returns `{"status":"ok"}`

---

## 19. What NOT to Build (Explicitly Deferred)

- **AI pipeline:** Gemini/Claude contract analysis is deferred. The stub in `processInbound` is sufficient.
- **Multi-org / team support:** Single user per account only. No org hierarchy.
- **Dropbox Sign / e-signatures:** The original approach.md included this. Not in scope for this POC.
- **Email notifications:** No "you have a reply" notification emails. The dashboard is the notification mechanism.
- **Rate limiting:** No rate limiting on upload or send. Acceptable for a single-user POC.
- **File type support beyond PDF:** PDFs only. No DOCX, no images.
- **MailboxHash per-contract routing:** The current architecture routes per-user. The advanced pattern (sending with `Reply-To: alice-x7k2+contract-{id}@mail.usetend.in`) is possible but not needed for the POC — we match via `In-Reply-To` header instead.
- **Contract search / filtering:** The dashboard lists all contracts. No search.
- **Webhook retry UI:** No visibility into failed webhook processing in the frontend.

---

## 20. Cleanup Instructions (Manual)

**Delete from GCP:**
```bash
gcloud pubsub subscriptions delete gmail-push-sub
gcloud pubsub topics delete gmail-push-notifications
```

**Keep:**
- GCS bucket `genie-poc-contracts` (europe-west2)
- Cloud Run service (if already deployed, update it — don't recreate)
- NeonDB project + database `genie_poc`

**Delete from local repo:**
```bash
rm -rf backend/ frontend/
```
Then rebuild from scratch following Step 17 above.

---

## 21. Plan-Level Mistakes Found in Testing (2026-05-26)

These are errors that originated in this plan document and were then faithfully implemented in code. They are recorded here so future plans for other components avoid the same patterns.

### Mistake 1 — Sign-out prescribed as an anchor link; then POST sent without Content-Type

**Original plan text (section 9):**
```html
<a href={`${apiUrl}/api/auth/sign-out`}>Sign out</a>
```

**Stage 1 — wrong method:** An `<a href>` issues a GET request. Better Auth's sign-out endpoint is POST-only. Result: 404, session never cleared, browser navigated to the raw backend port and showed a blank page.

**Stage 2 — missing Content-Type:** After switching to `fetch POST`, the request was sent without `Content-Type: application/json` and without a body. Better Auth returned 415 Unsupported Media Type. The session was still never cleared. The browser then navigated to `/`, the SSR session check at `/` found the still-valid session, and redirected back to `/dashboard`. The user was stuck in a loop.

**Correct pattern:** A `<button>` with a JavaScript handler that issues `fetch POST` with `Content-Type: application/json` and `body: '{}'`, then navigates to `/` after completion — regardless of the response status (best-effort, so the user is never stuck on the page):
```javascript
await fetch(`${apiUrl}/api/auth/sign-out`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
  credentials: 'include',
});
window.location.href = '/';
```

---

### Mistake 2 — Landing page prescribed as static (`prerender = true`)

**Original plan text (section 9):**
```astro
---
export const prerender = true
---
```

**Why it is wrong:** A prerendered page is a static file baked at build time. It never runs on the server at request time, so it cannot check the session cookie. A logged-in user visiting `/` always saw the "Continue with Google" button, could click it again, and would create an orphaned session.

**Correct pattern:** Remove `prerender = true`. The page must be SSR. On every request, check the session server-side and issue `Astro.redirect('/dashboard')` if a session exists — before any HTML is sent.

---

### Mistake 3 — Cookie flags hardcoded for production only

**Original plan text (section 4.1):**
```typescript
advanced: {
  defaultCookieAttributes: { sameSite: 'none', secure: true },
},
```

**Why it is wrong:** `SameSite: none` requires `Secure: true`, which requires HTTPS. Local dev runs on HTTP. Setting these flags in local dev causes the browser to silently reject the cookie, breaking auth entirely on `localhost`.

**Correct pattern:** Conditional on `NODE_ENV`:
```typescript
advanced: {
  defaultCookieAttributes: process.env.NODE_ENV === 'production'
    ? { sameSite: 'none', secure: true }
    : { sameSite: 'lax', secure: false },
},
```

---

### Mistake 4 — OAuth cancel not handled; wrong assumption about Better Auth's error redirect behavior

**What was missing:** The plan specified no handling for OAuth cancel or other auth errors.

**Why the initial fix was wrong:** The first fix attempt assumed Better Auth forwards errors to the `callbackURL`. That is incorrect. Better Auth's actual behavior (confirmed in `api/routes/callback.mjs` and `oauth2/state.mjs`):

```javascript
// callback.mjs
const defaultErrorURL = c.context.options.onAPIError?.errorURL || `${c.context.baseURL}/error`;
const baseURL = errorURL ?? defaultErrorURL;
// redirects to: {baseURL}?error={code}
```

Without any configuration, `baseURL` is Better Auth's own built-in `/api/auth/error` page on the backend. The user never reaches the frontend.

**Correct pattern — two layers required:**

Layer 1 — per-request, in the sign-in body (frontend):
```javascript
body: JSON.stringify({
  provider: 'google',
  callbackURL: `${window.location.origin}/dashboard`,
  errorCallbackURL: `${window.location.origin}/`,
}),
```
Better Auth stores `errorCallbackURL` as `errorURL` in the OAuth state. On any error in the callback, it redirects to `{errorCallbackURL}?error={code}`.

Layer 2 — global fallback, in `betterAuth({})` config (backend):
```typescript
onAPIError: {
  errorURL: `${process.env.FRONTEND_URL || 'http://localhost:4321'}/`,
},
```
Covers errors that occur before or outside the OAuth state (state mismatch, provider not found, etc.).

Both layers redirect to the frontend landing page, which reads `?error=` and renders a human-readable banner.
