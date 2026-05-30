import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { contractsBucket, generateDownloadSignedUrl } from '../lib/storage.js';
import { sendContractEmail, sendReplyEmail } from '../services/postmarkClient.js';
import { createEmbeddedPrepareRequest, getEmbeddedSignUrl, } from '../services/boldsignClient.js';
import { db } from '../db/client.js';
import { contracts, contractThreads, contractSigners, contractVersions, reviewSessions, serviceEmails, } from '../db/schema.js';
import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm';
import { getServiceEmailByUserId } from '../services/serviceEmail.js';
import { rememberContact } from '../services/contacts.js';
import { extractPdfText } from '../services/textExtract.js';
import { log } from '../lib/logger.js';
import { notifyUser } from '../lib/events.js';
const contractsRouter = new Hono();
/**
 * Dashboard list — grouped by status priority.
 *
 * `approach.md` describes a `sort_group` CASE query that the original
 * shipped `findMany` did not implement (plan §4.3). Component 7 needs
 * "Received" to land at the top under "Needs Attention" alongside
 * `replied`, so the frontend can break sections on a `sort_group`
 * change. We adopt the raw query (Principle 1: backend decides order,
 * frontend just renders) and surface `origin` so the UI can label
 * received contracts.
 *
 * Groups:
 *   1 = needs your attention (received from another Genie user,
 *       counterparty replied, AI flagged negotiation)
 *   2 = in flight (draft, sent, AI still processing)
 *   3 = closed (signed, declined, completed)
 */
