import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../middleware/auth.js';
import { CHANNEL, eventBus } from '../lib/events.js';
import { log } from '../lib/logger.js';
const eventsRouter = new Hono();
const PING_INTERVAL_MS = 25_000;
/**
 * GET /api/events — Server-Sent Events stream for the authenticated user.
 *
 * - Auth: `requireAuth` (Better Auth session cookie via EventSource
 *   `withCredentials`; CORS already permits credentials for FRONTEND_URL).
 * - Filtering: we listen to the shared `user_updates` bus and only forward
 *   events whose payload.userId === session.user.id. Never trust a
 *   client-supplied id — that would let one user subscribe to another's
 *   events.
 * - Keep-alive: a periodic `: ping\n\n` comment every 25s so Cloudflare /
 *   Cloud Run idle timeouts don't kill the stream.
 * - Lifecycle: we MUST remove the EventEmitter listener on disconnect
 *   (abort signal). Every open SSE connection adds one listener; not
 *   cleaning up leaks them across reconnects (plan §3.3).
 *
 * Note: the client refetches state on (re)connect (Principle 7), so a
 * push dropped during a reconnect gap is invisible. The DB is the truth.
 */
eventsRouter.get('/', requireAuth, (c) => {
    const user = c.get('user');
    return streamSSE(c, async (stream) => {
        let pingTimer = null;
        let listener = null;
        const cleanup = () => {
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            if (listener) {
                eventBus.off(CHANNEL, listener);
                listener = null;
            }
            log.info('events', 'SSE disconnected — listener removed', {
                userId: user.id,
                listenerCount: eventBus.listenerCount(CHANNEL),
            });
        };
        // Wire the abort signal: when the client closes the tab / EventSource
        // reconnects / the server kills it, drop our listener.
        c.req.raw.signal.addEventListener('abort', cleanup);
        // Hello frame so the browser flushes headers immediately.
        await stream.writeSSE({ event: 'open', data: JSON.stringify({ ok: true }) });
        listener = (payload) => {
            if (payload.userId !== user.id)
                return;
            stream.writeSSE({
                event: 'status',
                data: JSON.stringify({
                    contractId: payload.contractId,
                    status: payload.status,
                }),
            }).catch((err) => {
                log.warn('events', 'writeSSE failed — likely closed stream', {
                    error: err?.message,
                    userId: user.id,
                });
            });
        };
        eventBus.on(CHANNEL, listener);
        log.info('events', 'SSE connected', {
            userId: user.id,
            listenerCount: eventBus.listenerCount(CHANNEL),
        });
        // Periodic keep-alive. SSE comment lines start with ":" and are
        // ignored by the EventSource API but keep proxies from idling out.
        pingTimer = setInterval(() => {
            stream.write(`: ping ${Date.now()}\n\n`).catch(() => {
                cleanup();
            });
        }, PING_INTERVAL_MS);
        // Block until the stream aborts — keeps streamSSE from closing the
        // response. The abort handler above does cleanup; we just wait.
        await new Promise((resolve) => {
            if (c.req.raw.signal.aborted)
                return resolve();
            c.req.raw.signal.addEventListener('abort', () => resolve());
        });
    });
});
export default eventsRouter;
