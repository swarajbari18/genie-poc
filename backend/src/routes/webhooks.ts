import { Hono } from 'hono'
import { db } from '../db/client.js'
import { inboundEmails, contractThreads, contracts } from '../db/schema.js'
import { eq, and, sql, desc } from 'drizzle-orm'
import { getServiceEmailByLocalPart, getServiceEmailByUserId } from '../services/serviceEmail.js'
import { sendSigningInvitationEmail } from '../services/postmarkClient.js'
import {
  verifyCallback,
  downloadSignedFile,
} from '../services/boldsignClient.js'
import { contractsBucket } from '../lib/storage.js'
import { contractSigners } from '../db/schema.js'
import { log } from '../lib/logger.js'
import { notifyUser } from '../lib/events.js'
import { runDiffAnalysis, runTextReplyAnalysis } from '../services/aiAnalysis.js'

const webhooksRouter = new Hono()

const POSTMARK_BASIC = Buffer.from(
  `${process.env.POSTMARK_INBOUND_WEBHOOK_USER}:${process.env.POSTMARK_INBOUND_WEBHOOK_PASS}`
).toString('base64')

function verifyPostmark(authHeader: string | undefined): boolean {
  return authHeader === `Basic ${POSTMARK_BASIC}`
}

/**
 * Normalize a Message-ID-style header to the bare token used as our
 * cross-reference key.
 *
 * Postmark's outbound send API returns a bare UUID (e.g. `a1b2c3d4-...`)
 * which we store in `contract_threads.postmark_message_id`. When the
 * counterparty replies, their mail client copies our outbound email's
 * `Message-ID:` header into `In-Reply-To:`. Postmark generates that header
 * in the form `<{uuid}@{domain}>` (e.g. `<a1b2c3d4-...@mtasv.net>` or
 * `<a1b2c3d4-...@mail.usetend.in>`).
 *
 * So to match, we strip the angle brackets AND drop the `@domain` suffix,
 * leaving the bare UUID. We use this same helper on both the inbound
 * `In-Reply-To` and the inbound `MessageID` so the representation is
 * consistent on both send and match (avoiding §5 of the plan's silent
 * mismatch bug).
 */
function normalizeMessageId(raw: string | undefined | null): string | null {
  if (!raw) return null
  const stripped = raw.replace(/[<>]/g, '').trim()
  if (!stripped) return null
  return stripped.split('@')[0]
}

