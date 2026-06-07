import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { provisionServiceEmail } from '../services/serviceEmail.js';
import { log } from './logger.js';
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // use DIRECT (non-pooled) URL here
});
export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL, // Cloud Run backend URL
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            // accessType omitted → defaults to "online" → NO refresh token issued
            // scopes omitted → defaults to ["openid", "email", "profile"]
            // prompt omitted → no forced re-consent
        },
    },
    session: {
        expiresIn: 60 * 60 * 24 * 30, // 30 days
        cookieCache: { enabled: false },
    },
    trustedOrigins: [process.env.FRONTEND_URL || 'http://localhost:4321'],
    // Global fallback for any auth error that does not have a per-request errorCallbackURL.
    // Covers errors that occur outside the OAuth state (state mismatch, invalid callback, etc.).
    // Better Auth appends ?error=<code> to this URL before redirecting.
    onAPIError: {
        errorURL: `${process.env.FRONTEND_URL || 'http://localhost:4321'}/`,
    },
    // Required for cross-origin (Cloudflare Workers frontend → Cloud Run backend)
    // Local dev uses http so secure must be false; production uses https so both flags are needed.
    advanced: {
        defaultCookieAttributes: process.env.NODE_ENV === 'production'
            ? { sameSite: 'lax', secure: true, domain: process.env.COOKIE_DOMAIN }
            : { sameSite: 'lax', secure: false },
    },
    // Fires ONLY on first login (new user creation). NOT on subsequent logins.
    // v1.5+ executes this AFTER the DB transaction commits — safe to query DB here.
    databaseHooks: {
        user: {
            create: {
                after: async (user) => {
                    log.info('auth.hook', 'First login — provisioning service email', { userId: user.id, email: user.email });
                    const attempt = async (retriesLeft) => {
                        try {
                            const address = await provisionServiceEmail(user.id, user.name);
                            log.info('auth.hook', 'Service email provisioned', { userId: user.id, address });
                        }
                        catch (err) {
                            log.error('auth.hook', 'provisionServiceEmail failed', { userId: user.id, retriesLeft, error: err.message });
                            if (retriesLeft > 0) {
                                // Retry after 3 seconds — handles transient DB connection errors at startup
                                setTimeout(() => attempt(retriesLeft - 1), 3000);
                            }
                            else {
                                log.error('auth.hook', 'provisionServiceEmail exhausted all retries — user must re-login', { userId: user.id });
                            }
                        }
                    };
                    // Do not await: the auth session must complete immediately.
                    // Provisioning runs asynchronously; the dashboard shows a loading state until it completes.
                    attempt(2);
                },
            },
        },
    },
});
