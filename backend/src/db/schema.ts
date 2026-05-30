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
import { sql } from 'drizzle-orm'

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
  // Component 7 — an inbound contract from another Genie user.
  // The recipient's "Received" inbox lives on this status.
  // MUST stay last: Postgres enum values can only be APPENDED.
  'received',
  'out_for_signature', // [C8] signature request created, awaiting signatures
  'partially_signed',  // [C8] ≥1 but not all parties signed
])

export const threadDirectionEnum = pgEnum('thread_direction', [
  'outbound', // we sent it
  'inbound',  // recipient replied
  'system',   // [C8] signing-lifecycle event
])

// Component 7 — distinguishes a contract this user created (and sent
// outbound) from one that was sent TO this user by another Genie user.
export const contractOriginEnum = pgEnum('contract_origin', [
  'created',   // I created this contract by uploading a PDF
  'received',  // another Genie user sent it to my service address
])

export const signerStatusEnum = pgEnum('signer_status', [
  'pending',
  'sent',
  'viewed',
  'signed',
  'declined',
])

export const signerRoleEnum = pgEnum('signer_role', [
  'creator',
  'counterparty',
  'other',
])

// ---------------------------------------------------------------------------
// projects — groups contracts by client / deal
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: id(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (t) => [
    index('projects_user_id_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// contacts — recent people a user sends contracts to
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    company: text('company'),
    source: text('source').notNull().default('manual'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('contacts_user_id_idx').on(t.userId),
    index('contacts_user_last_used_idx').on(t.userId, t.lastUsedAt),
    uniqueIndex('contacts_user_email_uidx').on(t.userId, t.email),
  ],
)

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

    // Component 7 — 'created' = this user uploaded the PDF;
    //               'received' = arrived inbound from another Genie user.
    // Defaults to 'created' so existing rows backfill correctly.
    origin: contractOriginEnum('origin').notNull().default('created'),

    // Postmark MessageID returned by the outbound send API
    // Used to match In-Reply-To headers on inbound replies
    postmarkMessageId: text('postmark_message_id'),

    subject: text('subject'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),

    // FK → projects.id (nullable — contracts can exist without a project)
    projectId: text('project_id'),

    // All review recipients — [{name, email}]. recipientName/Email hold first entry for display.
    recipients: jsonb('recipients').$type<Array<{ name: string; email: string }>>(),

    // AI analysis output (stub for now)
    aiAnalysis: jsonb('ai_analysis'),
    aiStartedAt: timestamp('ai_started_at', { withTimezone: true, mode: 'date' }),
    aiCompletedAt: timestamp('ai_completed_at', { withTimezone: true, mode: 'date' }),

    notes: text('notes'),

    // [C8] BoldSign document id; the webhook lookup key. Unique; null until sent for signature.
    signatureRequestId: text('signature_request_id'),
    // [C8] GCS key of the executed PDF, e.g. contracts/{userId}/{contractId}/signed.pdf; null until all-signed.
    signedStorageKey: text('signed_storage_key'),

    // [C8] Roster snapshot captured at send-form submission, carried forward
    // until the BoldSign 'Sent' webhook arrives (which is when contract_signers
    // rows are actually created). Cleared once those rows exist.
    // Shape: Array<{ name, email, order, role, genieUserId, signingToken }>
    pendingSigners: jsonb('pending_signers'),

    ...timestamps,
  },
  (t) => [
    index('contracts_user_id_idx').on(t.userId),
    index('contracts_status_idx').on(t.status),
    index('contracts_user_status_idx').on(t.userId, t.status),
    uniqueIndex('contracts_postmark_msg_id_uidx').on(t.postmarkMessageId),
    uniqueIndex('contracts_signature_request_id_uidx').on(t.signatureRequestId),
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

    // Outbound: bare UUID returned by the Postmark send API — unique per send.
    // Inbound: RFC Message-ID header normalized to bare UUID — identical to the
    //   corresponding outbound row's value in a Genie-to-Genie flow (one email,
    //   two rows). The uniqueness constraint is therefore scoped to outbound only.
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
    // Partial unique index: outbound rows only.
    // Inbound rows can share the same postmark_message_id as the corresponding
    // outbound row (Genie-to-Genie), so global uniqueness is wrong here.
    uniqueIndex('ct_postmark_msg_id_uidx')
      .on(t.postmarkMessageId)
      .where(sql`direction = 'outbound' AND postmark_message_id IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// inboundEmails — raw Postmark webhook store for idempotency + debugging
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// contractSigners — one row per party on a signature request
// ---------------------------------------------------------------------------

export const contractSigners = pgTable(
  'contract_signers',
  {
    id: id(),
    contractId: text('contract_id').notNull(),
    signatureRequestId: text('signature_request_id').notNull(),
    signerEmail: text('signer_email').notNull(),
    signerName: text('signer_name').notNull(),
    signingOrder: integer('signing_order'),
    role: signerRoleEnum('role').notNull().default('other'),
    genieUserId: text('genie_user_id'),
    status: signerStatusEnum('status').notNull().default('pending'),
    signedAt: timestamp('signed_at', { withTimezone: true, mode: 'date' }),
    // Stable token for non-Genie signers' email link — never expires, generates fresh sign URL on click
    signingToken: text('signing_token'),
    ...timestamps,
  },
  (t) => [
    index('cs_contract_id_idx').on(t.contractId),
    index('cs_signature_request_id_idx').on(t.signatureRequestId),
    index('cs_contract_order_idx').on(t.contractId, t.signingOrder),
    uniqueIndex('cs_signing_token_uidx').on(t.signingToken),
  ],
)

// ---------------------------------------------------------------------------
// contractVersions — immutable version history for a contract's text
// ---------------------------------------------------------------------------

export const contractVersions = pgTable(
  'contract_versions',
  {
    id: id(),
    contractId: text('contract_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    text: text('text').notNull(),
    htmlContent: text('html_content'),
    storageKey: text('storage_key'),
    authoredBy: text('authored_by').notNull(), // 'owner' | 'counterparty'
    message: text('message'),
    ...timestamps,
  },
  (t) => [
    index('cv_contract_id_idx').on(t.contractId),
    index('cv_contract_version_idx').on(t.contractId, t.versionNumber),
  ],
)

// ---------------------------------------------------------------------------
// reviewSessions — counterparty's private review workspace, one per send
// ---------------------------------------------------------------------------

export const reviewSessions = pgTable(
  'review_sessions',
  {
    id: id(),
    contractId: text('contract_id').notNull(),
    token: text('token').notNull(),
    counterpartyEmail: text('counterparty_email'),
    status: text('status').notNull().default('active'), // 'active' | 'submitted' | 'cancelled'
    baseVersionId: text('base_version_id'),
    workingText: text('working_text'),
    submittedVersionId: text('submitted_version_id'),
    ...timestamps,
  },
  (t) => [
    index('rs_contract_id_idx').on(t.contractId),
    uniqueIndex('rs_token_uidx').on(t.token),
  ],
)

// ---------------------------------------------------------------------------
// reviewMessages — AI chat history inside a review session
// ---------------------------------------------------------------------------

export const reviewMessages = pgTable(
  'review_messages',
  {
    id: id(),
    reviewSessionId: text('review_session_id').notNull(),
    role: text('role').notNull(), // 'user' | 'assistant'
    content: text('content').notNull(),
    suggestedText: text('suggested_text'),
    ...timestamps,
  },
  (t) => [
    index('rm_session_id_idx').on(t.reviewSessionId),
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
export type ContractSigner  = typeof contractSigners.$inferSelect
export type NewContractSigner = typeof contractSigners.$inferInsert
export type Project              = typeof projects.$inferSelect
export type NewProject           = typeof projects.$inferInsert
export type Contact              = typeof contacts.$inferSelect
export type NewContact           = typeof contacts.$inferInsert
export type ContractVersion      = typeof contractVersions.$inferSelect
export type NewContractVersion   = typeof contractVersions.$inferInsert
export type ReviewSession        = typeof reviewSessions.$inferSelect
export type NewReviewSession     = typeof reviewSessions.$inferInsert
export type ReviewMessage        = typeof reviewMessages.$inferSelect
export type NewReviewMessage     = typeof reviewMessages.$inferInsert
