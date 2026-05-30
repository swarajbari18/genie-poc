import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { contacts } from '../db/schema.js'
import { requireAuth } from '../middleware/auth.js'
import { rememberContact } from '../services/contacts.js'
import type { HonoEnv } from '../app.js'

const contactsRouter = new Hono<HonoEnv>()

contactsRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, user.id),
    orderBy: [desc(contacts.lastUsedAt)],
    limit: 30,
  })

  return c.json({ contacts: rows })
})

contactsRouter.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  if (!body?.email) return c.json({ error: 'Email required' }, 400)

  await rememberContact(user.id, {
    name: body.name,
    email: body.email,
    source: body.source ?? 'manual',
  })

  return c.json({ ok: true })
})

export default contactsRouter
