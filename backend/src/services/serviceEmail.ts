import { customAlphabet } from 'nanoid'
import { db } from '../db/client.js'
import { serviceEmails } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { log } from '../lib/logger.js'

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)

const DOMAIN = process.env.MAIL_DOMAIN!
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
  log.info('serviceEmail', 'provisionServiceEmail called', { userId, displayName })

  // Idempotency guard: return existing address if already provisioned
  const existing = await db.query.serviceEmails.findFirst({
    where: eq(serviceEmails.userId, userId),
  })
  if (existing) {
    log.info('serviceEmail', 'Already provisioned — returning existing address', { userId, address: existing.address })
    return existing.address
  }

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
      log.info('serviceEmail', 'Service email created', { userId, address })
      return address
    } catch (err: any) {
      // Postgres unique_violation code = '23505' — address already taken, retry with new token
      if (err?.code === '23505') {
        log.warn('serviceEmail', 'Address collision — retrying', { attempt, localPart })
        continue
      }
      log.error('serviceEmail', 'Unexpected error inserting service email', { userId, error: err.message })
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

/**
 * Resolve the actual delivery address for a recipient.
 *
 * - Already a service address (@mail.usetend.in) → return as-is.
 * - Identity email (e.g. Gmail) → look up matching Genie user and return
 *   their service address, so the email stays on-domain while Postmark is
 *   pending approval.
 * - Identity email with no matching Genie account → return the original
 *   address (correct behaviour once Postmark approves external sending).
 */
export async function resolveDeliveryAddress(identityEmail: string): Promise<string> {
  const domain = process.env.MAIL_DOMAIN!
  if (identityEmail.toLowerCase().endsWith(`@${domain}`)) {
    return identityEmail
  }

  // Look up a Genie user whose sign-in email matches.
  const rows = await db.execute(
    sql`SELECT id FROM "user" WHERE lower(email) = ${identityEmail.toLowerCase()} LIMIT 1`
  )
  const userId = (rows as unknown as Array<{ id: string }>)[0]?.id
  if (!userId) return identityEmail

  const serviceAddress = await getServiceEmailByUserId(userId)
  if (serviceAddress) {
    log.info('serviceEmail', 'Resolved identity email to service address', {
      identityEmail,
      serviceAddress,
    })
    return serviceAddress
  }

  return identityEmail
}