contractsRouter.get('/', requireAuth, async (c) => {
    const user = c.get('user');
    const rows = await db.execute(sql `
    WITH all_contracts AS (
      -- Branch 1: contracts this user owns
      SELECT
        c.id,
        c.user_id           AS "userId",
        c.title,
        c.storage_key       AS "storageKey",
        c.original_filename AS "originalFilename",
        c.mime_type         AS "mimeType",
        c.file_size_bytes   AS "fileSizeBytes",
        c.recipient_name    AS "recipientName",
        c.recipient_email   AS "recipientEmail",
        c.status,
        c.origin,
        c.postmark_message_id AS "postmarkMessageId",
        c.subject,
        c.sent_at           AS "sentAt",
        c.created_at        AS "createdAt",
        c.updated_at        AS "updatedAt",
        CASE
          WHEN c.status IN ('received','replied','negotiating','partially_signed') THEN 1
          WHEN c.status IN ('draft','sent','ai_processing','out_for_signature')    THEN 2
          ELSE 3
        END AS sort_group,
        (
          SELECT EXISTS (
            SELECT 1 FROM contract_signers cs2
            WHERE cs2.contract_id = c.id
              AND cs2.genie_user_id = ${user.id}
              AND cs2.status IN ('pending', 'sent', 'viewed')
          )
        ) AS "awaitingMySignature"
      FROM contracts c
      WHERE c.user_id = ${user.id}

      UNION

      -- Branch 2: contracts owned by another user where current user is a pending signer
      SELECT
        c.id,
        c.user_id           AS "userId",
        c.title,
        c.storage_key       AS "storageKey",
        c.original_filename AS "originalFilename",
        c.mime_type         AS "mimeType",
        c.file_size_bytes   AS "fileSizeBytes",
        c.recipient_name    AS "recipientName",
        c.recipient_email   AS "recipientEmail",
        c.status,
        c.origin,
        c.postmark_message_id AS "postmarkMessageId",
        c.subject,
        c.sent_at           AS "sentAt",
        c.created_at        AS "createdAt",
        c.updated_at        AS "updatedAt",
        CASE
          WHEN c.status IN ('received','replied','negotiating','partially_signed') THEN 1
          WHEN c.status IN ('draft','sent','ai_processing','out_for_signature')    THEN 2
          ELSE 3
        END AS sort_group,
        (cs.status IN ('pending', 'sent', 'viewed')) AS "awaitingMySignature"
      FROM contracts c
      JOIN contract_signers cs ON cs.contract_id = c.id
      WHERE cs.genie_user_id = ${user.id}
        AND cs.status IN ('pending', 'sent', 'viewed', 'signed', 'declined')
        AND c.user_id != ${user.id}
    )
    SELECT * FROM all_contracts
    ORDER BY sort_group ASC, "updatedAt" DESC
  `);
    log.info('contracts', 'Listed contracts', { userId: user.id, count: rows.length });
    return c.json({ contracts: rows });
});
contractsRouter.post('/upload', requireAuth, async (c) => {
    const user = c.get('user');
    const formData = await c.req.formData();
    const file = formData.get('file');
    const title = formData.get('title');
    if (!file || !(file instanceof File)) {
        return c.json({ error: 'No file provided' }, 400);
    }
    if (file.type !== 'application/pdf') {
        return c.json({ error: 'Only PDF files accepted' }, 400);
    }
    if (file.size > 20 * 1024 * 1024) {
        return c.json({ error: 'File too large (max 20 MB)' }, 413);
    }
    log.info('contracts', 'Upload started', { userId: user.id, filename: file.name, sizeBytes: file.size });
    const contractId = crypto.randomUUID();
    const storageKey = `contracts/${user.id}/${contractId}/original.pdf`;
    const buffer = Buffer.from(await file.arrayBuffer());
    await contractsBucket.file(storageKey).save(buffer, {
        metadata: { contentType: 'application/pdf' },
        resumable: false,
    });
    await db.insert(contracts).values({
        id: contractId,
        userId: user.id,
        title: title || file.name.replace(/\.[^.]+$/, ''),
        storageKey,
        originalFilename: file.name,
        fileSizeBytes: file.size,
    });
    // Extract text and store as version 1
    try {
        const extractedText = await extractPdfText(buffer);
        await db.insert(contractVersions).values({
            contractId,
            versionNumber: 1,
            text: extractedText,
            storageKey,
            authoredBy: 'owner',
            message: 'Original document',
        });
        log.info('contracts', 'Version 1 created', { contractId, chars: extractedText.length });
    }
    catch (err) {
        log.warn('contracts', 'Text extraction failed — version 1 skipped', {
            contractId,
            error: err?.message,
        });
    }
    log.info('contracts', 'Upload complete', { contractId, storageKey });
    return c.json({ contractId }, 201);
});
contractsRouter.get('/:id', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    // Single query: contract + threads (oldest-first) + signers via LATERAL subqueries.
    // LATERAL avoids the cross-join row multiplication that occurs when LEFT JOINing
    // both threads and signers in the same query (threads × signers duplicates).
    // LATERAL also allows ORDER BY inside json_agg without DISTINCT, which is required
    // by PostgreSQL (DISTINCT + ORDER BY requires the ORDER BY expression to be
    // identical to the aggregate expression — impossible with jsonb_build_object).
    const rows = await db.execute(sql `
    SELECT
      c.id,
      c.user_id             AS "userId",
      c.title,
      c.storage_key         AS "storageKey",
      c.original_filename   AS "originalFilename",
      c.mime_type           AS "mimeType",
      c.file_size_bytes     AS "fileSizeBytes",
      c.recipient_name      AS "recipientName",
      c.recipient_email     AS "recipientEmail",
      c.status,
      c.origin,
      c.postmark_message_id AS "postmarkMessageId",
      c.subject,
      c.sent_at             AS "sentAt",
      c.notes,
      c.signature_request_id AS "signatureRequestId",
      c.signed_storage_key  AS "signedStorageKey",
      c.ai_analysis         AS "aiAnalysis",
      c.created_at          AS "createdAt",
      c.updated_at          AS "updatedAt",
      t_agg.threads,
      s_agg.signers
    FROM contracts c
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        json_agg(
          jsonb_build_object(
            'id',                    t.id,
            'direction',             t.direction,
            'body',                  t.body_text,
            'bodyHtml',              t.body_html,
            'emailDate',             t.email_date,
            'fromName',              t.from_address,
            'fromAddress',           t.from_address,
            'toAddress',             t.to_address,
            'subject',               t.subject,
            'postmarkMessageId',     t.postmark_message_id,
            'inReplyToMessageId',    t.in_reply_to_message_id,
            'attachments',           t.attachments
          ) ORDER BY t.email_date ASC
        ),
        '[]'::json
      ) AS threads
      FROM contract_threads t
      WHERE t.contract_id = c.id
    ) t_agg ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        json_agg(
          jsonb_build_object(
            'id',                 s.id,
            'signerName',         s.signer_name,
            'signerEmail',        s.signer_email,
            'status',             s.status,
            'genieUserId',        s.genie_user_id,
            'signingOrder',       s.signing_order,
            'role',               s.role,
            'signedAt',           s.signed_at,
            'signingToken',       s.signing_token
          )
        ),
        '[]'::json
      ) AS signers
      FROM contract_signers s
      WHERE s.contract_id = c.id
    ) s_agg ON true
    WHERE c.id = ${contractId}
      AND (
        c.user_id = ${user.id}
        OR EXISTS (
          SELECT 1 FROM contract_signers cs
          WHERE cs.contract_id = c.id
            AND cs.genie_user_id = ${user.id}
            AND cs.status IN ('pending', 'sent', 'viewed', 'signed', 'declined')
        )
      )
  `);
    if (rows.length === 0)
        return c.json({ error: 'Not found' }, 404);
    const row = rows[0];
    const contract = {
        id: row.id,
        userId: row.userId,
        title: row.title,
        storageKey: row.storageKey,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        fileSizeBytes: row.fileSizeBytes,
        recipientName: row.recipientName,
        recipientEmail: row.recipientEmail,
        status: row.status,
        origin: row.origin,
        postmarkMessageId: row.postmarkMessageId,
        subject: row.subject,
        sentAt: row.sentAt,
        notes: row.notes,
        signatureRequestId: row.signatureRequestId,
        signedStorageKey: row.signedStorageKey,
        aiAnalysis: row.aiAnalysis,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
    return c.json({
        contract,
        threads: row.threads ?? [],
        signers: row.signers ?? [],
    });
});
contractsRouter.post('/:id/send', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    const { recipientName, recipientEmail } = await c.req.json();
    log.info('contracts', 'Send requested', { contractId, recipientEmail, userId: user.id });
    const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
    });
    if (!contract || contract.status !== 'draft') {
        log.warn('contracts', 'Send rejected — contract not found or not in draft', { contractId, status: contract?.status });
        return c.json({ error: 'Contract not found or already sent' }, 404);
    }
    const fromAddress = await getServiceEmailByUserId(user.id);
    if (!fromAddress) {
        log.warn('contracts', 'Send rejected — service email not provisioned', { userId: user.id });
        return c.json({ error: 'Service email not provisioned' }, 400);
    }
    // Subject is always derived from the contract title, never from the filename.
    const subject = `${contract.title} — Review Requested`;
    // Create review session so the counterparty gets a workspace link
    const reviewToken = crypto.randomUUID();
    const latestVersion = await db.query.contractVersions.findFirst({
        where: eq(contractVersions.contractId, contractId),
        orderBy: [asc(contractVersions.versionNumber)],
    });
    await db.insert(reviewSessions).values({
        contractId,
        token: reviewToken,
        counterpartyEmail: recipientEmail,
        status: 'active',
        baseVersionId: latestVersion?.id ?? null,
        workingText: latestVersion?.text ?? null,
    });
    const frontendUrl = process.env.FRONTEND_URL ?? 'https://app.genieai.co';
    const reviewUrl = `${frontendUrl}/review/${reviewToken}`;
    // Re-read PDF from GCS to attach
    const [fileContents] = await contractsBucket.file(contract.storageKey).download();
    const pdfBase64 = fileContents.toString('base64');
    const { messageId } = await sendContractEmail({
        fromAddress,
        toAddress: recipientEmail,
        toName: recipientName,
        subject,
        contractId,
        contractTitle: contract.title,
        senderName: user.name ?? user.email,
        recipientName: recipientName ?? recipientEmail,
        pdfBase64,
        pdfFilename: contract.originalFilename,
        reviewUrl,
    });
    await db.update(contracts)
        .set({
        status: 'sent',
        postmarkMessageId: messageId,
        recipientEmail,
        recipientName,
        subject,
        sentAt: new Date(),
        updatedAt: new Date()
    })
        .where(eq(contracts.id, contractId));
    await db.insert(contractThreads).values({
        contractId,
        direction: 'outbound',
        postmarkMessageId: messageId,
        fromAddress,
        toAddress: recipientEmail,
        subject,
        emailDate: new Date(),
    });
    await rememberContact(user.id, {
        name: recipientName,
        email: recipientEmail,
        source: 'review',
    });
    // Component 6 — push the live status update to any open dashboard/page.
    notifyUser(user.id, { contractId, status: 'sent' }).catch((err) => {
        log.error('contracts', 'notifyUser failed after send', { error: err?.message });
    });
    log.info('contracts', 'Contract sent via Postmark', { contractId, messageId, fromAddress, recipientEmail });
    return c.json({ ok: true, messageId });
});
/**
 * POST /:id/reply — Component 5, the in-thread reply / negotiation loop.
 *
 * Multipart: `message` (text, required), `file` (PDF, optional, ≤20 MB).
 *
 * Guards (server-side; the hidden composer is UX only):
 *   - Ownership: contract.user_id === session.user.id, else 404.
 *   - Turn: only allowed when the latest thread entry is `inbound`
 *     (i.e. it's our turn). Else 409.
 *
 * Threading:
 *   - We look up the latest inbound thread row to find the bare
 *     normalized message id we'll set as In-Reply-To / References on
 *     the outgoing email — so the counterparty's mail client threads
 *     this reply visually.
 *   - We store Postmark's returned bare MessageID on the new outbound
 *     row, exactly the same shape as the original /send path. That's
 *     what makes the NEXT inbound reply matchable on round 3+ by
 *     Component 4's normalizeMessageId — store bare, match bare.
 */
