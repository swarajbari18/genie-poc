import { Hono } from 'hono';
import { db } from '../db/client.js';
import { contractSigners } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getEmbeddedSignUrl } from '../services/boldsignClient.js';
import { log } from '../lib/logger.js';
const publicRouter = new Hono();
/**
 * GET /api/public/sign/:token
 * Unauthenticated endpoint for non-Genie signers clicking the link in their email.
 * Looks up the stable signingToken, generates a fresh Dropbox Sign embedded sign URL,
 * and returns it so the frontend can immediately redirect.
 *
 * The signingToken never expires — a fresh sign URL is generated on every visit.
 */
publicRouter.get('/sign/:token', async (c) => {
    const token = c.req.param('token');
    const signerRow = await db.query.contractSigners.findFirst({
        where: eq(contractSigners.signingToken, token),
    });
    if (!signerRow) {
        return c.json({ error: 'Signing link not found' }, 404);
    }
    if (signerRow.status === 'signed' || signerRow.status === 'declined') {
        return c.json({ error: 'This signing link is no longer active', status: signerRow.status }, 409);
    }
    if (!signerRow.signatureRequestId) {
        log.warn('public', 'signatureRequestId missing on signer row', { token });
        return c.json({ error: 'Signing not yet ready, please try again shortly' }, 409);
    }
    const signUrl = await getEmbeddedSignUrl(signerRow.signatureRequestId, signerRow.signerEmail);
    return c.json({ url: signUrl });
});
export default publicRouter;
