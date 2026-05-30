import { EventEmitter } from 'node:events';
import postgres from 'postgres';
import { log } from './logger.js';
/**
 * In-process event bus for SSE delivery.
 *
 * Why a separate connection: we LISTEN/NOTIFY through Postgres so any
 * Cloud Run instance can pick up a status change. But Neon's pooled URL
 * (DATABASE_URL_POOLED) is PgBouncer in transaction-pooling mode, which
 * does NOT pin a session and therefore cannot deliver LISTEN reliably.
 * So this module opens its own dedicated connection on the DIRECT URL
 * (DATABASE_URL), separate from the pooled `db` used for app queries.
 */
export const CHANNEL = 'user_updates';
// We give the bus generous headroom — every open SSE connection adds a
// listener, and a tab refresh quickly adds and removes a few of them.
// The hard rule is to REMOVE the listener on disconnect (routes/events.ts),
// not to raise this limit forever.
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(1000);
let sql = null;
let booted = false;
/**
 * Open the LISTEN connection. Idempotent — calling twice is a no-op.
 * Must be invoked once per process at boot.
 *
 * Uses DATABASE_URL (direct), NOT DATABASE_URL_POOLED.
 */
export async function bootEventsListener() {
    if (booted)
        return;
    booted = true;
    const directUrl = process.env.DATABASE_URL;
    if (!directUrl) {
        log.error('events', 'DATABASE_URL (direct) is not set — LISTEN cannot start');
        throw new Error('DATABASE_URL missing for events listener');
    }
    sql = postgres(directUrl, {
        max: 1,
        idle_timeout: 0,
        connect_timeout: 10,
        ssl: 'require',
    });
    await sql.listen(CHANNEL, (payload) => {
        try {
            const parsed = JSON.parse(payload);
            log.info('events', 'NOTIFY received', parsed);
            eventBus.emit(CHANNEL, parsed);
        }
        catch (err) {
            log.error('events', 'Bad NOTIFY payload — could not parse JSON', {
                payload,
                error: err?.message,
            });
        }
    }, () => {
        log.info('events', `LISTEN connected on channel "${CHANNEL}" (direct URL)`);
    });
}
/**
 * Emit a per-user status update.
 *
 * The payload intentionally carries only ids + status — never PII or
 * document content. The dashboard is responsible for refetching the
 * authenticated row to render anything.
 *
 * The channel is shared (`user_updates`) and the SSE route filters by
 * `payload.userId === session.user.id` server-side. A per-user channel
 * is the alternative; one shared channel + filter is simpler at POC
 * scale and was the chosen design (see plan §3.2).
 */
export async function notifyUser(userId, data) {
    const payload = { userId, contractId: data.contractId, status: data.status };
    const json = JSON.stringify(payload);
    if (!sql) {
        // Booted lazily so a missed boot doesn't crash callers in tests/scripts.
        // In production index.ts calls bootEventsListener() before serve().
        log.warn('events', 'notifyUser called before bootEventsListener — booting lazily');
        await bootEventsListener();
    }
    // postgres-js requires the channel name to be a literal; NOTIFY with
    // pg_notify lets us pass a parameterized payload safely.
    try {
        await sql `SELECT pg_notify(${CHANNEL}, ${json})`;
        log.info('events', 'NOTIFY sent', payload);
    }
    catch (err) {
        log.error('events', 'NOTIFY failed', { error: err?.message, payload: json });
    }
}