contractsRouter.post('/:id/reply', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    // (1) Ownership
    const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
    });
    if (!contract) {
        log.warn('contracts', 'Reply rejected — contract not found or not owned', {
            contractId,
            userId: user.id,
        });
        return c.json({ error: 'Not found' }, 404);
    }
    // (2) Turn — latest thread entry must be `inbound`. This is the same
    //     server-side check the composer mirrors in the UI.
    const [latestThread] = await db.query.contractThreads.findMany({
        where: eq(contractThreads.contractId, contractId),
        orderBy: [desc(contractThreads.emailDate)],
        limit: 1,
    });
    if (!latestThread) {
        log.warn('contracts', 'Reply rejected — no thread to reply to', { contractId });
        return c.json({ error: 'Nothing to reply to yet' }, 409);
    }
    if (latestThread.direction !== 'inbound') {
        log.warn('contracts', 'Reply rejected — not your turn', {
            contractId,
            latestDirection: latestThread.direction,
            status: contract.status,
        });
        return c.json({ error: 'Not your turn — awaiting counterparty' }, 409);
    }
    // The bare-normalized id of the inbound message we're answering.
    // Component 4 stored this normalized on insert; we point our In-Reply-To at it.
    const replyTargetMessageId = latestThread.postmarkMessageId;
    if (!replyTargetMessageId) {
        log.error('contracts', 'Reply rejected — latest inbound has no postmark_message_id', {
            contractId,
            latestThreadId: latestThread.id,
        });
        return c.json({ error: 'Cannot thread reply — missing message id on inbound' }, 500);
    }
    // (3) Parse multipart.
    const form = await c.req.formData();
    const message = form.get('message')?.trim() ?? '';
    if (!message)
        return c.json({ error: 'Empty message' }, 400);
    const fileRaw = form.get('file');
    let attachmentMeta;
    let attachmentBase64;
    if (fileRaw && fileRaw instanceof File && fileRaw.size > 0) {
        if (fileRaw.type !== 'application/pdf') {
            return c.json({ error: 'Only PDF attachments accepted' }, 400);
        }
        if (fileRaw.size > 20 * 1024 * 1024) {
            return c.json({ error: 'Attachment too large (max 20 MB)' }, 413);
        }
        const buffer = Buffer.from(await fileRaw.arrayBuffer());
        const timestamp = Date.now();
        const storageKey = `contracts/${user.id}/${contractId}/reply-${timestamp}.pdf`;
        await contractsBucket.file(storageKey).save(buffer, {
            metadata: { contentType: 'application/pdf' },
            resumable: false,
        });
        attachmentMeta = {
            filename: fileRaw.name || `reply-${timestamp}.pdf`,
            contentType: 'application/pdf',
            storageKey,
            sizeBytes: fileRaw.size,
        };
        attachmentBase64 = buffer.toString('base64');
    }
    // (4) Resolve service address (from).
    const fromAddress = await getServiceEmailByUserId(user.id);
    if (!fromAddress) {
        log.warn('contracts', 'Reply rejected — service email not provisioned', { userId: user.id });
        return c.json({ error: 'Service email not provisioned' }, 400);
    }
    const toAddress = contract.recipientEmail ?? latestThread.fromAddress;
    if (!toAddress) {
        log.error('contracts', 'Reply rejected — no recipient address available', { contractId });
        return c.json({ error: 'No recipient address known for this contract' }, 500);
    }
    const baseSubject = contract.subject ?? latestThread.subject ?? contract.title;
    const subject = baseSubject.startsWith('Re:') ? baseSubject : `Re: ${baseSubject}`;
    // (5) Send via Postmark with threading headers.
    const { messageId } = await sendReplyEmail({
        fromAddress,
        toAddress,
        toName: contract.recipientName ?? undefined,
        subject,
        bodyText: message,
        senderName: user.name ?? user.email,
        recipientName: contract.recipientName ?? toAddress,
        contractTitle: contract.title,
        hasAttachment: !!attachmentBase64,
        inReplyToMessageId: replyTargetMessageId,
        attachment: attachmentBase64
            ? {
                filename: attachmentMeta.filename,
                contentBase64: attachmentBase64,
                contentType: 'application/pdf',
            }
            : undefined,
    });
    // (6) Persist: outbound thread row + status flip.
    await db.insert(contractThreads).values({
        contractId,
        direction: 'outbound',
        // Store bare MessageID — same convention as /send so the next inbound
        // reply can match via Component 4's normalizeMessageId (round 3+ works).
        postmarkMessageId: messageId,
        inReplyToMessageId: replyTargetMessageId,
        fromAddress,
        toAddress,
        subject,
        bodyText: message,
        attachments: attachmentMeta ? [attachmentMeta] : [],
        emailDate: new Date(),
    });
    await db.update(contracts)
        .set({ status: 'sent', updatedAt: new Date() })
        .where(eq(contracts.id, contractId));
    // (7) Live push.
    notifyUser(user.id, { contractId, status: 'sent' }).catch((err) => {
        log.error('contracts', 'notifyUser failed after reply', { error: err?.message });
    });
    log.info('contracts', 'Reply sent via Postmark', {
        contractId,
        messageId,
        inReplyTo: replyTargetMessageId,
        fromAddress,
        toAddress,
        hasAttachment: !!attachmentMeta,
    });
    return c.json({ ok: true, messageId });
});
contractsRouter.get('/:id/download-url', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    const contract = await db.query.contracts.findFirst({
        where: eq(contracts.id, contractId),
    });
    if (!contract)
        return c.json({ error: 'Not found' }, 404);
    const isOwner = contract.userId === user.id;
    if (!isOwner) {
        const signerRow = await db.query.contractSigners.findFirst({
            where: and(eq(contractSigners.contractId, contractId), eq(contractSigners.genieUserId, user.id), inArray(contractSigners.status, ['pending', 'sent', 'viewed', 'signed'])),
        });
        if (!signerRow)
            return c.json({ error: 'Not found' }, 404);
    }
    const url = await generateDownloadSignedUrl(contract.storageKey, contract.originalFilename);
    c.header('Cache-Control', 'no-store');
    return c.json({ url, expiresIn: 3600 });
});
/**
 * Sign a thread attachment for download.
 *
 * Security: NEVER sign an arbitrary user-supplied storageKey. We must:
 *   1. Load the contract scoped to the requesting user (ownership).
 *   2. Confirm the requested `key` actually appears in one of THIS contract's
 *      thread rows (prevents IDOR / path-traversal across contracts).
 * Only then do we sign.
 */
