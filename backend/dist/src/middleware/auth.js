import { createMiddleware } from 'hono/factory';
import { auth } from '../lib/auth.js';
import { log } from '../lib/logger.js';
export const requireAuth = createMiddleware(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
        log.warn('middleware.auth', 'No valid session — returning 401', { path: c.req.path });
        return c.json({ error: 'Unauthorized' }, 401);
    }
    log.info('middleware.auth', 'Session valid', { userId: session.user.id, path: c.req.path });
    c.set('user', session.user);
    c.set('session', session.session);
    await next();
});
