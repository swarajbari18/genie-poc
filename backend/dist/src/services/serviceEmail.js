import { customAlphabet } from 'nanoid';
import { db } from '../db/client.js';
import { serviceEmails } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { log } from '../lib/logger.js';
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);
const DOMAIN = process.env.MAIL_DOMAIN;
const MAX_RETRIES = 5;
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 12)
        || 'user'; // fallback if name produces empty string
}
export async function provisionServiceEmail(userId, displayName) {
    log.info('serviceEmail', 'provisionServiceEmail called', { userId, displayName });
    // Idempotency guard: return existing address if already provisioned
    const existing = await db.query.serviceEmails.findFirst({
        where: eq(serviceEmails.userId, userId),
    });
    if (existing) {
        log.info('serviceEmail', 'Already provisioned — returning existing address', { userId, address: existing.address });
        return existing.address;
    }
    const slug = slugify(displayName);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const token = nanoid();
        const localPart = `${slug}-${token}`;
        const address = `${localPart}@${DOMAIN}`;
        try {
            await db.insert(serviceEmails).values({
                userId,
                localPart,
                address,
            });
            log.info('serviceEmail', 'Service email created', { userId, address });
            return address;
        }
        catch (err) {
            // Postgres unique_violation code = '23505' — address already taken, retry with new token
            if (err?.code === '23505') {
                log.warn('serviceEmail', 'Address collision — retrying', { attempt, localPart });
                continue;
            }
            log.error('serviceEmail', 'Unexpected error inserting service email', { userId, error: err.message });
            throw err;
        }
    }
    throw new Error(`Failed to provision service email after ${MAX_RETRIES} retries`);
}
export async function getServiceEmailByLocalPart(localPart) {
    const row = await db.query.serviceEmails.findFirst({
        where: eq(serviceEmails.localPart, localPart),
    });
    if (!row || !row.isActive)
        return null;
    return { userId: row.userId, address: row.address };
}
export async function getServiceEmailByUserId(userId) {
    const row = await db.query.serviceEmails.findFirst({
        where: eq(serviceEmails.userId, userId),
    });
    return row?.address ?? null;
}