contractsRouter.get('/:id/attachment', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    const key = c.req.query('key');
    if (!key) {
        return c.json({ error: 'Missing key' }, 400);
    }
    // (1) Ownership check — the contract must belong to the requesting user.
    const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
    });
    if (!contract) {
        log.warn('contracts', 'Attachment download — contract not found or not owned', {
            userId: user.id,
            contractId,
        });
        return c.json({ error: 'Not found' }, 404);
    }
    // (2) Confirm the requested key appears in this contract's thread attachments.
    const threadRows = await db.query.contractThreads.findMany({
        where: eq(contractThreads.contractId, contractId),
    });
    let attachmentFilename;
    for (const t of threadRows) {
        const match = (t.attachments ?? []).find((a) => a.storageKey === key);
        if (match) {
            attachmentFilename = match.filename;
            break;
        }
    }
    if (!attachmentFilename) {
        log.warn('contracts', 'Attachment download — key does not belong to this contract', {
            userId: user.id,
            contractId,
            key,
        });
        return c.json({ error: 'Not found' }, 404);
    }
    const url = await generateDownloadSignedUrl(key, attachmentFilename);
    log.info('contracts', 'Attachment signed URL issued', { contractId, userId: user.id, key });
    c.header('Cache-Control', 'no-store');
    return c.json({ url, expiresIn: 3600 });
});
/**
 * POST /api/contracts/:id/send-for-signature
 * Multi-party ordered signing via Dropbox Sign.
 */
