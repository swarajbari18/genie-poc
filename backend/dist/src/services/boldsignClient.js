import { DocumentApi, DocumentSigner, EmbeddedDocumentRequest } from 'boldsign';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const API_KEY = process.env.BOLDSIGN_API_KEY;
const WEBHOOK_SECRET = process.env.BOLDSIGN_WEBHOOK_SECRET ?? '';
const documentApi = new DocumentApi();
documentApi.setApiKey(API_KEY);
/**
 * Creates an Embedded Document Request — BoldSign's "prepare-then-send" flow.
 *
 * Returns a URL the sender opens in an iframe to drag signature/date fields
 * onto the PDF for each signer. When the sender clicks Send inside the iframe,
 * BoldSign creates the actual signature request and fires the 'Sent' webhook.
 *
 * The returned `documentId` is stable across prepare → send, so we persist it
 * on the contract immediately. If the sender abandons the iframe, the document
 * exists in BoldSign in draft state but no webhook fires; we just leave the
 * contract status untouched.
 */
export async function createEmbeddedPrepareRequest({ title, message, pdfBuffer, pdfFilename, signers, redirectUrl, }) {
    const tmpPath = path.join(os.tmpdir(), `bs-${crypto.randomUUID()}-${pdfFilename}`);
    fs.writeFileSync(tmpPath, pdfBuffer);
    try {
        const boldsignSigners = signers.map((s) => {
            const ds = new DocumentSigner();
            ds.name = s.name;
            ds.emailAddress = s.emailAddress;
            ds.signerType = DocumentSigner.SignerTypeEnum.Signer;
            if (s.order != null)
                ds.signerOrder = s.order;
            return ds;
        });
        const req = new EmbeddedDocumentRequest();
        req.title = title;
        if (message)
            req.message = message;
        req.signers = boldsignSigners;
        req.files = [fs.createReadStream(tmpPath)];
        req.sendViewOption = EmbeddedDocumentRequest.SendViewOptionEnum.PreparePage;
        req.enableEmbeddedSigning = true;
        req.disableEmails = true;
        req.enableSigningOrder = false;
        req.showToolbar = true;
        req.showSendButton = true;
        req.showSaveButton = false;
        req.showPreviewButton = true;
        req.showNavigationButtons = true;
        req.embeddedSendLinkValidTill = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        if (redirectUrl)
            req.redirectUrl = redirectUrl;
        const res = await documentApi.createEmbeddedRequestUrlDocument(req);
        const documentId = res.documentId;
        const sendUrl = res.sendUrl;
        if (!documentId || !sendUrl) {
            throw new Error(`BoldSign createEmbeddedRequestUrlDocument returned incomplete response (documentId=${documentId}, sendUrl=${!!sendUrl})`);
        }
        return { documentId, sendUrl };
    }
    finally {
        if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
        }
    }
}
export async function getEmbeddedSignUrl(documentId, signerEmail) {
    const validTill = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    const res = await documentApi.getEmbeddedSignLink(documentId, signerEmail, undefined, undefined, validTill);
    const signLink = res.signLink;
    if (!signLink) {
        throw new Error(`Failed to get embedded sign URL for document=${documentId} signer=${signerEmail}`);
    }
    return signLink;
}
/**
 * Verifies a BoldSign webhook HMAC signature.
 *
 * The X-BoldSign-Signature header has the format:
 *   t=<unix-seconds>,s0=<hex-hmac>,s1=<hex-hmac>
 *
 * s0 is signed with the current secret, s1 with the previous secret (during
 * rotation). We accept either.
 *
 * The HMAC payload is `${timestamp}.${rawBody}` using SHA-256.
 */
export function verifyCallback(rawBody, signatureHeader) {
    if (!WEBHOOK_SECRET) {
        console.warn('[BoldSign] BOLDSIGN_WEBHOOK_SECRET not configured — rejecting all events');
        return false;
    }
    if (!signatureHeader)
        return false;
    const parts = signatureHeader.split(',').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx <= 0)
            return acc;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k && v)
            acc[k] = v;
        return acc;
    }, {});
    const timestamp = parts['t'];
    if (!timestamp)
        return false;
    // Reject signatures older than 5 minutes to prevent replay.
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts))
        return false;
    const ageSec = Math.abs(Date.now() / 1000 - ts);
    if (ageSec > 300)
        return false;
    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    for (const key of ['s0', 's1']) {
        const provided = parts[key];
        if (!provided)
            continue;
        try {
            const a = Buffer.from(expected, 'hex');
            const b = Buffer.from(provided, 'hex');
            if (a.length === b.length && crypto.timingSafeEqual(a, b))
                return true;
        }
        catch {
            // bad hex — try next slot
        }
    }
    return false;
}
export async function downloadSignedFile(documentId) {
    const buf = await documentApi.downloadDocument(documentId);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}
