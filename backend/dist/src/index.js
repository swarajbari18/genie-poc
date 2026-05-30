import { serve } from '@hono/node-server';
import app from './app.js';
import { bootEventsListener } from './lib/events.js';
import { log } from './lib/logger.js';
const port = 8080;
// Component 6: open the dedicated LISTEN connection (DIRECT Neon URL,
// NOT the pooled one — PgBouncer transaction-mode does not deliver
// session-level LISTEN reliably). One long-lived connection per
// Cloud Run instance, used only for LISTEN.
bootEventsListener()
    .then(() => log.info('boot', 'Events listener started'))
    .catch((err) => {
    log.error('boot', 'Events listener failed to start', { error: err?.message });
    // Don't exit — the rest of the API can still serve. SSE will be
    // degraded but recoverable on restart.
});
console.log(`Server is running on port ${port}`);
serve({
    fetch: app.fetch,
    port,
});