contractsRouter.post('/:id/send-for-signature', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    const { signers, message } = await c.req.json();
    log.info('contracts', 'Send for signature requested', {
        contractId,
        userId: user.id,
        signerCount: signers?.length,
    });
    // 1. Ownership
    const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
    });
    if (!contract)
        return c.json({ error: 'Not found' }, 404);
    // 2. State guard — must have been sent and received a reply before signing
    const allowedStatuses = [
        'sent',
        'replied',
        'negotiating',
        'completed',
    ];
    if (!allowedStatuses.includes(contract.status)) {
        return c.json({
            error: `Contract in ${contract.status} state cannot be sent for signature`,
        }, 409);
    }
    // 3. Validate signers
    if (!Array.isArray(signers) || signers.length === 0 || signers.length > 4) {
        return c.json({ error: 'Provide between 1 and 4 signers' }, 400);
    }
    // 4. Resolve signers (Two-Angle Resolution)
    // Angle 1: typed email matches a Genie user's identity email (user table)
    // Angle 2: typed email is a Genie user's service address (service_emails table)
    // In both cases, send the Dropbox Sign request to the identity email and record genieUserId.
    // The service-domain assertion at the end remains as a final safety net.
    const MAIL_DOMAIN = process.env.MAIL_DOMAIN;
    const resolvedSigners = [];
    for (const [idx, s] of signers.entries()) {
        if (!s.name || !s.email) {
            return c.json({ error: 'Each signer needs name and email' }, 400);
        }
        let sendToEmail = s.email;
        let genieUserId = null;
        // Angle 1: look up by identity email
        const byIdentity = await db.execute(sql `
      SELECT id, email FROM "user" WHERE lower(email) = lower(${s.email}) LIMIT 1
    `);
        if (byIdentity.length > 0) {
            const gUser = byIdentity[0];
            genieUserId = gUser.id;
            sendToEmail = gUser.email;
        }
        else if (s.email.toLowerCase().endsWith(`@${MAIL_DOMAIN}`)) {
            // Angle 2: typed a service address — resolve to identity email via service_emails table
            const byService = await db.query.serviceEmails.findFirst({
                where: eq(serviceEmails.address, s.email.toLowerCase()),
            });
            if (byService) {
                const ownerUser = await db.execute(sql `
          SELECT id, email FROM "user" WHERE id = ${byService.userId} LIMIT 1
        `);
                if (ownerUser.length > 0) {
                    const gUser = ownerUser[0];
                    genieUserId = gUser.id;
                    sendToEmail = gUser.email; // identity email for Dropbox Sign audit trail
                }
            }
        }
        // Final safety net: after resolution, a service address must never reach Dropbox Sign
        if (sendToEmail.toLowerCase().endsWith(`@${MAIL_DOMAIN}`)) {
            return c.json({ error: `Cannot send signing link to service address: ${sendToEmail}` }, 400);
        }
        resolvedSigners.push({
            name: s.name,
            email: sendToEmail,
            order: s.order ?? idx + 1,
            role: s.role ?? 'other',
            genieUserId,
            signingToken: crypto.randomUUID(),
        });
        await rememberContact(user.id, {
            name: s.name,
            email: sendToEmail,
            source: 'signature',
        });
    }
    // 5. Re-read agreed PDF
    const [pdfBuffer] = await contractsBucket.file(contract.storageKey).download();
    // 6. Create BoldSign embedded prepare request (sender will place fields then click Send)
    const boldsignSigners = resolvedSigners.map((s) => ({
        name: s.name,
        emailAddress: s.email,
        order: s.order,
    }));
    const { documentId, sendUrl } = await createEmbeddedPrepareRequest({
        title: contract.title,
        message,
        pdfBuffer,
        pdfFilename: contract.originalFilename,
        signers: boldsignSigners,
    });
    // 7. Stash documentId + roster on the contract. Signer rows and the
    //    'out_for_signature' status are deferred to the 'Sent' webhook handler,
    //    which fires only after the sender clicks Send inside the BoldSign iframe.
    await db
        .update(contracts)
        .set({
        signatureRequestId: documentId,
        pendingSigners: resolvedSigners.map((s) => ({
            name: s.name,
            email: s.email,
            order: s.order,
            role: s.role,
            genieUserId: s.genieUserId,
            signingToken: s.signingToken,
        })),
        updatedAt: new Date(),
    })
        .where(eq(contracts.id, contractId));
    return c.json({ ok: true, sendUrl });
});
/**
 * GET /api/contracts/:id/sign-url
 * For authenticated Genie users who are signers on this contract.
 * Generates a short-lived BoldSign embedded sign URL on demand.
 */
