import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './lib/auth.js'
import contractsRouter from './routes/contracts.js'
import webhooksRouter from './routes/webhooks.js'
import eventsRouter from './routes/events.js'
import publicRouter from './routes/public.js'
import contactsRouter from './routes/contacts.js'
import reviewRouter from './routes/review.js'
import projectsRouter from './routes/projects.js'
import generateRouter from './routes/generate.js'
import seedRouter from './routes/seed.js'
import { requireAuth } from './middleware/auth.js'
import { getServiceEmailByUserId } from './services/serviceEmail.js'
import { log } from './lib/logger.js'

export type HonoEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user
    session: typeof auth.$Infer.Session.session
  }
}

const app = new Hono<HonoEnv>()

app.use('*', cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:4321'],
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'User-Agent'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))

// Log every request/response — skip OPTIONS (CORS preflight) and /health (polling noise)
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS' || c.req.path === '/health') return next()
  log.info('http', `→ ${c.req.method} ${c.req.path}`)
  await next()
  log.info('http', `← ${c.req.method} ${c.req.path}  ${c.res.status}`)
})

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.get('/health', (c) => c.json({ status: 'ok' }))

app.route('/api/contracts', contractsRouter)
app.route('/api/contacts', contactsRouter)
app.route('/api/review', reviewRouter)
app.route('/api/projects', projectsRouter)
app.route('/api/generate', generateRouter)
app.route('/api/seed', seedRouter)
app.route('/webhooks', webhooksRouter)
app.route('/api/events', eventsRouter)
app.route('/api/public', publicRouter)

app.get('/api/me/service-email', requireAuth, async (c) => {
  const user = c.get('user')
  const address = await getServiceEmailByUserId(user.id)
  if (!address) return c.json({ error: 'Not provisioned' }, 404)
  return c.json({ address })
})

export default app