webhooksRouter.post('/postmark/inbound', async (c) => {
  if (!verifyPostmark(c.req.header('authorization'))) {
    log.warn('webhooks', 'Postmark inbound — invalid auth header')
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let payload: any
  try {
    payload = await c.req.json()
  } catch (err: any) {
    log.warn('webhooks', 'Postmark inbound — invalid JSON body', { error: err?.message })
    // 200 so Postmark doesn't retry malformed input forever
    return c.json({ ok: false, error: 'invalid_json' })
  }

  const rawMessageId: string | undefined = payload?.MessageID
  if (!rawMessageId) {
    log.warn('webhooks', 'Postmark inbound — missing MessageID, cannot dedupe')
    return c.json({ ok: false, error: 'missing_message_id' })
  }

  log.info('webhooks', 'Postmark inbound received', {
    messageId: rawMessageId,
    from: payload.FromFull?.Email ?? payload.From,
    to: payload.OriginalRecipient,
    subject: payload.Subject,
    attachments: (payload.Attachments ?? []).length,
  })

  // Step 1: idempotency — store raw payload, skip if already seen.
  // The unique index on postmark_message_id is the dedup key.
  const inserted = await db
    .insert(inboundEmails)
    .values({
      postmarkMessageId: rawMessageId,
      toAddress: payload.OriginalRecipient ?? '',
      fromAddress: payload.FromFull?.Email ?? payload.From ?? '',
      subject: payload.Subject ?? null,
      rawPayload: payload,
    })
    .onConflictDoNothing({ target: inboundEmails.postmarkMessageId })
    .returning({ id: inboundEmails.id })

  if (inserted.length === 0) {
    log.warn('webhooks', 'Duplicate inbound message — skipping', { messageId: rawMessageId })
    return c.json({ ok: true, note: 'duplicate' })
  }

  const inboundId = inserted[0].id

  // Process asynchronously — return 200 fast, don't block Postmark.
  // A processing failure must NOT bubble out as non-200 (Postmark retries up to 10×
  // for non-200s, which would loop a deterministic bug). We record the error on the
  // inbound row instead and still return 200.
  processInbound(inboundId, payload).catch(async (err) => {
    log.error('webhooks', 'Inbound processing failed', { inboundId, error: err?.message, stack: err?.stack })
    try {
      await db.update(inboundEmails)
        .set({ processingError: err?.message ?? String(err), processedAt: new Date() })
        .where(eq(inboundEmails.id, inboundId))
    } catch (e: any) {
      log.error('webhooks', 'Failed to write processing error to DB', { error: e?.message })
    }
  })

  return c.json({ ok: true })
})

/**
 * POST /webhooks/dropbox-sign/inbound
 * BoldSign webhook handler. (Path retained for back-compat with the previous
 * Dropbox Sign integration — BoldSign is configured to POST here.)
 *
 * BoldSign envelope shape:
 *   { event: { id, created, eventType, clientId, environment },
 *     data: { object: 'document', documentId, signerDetails: [...] } }
 *
 * Verification: HMAC-SHA256 over `${timestamp}.${rawBody}` using BOLDSIGN_WEBHOOK_SECRET,
 * compared against s0/s1 in the X-BoldSign-Signature header. See boldsignClient.ts.
 */
webhooksRouter.post('/dropbox-sign/inbound', async (c) => {
  // 1. Read the raw body BEFORE any parsing — HMAC is over the byte-exact body.
  const rawBody = await c.req.text()

  // 2. Peek at the event type BEFORE HMAC. The 'Verification' handshake is
  //    BoldSign probing that our URL is reachable so it can show us the
  //    signing secret. Until the secret is shown, we obviously can't verify
  //    its signature — chicken-and-egg. Verification is harmless (it triggers
  //    no state changes), so we accept it unauthenticated.
  let event: any
  try {
    event = JSON.parse(rawBody)
  } catch {
    log.warn('webhooks', 'BoldSign — invalid JSON')
    return c.text('Invalid JSON', 400)
  }

  const eventType = getBoldsignEventType(event)
  const eventId = event?.event?.id as string | undefined

  if (eventType === 'Verification' || eventType === 'WebhookTest' || !eventType) {
    log.info('webhooks', 'BoldSign — handshake/test event (no HMAC required)', {
      eventType: eventType ?? '<missing>',
    })
    return c.text('OK')
  }

  // 3. All real events require a valid HMAC.
  const sigHeader = c.req.header('X-BoldSign-Signature') ?? c.req.header('x-boldsign-signature') ?? null
  if (!verifyCallback(rawBody, sigHeader)) {
    log.warn('webhooks', 'BoldSign — invalid signature', { eventType })
    return c.text('Unauthorized', 401)
  }

  const documentId = getBoldsignDocumentId(event)
  if (!documentId || !eventType) {
    log.warn('webhooks', 'BoldSign — missing documentId or eventType', {
      eventType,
      dataKeys: event?.data && typeof event.data === 'object' ? Object.keys(event.data) : [],
    })
    return c.text('OK')
  }

  // 5. Idempotency — reuse inbound_emails ledger, key off BoldSign's event.id
  const dedupKey = `bs:${eventId ?? `${documentId}:${eventType}:${Date.now()}`}`

  const inserted = await db
    .insert(inboundEmails)
    .values({
      postmarkMessageId: dedupKey,
      toAddress: 'boldsign-webhook',
      fromAddress: 'boldsign',
      subject: eventType,
      rawPayload: event,
    })
    .onConflictDoNothing({ target: inboundEmails.postmarkMessageId })
    .returning({ id: inboundEmails.id })

  if (inserted.length === 0) {
    log.info('webhooks', 'Duplicate BoldSign event — skipping', { dedupKey })
    return c.text('OK')
  }

  // 6. Resolve contract
  const contract = await db.query.contracts.findFirst({
    where: eq(contracts.signatureRequestId, documentId),
  })

  if (!contract) {
    log.warn('webhooks', 'BoldSign event for unknown contract', { documentId, eventType })
    return c.text('OK')
  }

  // 7. Process async
  processBoldsignEvent(contract.id, contract.userId, event).catch((err) => {
    log.error('webhooks', 'BoldSign processing failed', {
      contractId: contract.id,
      error: err?.message,
    })
  })

  return c.text('OK')
})

/**
 * Map a BoldSign signer status string to our internal signer status enum.
 * Returns null if the BoldSign status doesn't have a meaningful DB equivalent.
 */
function mapBoldsignSignerStatus(
  raw: string | undefined,
): 'pending' | 'sent' | 'viewed' | 'signed' | 'declined' | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s === 'completed' || s === 'signed') return 'signed'
  if (s === 'declined' || s === 'rejected') return 'declined'
  if (s === 'viewed' || s === 'opened') return 'viewed'
  if (s === 'waitingforsignature' || s === 'pending' || s === 'sent' || s === 'notsigned')
    return 'sent'
  return null
}