contractsRouter.get('/:id/sign-url', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    // Find the signer row for this user on this contract
    const signerRow = await db.query.contractSigners.findFirst({
        where: and(eq(contractSigners.contractId, contractId), eq(contractSigners.genieUserId, user.id), inArray(contractSigners.status, ['pending', 'sent', 'viewed'])),
    });
    if (!signerRow)
        return c.json({ error: 'No pending signature found for this user' }, 404);
    if (!signerRow.signatureRequestId) {
        return c.json({ error: 'Signature request not yet available, try again shortly' }, 409);
    }
    const signUrl = await getEmbeddedSignUrl(signerRow.signatureRequestId, signerRow.signerEmail);
    c.header('Cache-Control', 'no-store');
    return c.json({ url: signUrl });
});
/**
 * GET /api/contracts/:id/signed-document
 * Returns a signed GCS URL for the executed PDF.
 */
contractsRouter.get('/:id/signed-document', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
    });
    if (!contract)
        return c.json({ error: 'Not found' }, 404);
    if (contract.status !== 'signed' || !contract.signedStorageKey) {
        return c.json({ error: 'Not signed yet' }, 409);
    }
    const executedFilename = `${contract.title.replace(/\s+/g, '-')}-executed.pdf`;
    const url = await generateDownloadSignedUrl(contract.signedStorageKey, executedFilename);
    c.header('Cache-Control', 'no-store');
    return c.json({ url, expiresIn: 3600 });
});
/**
 * GET /api/contracts/:id/versions
 * Returns the version history for a contract (owner only).
 */
contractsRouter.get('/:id/versions', requireAuth, async (c) => {
    const user = c.get('user');
    const contractId = c.req.param('id');
    const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, contractId), eq(contracts.userId, user.id)),
    });
    if (!contract)
        return c.json({ error: 'Not found' }, 404);
    const versions = await db.query.contractVersions.findMany({
        where: eq(contractVersions.contractId, contractId),
        orderBy: [asc(contractVersions.versionNumber)],
    });
    return c.json({ versions });
});
export default contractsRouter;
