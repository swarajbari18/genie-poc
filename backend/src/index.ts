import { serve } from '@hono/node-server'
import app from './app.js'
import { bootEventsListener } from './lib/events.js'
import { log } from './lib/logger.js'

const port = 8080

// Component 6: open the dedicated LISTEN connection (DIRECT Neon URL,
// NOT the pooled one — PgBouncer transaction-mode does not deliver
// session-level LISTEN reliably). One long-lived connection per
// Cloud Run instance, used only for LISTEN.
bootEventsListener()
  .then(() => log.info('boot', 'Events listener started'))
  .catch((err) => {
    log.error('boot', 'Events listener failed to start', { error: err?.message })
  })

if (!process.env.PUBLIC_BASE_URL) {
  log.error('boot', '⚠️  PUBLIC_BASE_URL is not set — Postmark and BoldSign webhooks will point at a stale URL. Set it to your named cloudflared tunnel URL (local) or Cloud Run URL (prod) before running a live demo.')
}

console.log(`Server is running on port ${port}`)

serve({
  fetch: app.fetch,
  port,
})