function getBoldsignEventType(event: any): string | undefined {
  return event?.event?.eventType ?? event?.context?.eventType
}

function getBoldsignDocumentId(event: any): string | undefined {
  return (
    event?.data?.documentId ??
    event?.data?.document?.documentId ??
    event?.documentId ??
    event?.document?.documentId
  )
}

function getBoldsignSignerDetails(event: any): any[] {
  const details = event?.data?.signerDetails ?? event?.data?.document?.signerDetails
  return Array.isArray(details) ? details : []
}

async function processBoldsignEvent(contractId: string, ownerId: string, event: any) {
  const eventType = getBoldsignEventType(event)
  const documentId = getBoldsignDocumentId(event)
  const signerDetails = getBoldsignSignerDetails(event)

  if (!eventType || !documentId) {
    log.warn('webhooks', 'BoldSign processing skipped — normalized payload incomplete', {
      contractId,
      eventType,
      hasDocumentId: !!documentId,
    })
    return
  }

  log.info('webhooks', 'Processing BoldSign event', {
    contractId,
    eventType,
    signerCount: signerDetails.length,
  })

  let contractStatusUpdate: string | undefined
  let threadMessage: string | undefined

  // Sync every signer's status from the payload — robust against per-event payload variations.
  for (const sd of signerDetails) {
    const email = sd?.signerEmail as string | undefined
    const mapped = mapBoldsignSignerStatus(sd?.status)
    if (!email || !mapped) continue

    const patch: Record<string, unknown> = { status: mapped }
    if (mapped === 'signed') patch.signedAt = new Date()

    await db
      .update(contractSigners)
      .set(patch as any)
      .where(
        and(
          eq(contractSigners.signatureRequestId, documentId),
          sql`lower(${contractSigners.signerEmail}) = lower(${email})`,
        ),
      )
  }

  // Find the "affected" signer for narrative thread messages (per-signer events).
  function findSignerByStatus(target: string): any | undefined {
    return signerDetails.find((s) => (s?.status ?? '').toLowerCase() === target.toLowerCase())
  }

  switch (eventType) {
    case 'Sent': {
      // The 'Sent' event is the canonical "the sender clicked Send in the
      // BoldSign prepare iframe and the request is now live" signal. This is
      // where contract_signers rows get created — using the roster snapshot
      // stashed on the contract at form-submit time.
      const contractRow = await db.query.contracts.findFirst({
        where: eq(contracts.id, contractId),
      })
      const pending = (contractRow?.pendingSigners ?? []) as Array<{
        name: string
        email: string
        order: number
        role: 'creator' | 'counterparty' | 'other'
        genieUserId: string | null
        signingToken: string
      }>

      if (pending.length === 0) {
        log.warn('webhooks', 'BoldSign Sent event but no pendingSigners on contract', {
          contractId,
          documentId,
        })
      } else {
        await db.transaction(async (tx) => {
          for (const ps of pending) {
            const initialStatus =
              ps.order === Math.min(...pending.map((p) => p.order)) ? 'sent' : 'pending'

            await tx
              .insert(contractSigners)
              .values({
                contractId,
                signatureRequestId: documentId,
                signerEmail: ps.email.toLowerCase(),
                signerName: ps.name,
                signingOrder: ps.order,
                role: ps.role,
                genieUserId: ps.genieUserId,
                status: initialStatus as any,
                signingToken: ps.signingToken,
              })
              .onConflictDoNothing()
          }

          // Clear the snapshot — DB state is now canonical.
          await tx
            .update(contracts)
            .set({ pendingSigners: null, updatedAt: new Date() })
            .where(eq(contracts.id, contractId))
        })

        // Send signing invitations to non-Genie signers via Postmark.
        // Genie signers see the "Sign Now" button in their dashboard.
        const senderServiceEmail = await getServiceEmailByUserId(ownerId)
        if (senderServiceEmail && contractRow) {
          const [latestThread] = await db.query.contractThreads.findMany({
            where: eq(contractThreads.contractId, contractId),
            orderBy: [desc(contractThreads.emailDate)],
            limit: 1,
          })
          const replySubject = contractRow.subject?.startsWith('Re:')
            ? contractRow.subject
            : `Re: ${contractRow.subject ?? contractRow.title}`

          for (const ps of pending) {
            if (ps.genieUserId === null) {
              const signingPageUrl = `${process.env.FRONTEND_URL}/sign/${ps.signingToken}`
              sendSigningInvitationEmail({
                fromAddress: senderServiceEmail,
                toAddress: ps.email,
                toName: ps.name,
                subject: replySubject,
                contractTitle: contractRow.title,
                signingPageUrl,
                inReplyToMessageId: latestThread?.postmarkMessageId ?? contractRow.postmarkMessageId ?? undefined,
              }).catch((err) => {
                log.error('webhooks', 'sendSigningInvitationEmail failed', {
                  signerEmail: ps.email,
                  error: err?.message,
                })
              }).then((result) => {
                if (!result) return
                return db.insert(contractThreads).values({
                  contractId,
                  direction: 'outbound',
                  postmarkMessageId: result.messageId,
                  inReplyToMessageId: latestThread?.postmarkMessageId ?? contractRow.postmarkMessageId ?? null,
                  fromAddress: senderServiceEmail,
                  toAddress: ps.email,
                  subject: replySubject,
                  bodyText: `Signing invitation sent to ${ps.name}`,
                  emailDate: new Date(),
                })
              }).catch((err) => {
                log.error('webhooks', 'Failed to store signing invitation thread row', {
                  signerEmail: ps.email,
                  error: err?.message,
                })
              })
            }
          }
        }
      }

      contractStatusUpdate = 'out_for_signature'
      threadMessage = 'Signature request sent to all parties'
      break
    }

    case 'Viewed': {
      const who = findSignerByStatus('Viewed') ?? findSignerByStatus('Opened')
      if (who) threadMessage = `${who.signerName ?? who.signerEmail} viewed the contract`
      break
    }

    case 'Signed': {
      const who = findSignerByStatus('Completed') ?? findSignerByStatus('Signed')
      contractStatusUpdate = 'partially_signed'
      if (who) threadMessage = `${who.signerName ?? who.signerEmail} signed`
      break
    }

    case 'Declined': {
      const who = findSignerByStatus('Declined') ?? findSignerByStatus('Rejected')
      contractStatusUpdate = 'negotiating'
      if (who)
        threadMessage = `${who.signerName ?? who.signerEmail} declined the signature request — back to negotiation`
      break
    }

    case 'Completed': {
      contractStatusUpdate = 'signed'
      threadMessage = 'All parties have signed — executed document is now ready for download'

      log.info('webhooks', 'Fetching executed PDF', { contractId, documentId })
      let pdfBuffer: Buffer | undefined
      try {
        pdfBuffer = await downloadSignedFile(documentId)
      } catch (err: any) {
        // BoldSign's Completed event should mean the PDF is ready, but allow a one-shot retry.
        log.warn('webhooks', 'Executed PDF download failed — retrying in 5s', {
          contractId,
          documentId,
          error: err?.message,
        })
        await new Promise((resolve) => setTimeout(resolve, 5000))
        try {
          pdfBuffer = await downloadSignedFile(documentId)
        } catch (retryErr: any) {
          log.error('webhooks', 'Executed PDF still not available after retry', {
            contractId,
            documentId,
            error: retryErr?.message,
          })
        }
      }

      if (pdfBuffer) {
        const storageKey = `contracts/${ownerId}/${contractId}/signed.pdf`
        await contractsBucket.file(storageKey).save(pdfBuffer, {
          metadata: { contentType: 'application/pdf' },
          resumable: false,
        })
        await db
          .update(contracts)
          .set({ signedStorageKey: storageKey, updatedAt: new Date() })
          .where(eq(contracts.id, contractId))
      }
      break
    }

    // Other BoldSign event types (Expired, Revoked, Reassigned, Edited, DeliveryFailed,
    // AuthenticationFailed, SenderIdentityUpdated) are not modelled — fall through.
  }

  if (contractStatusUpdate) {
    await db
      .update(contracts)
      .set({ status: contractStatusUpdate as any, updatedAt: new Date() })
      .where(eq(contracts.id, contractId))
  }

  if (threadMessage) {
    await db.insert(contractThreads).values({
      contractId,
      direction: 'system',
      subject: 'Signing Update',
      bodyText: threadMessage,
      fromAddress: 'boldsign',
      toAddress: 'owner',
      emailDate: new Date(),
    })
  }

  // Component 6 — live push only when the app's contract status actually changes.
  // BoldSign also emits lifecycle events such as DraftCreated while the sender is
  // still in the embedded prepare iframe; pushing those as statuses causes the
  // contract page to reload and collapse the iframe.
  if (contractStatusUpdate) {
    notifyUser(ownerId, { contractId, status: contractStatusUpdate }).catch((err) => {
      log.error('webhooks', 'notifyUser failed after BoldSign event', { error: err?.message })
    })

    // Notify Genie users who are signers so their page reloads automatically
    // (closes the signing iframe overlay without the signer having to refresh manually).
    const genieSignerRows = await db.query.contractSigners.findMany({
      where: eq(contractSigners.contractId, contractId),
    })
    for (const s of genieSignerRows) {
      if (s.genieUserId && s.genieUserId !== ownerId) {
        notifyUser(s.genieUserId, { contractId, status: contractStatusUpdate }).catch((err) => {
          log.error('webhooks', 'notifyUser failed for signer after BoldSign event', { error: err?.message })
        })
      }
    }
  }
}

