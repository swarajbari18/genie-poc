import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export type ContactInput = {
  name?: string | null
  email?: string | null
  source?: string
}

export async function rememberContact(userId: string, input: ContactInput) {
  const email = input.email?.trim().toLowerCase()
  if (!email) return

  const name = input.name?.trim() || email
  const source = input.source ?? 'manual'

  await db.execute(sql`
    INSERT INTO contacts (id, user_id, name, email, source, last_used_at, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${name}, ${email}, ${source}, now(), now(), now())
    ON CONFLICT (user_id, email)
    DO UPDATE SET
      name = EXCLUDED.name,
      source = EXCLUDED.source,
      last_used_at = now(),
      updated_at = now()
  `)
}