async function processInbound(inboundId: string, payload: any) {
  const originalRecipient: string | undefined = payload.OriginalRecipient
  if (!originalRecipient || !originalRecipient.includes('@')) {
    log.warn('webhooks', 'Inbound has no usable OriginalRecipient — marking handled', { inboundId, originalRecipient })
    await markInboundProcessed(inboundId, null)
    return
  }

  const localPart = originalRecipient.split('@')[0].toLowerCase()
  log.info('webhooks', 'Processing inbound email', { inboundId, localPart })

  const serviceEmail = await getServiceEmailByLocalPart(localPart)

  if (!serviceEmail) {
    log.warn('webhooks', 'No service email found for local-part — discarding', { localPart })
    await markInboundProcessed(inboundId, null)
    return
  }

  // Resolve In-Reply-To and normalize to the bare-UUID representation that
  // matches what we stored on the outbound `contract_threads` row at send time.
  const rawInReplyTo = (payload.Headers as Array<{ Name: string; Value: string }> | undefined)
    ?.find((h) => h.Name?.toLowerCase() === 'in-reply-to')?.Value
  const inReplyTo = normalizeMessageId(rawInReplyTo)

  let contractId: string | undefined
  if (inReplyTo) {
    // Constrain the lookup to contracts owned by this service email's user so
    // that in the Genie-to-Genie case — where both an outbound row (sender)
    // and an inbound row (recipient) share the same normalized postmark_message_id
    // — we always match the sender's outbound row and not the recipient's inbound row.
    const [matchedThread] = await db
      .select({ contractId: contractThreads.contractId })
      .from(contractThreads)
      .innerJoin(contracts, eq(contractThreads.contractId, contracts.id))
      .where(
        and(
          eq(contractThreads.postmarkMessageId, inReplyTo),
          eq(contracts.userId, serviceEmail.userId),
        ),
      )
      .limit(1)
    contractId = matchedThread?.contractId
    log.info('webhooks', 'In-Reply-To match', {
      rawInReplyTo,
      normalized: inReplyTo,
      matchedContractId: contractId ?? null,
    })
  } else {
    log.info('webhooks', 'Inbound has no In-Reply-To header')
  }

  // Component 7 — if no In-Reply-To match exists, this is NOT a reply to
  // one of our outbound contracts. Since we already verified the recipient
  // is a Genie user (`serviceEmail` resolved above), it's a contract one
  // Genie user sent to another. We create a `received` contract owned by
  // the recipient (NEVER the email body — owner is always
  // serviceEmail.userId resolved from OriginalRecipient).
  //
  // The receivedContractId, if set, is the freshly-minted contract row's id
  // and is used both for the GCS attachment key and the thread row below.
  let receivedContractId: string | undefined
  let receivedStatusNotify = false
  if (!contractId) {
    receivedContractId = crypto.randomUUID()
    log.info('webhooks', 'Unmatched inbound — treating as received contract (Component 7)', {
      inboundId,
      recipientUserId: serviceEmail.userId,
      newContractId: receivedContractId,
    })
  }

  // Upload PDF attachments to GCS. Non-PDF attachments are dropped for the POC
  // (logged, not raised) — handling them is out of scope.
  const attachmentRecords: Array<{
    filename: string
    contentType: string
    storageKey: string
    sizeBytes: number
  }> = []

  for (const att of (payload.Attachments ?? [])) {
    const contentType: string = att.ContentType ?? ''
    if (!contentType.toLowerCase().includes('pdf')) {
      log.warn('webhooks', 'Dropping non-PDF attachment', {
        inboundId,
        filename: att.Name,
        contentType,
        sizeBytes: att.ContentLength,
      })
      continue
    }

    const buffer = Buffer.from(att.Content, 'base64')
    const timestamp = Date.now()

    // Storage key rules:
    //   matched reply     → contracts/{userId}/{contractId}/reply-{ts}.pdf
    //   received contract → contracts/{userId}/{newContractId}/original.pdf
    //                       (the first attachment is the "original"; any
    //                       further attachments still go under reply-{ts}
    //                       to avoid clobbering)
    //   defensive fallback (no match AND no received id, can't normally
    //                       happen since localPart resolved) →
    //                       inbound/{userId}/{messageId}.pdf — kept so
    //                       nothing is lost
    let storageKey: string
    if (contractId) {
      storageKey = `contracts/${serviceEmail.userId}/${contractId}/reply-${timestamp}.pdf`
    } else if (receivedContractId) {
      storageKey = attachmentRecords.length === 0
        ? `contracts/${serviceEmail.userId}/${receivedContractId}/original.pdf`
        : `contracts/${serviceEmail.userId}/${receivedContractId}/reply-${timestamp}.pdf`
    } else {
      storageKey = `inbound/${serviceEmail.userId}/${payload.MessageID}.pdf`
    }

    await contractsBucket.file(storageKey).save(buffer, {
      metadata: { contentType },
      resumable: false,
    })

    attachmentRecords.push({
      filename: att.Name,
      contentType,
      storageKey,
      sizeBytes: att.ContentLength ?? buffer.byteLength,
    })
  }

  // Normalize the MessageID we store on the thread row for reply-chain matching.
  //
  // Postmark inbound webhooks carry TWO separate identifiers:
  //   payload.MessageID      — Postmark's own inbound tracking UUID (fresh per delivery)
  //   payload.Headers["Message-ID"] — the RFC email header on the message itself
  //
  // For emails sent via Postmark outbound, the RFC Message-ID header is
  // <{outbound_uuid}@{postmark-domain}> — i.e. the same UUID that the send API
  // returned and that we stored on the outbound thread row. Using the RFC header
  // here means a Genie-to-Genie reply will produce an In-Reply-To that normalizes
  // back to the outbound UUID, allowing the sender's contract to be matched on the
  // next inbound delivery. Using payload.MessageID (Postmark's tracking ID) breaks
  // this because it is a different UUID and the sender's thread row never matches.
  const rfcMessageId = (payload.Headers as Array<{ Name: string; Value: string }> | undefined)
    ?.find(h => h.Name?.toLowerCase() === 'message-id')?.Value
  const inboundMessageIdNormalized =
    normalizeMessageId(rfcMessageId) ??
    normalizeMessageId(payload.MessageID) ??
    payload.MessageID

  // Guard against Invalid Date from odd Date header formats — fall back to now().
  let emailDate = new Date(payload.Date)
  if (isNaN(emailDate.getTime())) {
    log.warn('webhooks', 'Unparseable email Date header — using now()', {
      inboundId,
      rawDate: payload.Date,
    })
    emailDate = new Date()
  }

  // Component 7 — for a received contract, create the contracts row FIRST
  // so the thread row's FK target (contract_id) exists. The original
  // attachment, if any, was already uploaded under the received contract's
  // GCS prefix above (key was minted from receivedContractId).
  if (receivedContractId) {
    const firstAttachment = attachmentRecords[0]
    const senderEmail = payload.FromFull?.Email ?? payload.From ?? ''
    const senderName = payload.FromFull?.Name ?? null
    const subject = payload.Subject ?? '(no subject)'
    // Prefer subject with Genie suffix stripped; fall back to title-cased filename
    const cleanSubject = subject.split(' — ')[0].trim()
    const cleanFilename = firstAttachment?.filename
      ? firstAttachment.filename
          .replace(/\.pdf$/i, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (ch: string) => ch.toUpperCase())
          .trim()
      : null
    const title = (cleanSubject && cleanSubject !== '(no subject)') ? cleanSubject : (cleanFilename ?? 'Received contract')

    await db.insert(contracts).values({
      id: receivedContractId,
      userId: serviceEmail.userId,
      title,
      // Counterparty convention: recipient_* hold the SENDER for a received contract.
      recipientName: senderName,
      recipientEmail: senderEmail,
      subject,
      // If there's no attachment, we still record the contract — the
      // storageKey points at the (would-be) original path. It's a stub
      // value because the column is NOT NULL; any download attempt is
      // gated by the existing ownership+key-in-thread check (the key
      // won't appear on any thread row, so signing is refused).
      storageKey: firstAttachment?.storageKey
        ?? `contracts/${serviceEmail.userId}/${receivedContractId}/no-attachment`,
      originalFilename: firstAttachment?.filename ?? '(no attachment)',
      mimeType: firstAttachment?.contentType ?? 'application/octet-stream',
      fileSizeBytes: firstAttachment?.sizeBytes ?? 0,
      status: 'received',
      origin: 'received',
    })
    log.info('webhooks', 'Received contract created', {
      contractId: receivedContractId,
      ownerUserId: serviceEmail.userId,
      senderEmail,
      hasAttachment: !!firstAttachment,
    })
    receivedStatusNotify = true
  }

  // Insert thread entry.
  // - matched reply       → contractId
  // - received contract   → receivedContractId
  // - defensive fallback  → 'unknown' (kept for replay; inbound_emails row stays)
  const insertContractId = contractId ?? receivedContractId ?? 'unknown'
  const [threadRow] = await db.insert(contractThreads).values({
    contractId: insertContractId,
    direction: 'inbound',
    postmarkMessageId: inboundMessageIdNormalized,
    inReplyToMessageId: inReplyTo ?? null,
    fromAddress: payload.FromFull?.Email ?? payload.From ?? '',
    toAddress: originalRecipient,
    subject: payload.Subject ?? '',
    bodyText: payload.TextBody ?? null,
    bodyHtml: payload.HtmlBody ?? null,
    attachments: attachmentRecords,
    emailDate,
  }).returning({ id: contractThreads.id })

  // Update contract status → replied (matched reply path).
  if (contractId) {
    await db.update(contracts)
      .set({ status: 'replied', updatedAt: new Date() })
      .where(eq(contracts.id, contractId))
    log.info('webhooks', 'Contract status updated to replied', { contractId })
  }

  await markInboundProcessed(inboundId, threadRow.id)

  // Component 6 — live push to the contract's owner.
  // Matched reply → owner is the contract owner (look it up to be safe).
  // Received contract → owner is the recipient service email user.
  if (contractId) {
    const owning = await db.query.contracts.findFirst({
      where: eq(contracts.id, contractId),
    })
    if (owning) {
      notifyUser(owning.userId, { contractId, status: 'replied' }).catch((err) => {
        log.error('webhooks', 'notifyUser failed after matched reply', { error: err?.message })
      })
    }
  } else if (receivedStatusNotify && receivedContractId) {
    notifyUser(serviceEmail.userId, {
      contractId: receivedContractId,
      status: 'received',
    }).catch((err) => {
      log.error('webhooks', 'notifyUser failed after received contract', { error: err?.message })
    })
  }

  log.info('webhooks', 'Inbound processing complete', {
    inboundId,
    contractId: insertContractId,
    threadId: threadRow.id,
    attachmentsStored: attachmentRecords.length,
    branch: contractId ? 'matched-reply' : receivedContractId ? 'received-contract' : 'unmatched-fallback',
  })

  // Component 9 — fire AI diff analysis
  if (contractId && attachmentRecords.some(a => a.contentType.toLowerCase().includes('pdf'))) {
    const owning = await db.query.contracts.findFirst({
      where: eq(contracts.id, contractId),
    })
    if (owning) {
      const newPdf = attachmentRecords.find(a => a.contentType.toLowerCase().includes('pdf'))!
      runDiffAnalysis({
        contractId,
        ownerUserId: owning.userId,
        newThreadId: threadRow.id,
        newAttachmentKey: newPdf.storageKey,
      }).catch((err) => {
        log.error('webhooks', 'AI diff analysis failed to start', { contractId, error: err?.message })
      })
    }
  }

  // Text reply analysis — fires when the reply has no PDF attachment.
  if (contractId) {
    const replyText = payload.TextBody ?? ''
    await triggerAiPipeline(contractId, attachmentRecords, replyText)
  }
}

async function markInboundProcessed(inboundId: string, threadEntryId: string | null) {
  await db.update(inboundEmails)
    .set({
      processed: true,
      threadEntryId,
      processedAt: new Date(),
    })
    .where(eq(inboundEmails.id, inboundId))
}

async function triggerAiPipeline(
  contractId: string,
  attachments: Array<{ storageKey: string }>,
  replyText: string,
): Promise<void> {
  // Only run for text-only replies — PDF replies are handled by runDiffAnalysis above.
  if (attachments.length > 0 || !replyText.trim()) return

  const owning = await db.query.contracts.findFirst({
    where: eq(contracts.id, contractId),
  })
  if (!owning) return

  runTextReplyAnalysis({
    contractId,
    ownerUserId: owning.userId,
    replyText,
  }).catch((err) => {
    log.error('webhooks', 'Text reply analysis failed', { contractId, error: err?.message })
  })
}

export default webhooksRouter
