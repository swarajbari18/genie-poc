# Component 01 — Comprehensive Engineering Manual (0 to 1)

**Written:** 2026-05-25
**Last updated:** 2026-05-26
**Version:** 3.0 — Bug fixes applied; incorrect patterns removed

---

## 1. Technical Journey & Architecture

We have implemented a **Postmark-driven Contract Lifecycle** system. This replaces the complex Gmail API architecture with a more secure, per-user service email model.

### How it works (The Big Picture)
1. **Identity**: Users log in via Google OAuth (identity only, no inbox access).
2. **Provisioning**: Each user is assigned a unique email address (e.g., `alice-x7k2@mail.usetend.in`). This happens server-side in a `databaseHooks.user.create.after` callback, fire-and-forget with up to 2 async retries.
3. **Sending**: Users upload a PDF; the backend stores it in GCS and sends it to a recipient via Postmark.
4. **Inbound Capture**: When the recipient replies, Postmark intercepts the email and POSTs it to our webhook.
5. **Processing**: We extract the reply PDF, store it in GCS, and update the contract thread.

---

## 2. Prerequisites & Environment Variables

There is **one** `.env` file at the **project root** (next to `backend/` and `frontend/`). Do not commit it. A template is at `.env.example`.

Export it into your terminal before running anything:
```bash
set -a; source .env; set +a
```

> This must be run from the project root directory where `.env` lives. The backend reads all variables from the process environment — it does not have its own `.env` file.

| Variable | Description | Where to get it |
|---|---|---|
| `DATABASE_URL` | Direct Postgres connection | NeonDB → Dashboard → Connection String (Direct) |
| `DATABASE_URL_POOLED` | Pooled Postgres connection | NeonDB → Dashboard → Connection String (Pooled) |
| `GOOGLE_CLIENT_ID` | OAuth Client ID | GCP Console → APIs & Services → Credentials |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret | GCP Console → APIs & Services → Credentials |
| `BETTER_AUTH_SECRET` | 32-char random string | Run `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Backend URL | Local: `http://localhost:8080` / Cloud: Cloud Run URL |
| `FRONTEND_URL` | Frontend URL | Local: `http://localhost:4321` / Cloud: Cloudflare Workers URL |
| `PUBLIC_API_URL` | Backend URL as seen by the browser | Must equal `BETTER_AUTH_URL` |
| `GOOGLE_CLOUD_PROJECT` | GCP Project ID | GCP Console Dashboard |
| `GCS_BUCKET_NAME` | Storage bucket name | GCP Console → Cloud Storage |
| `MAIL_DOMAIN` | Inbound routing domain | `mail.usetend.in` |
| `POSTMARK_SERVER_API_TOKEN` | Postmark token | Postmark Dashboard → Server → API Tokens |
| `POSTMARK_INBOUND_WEBHOOK_USER` | Webhook username | Any string, e.g. `postmark-inbound` |
| `POSTMARK_INBOUND_WEBHOOK_PASS` | Webhook password | Run `openssl rand -base64 16` |

---

## 3. Local Execution Guide

### Step 1: Initialize application tables
```bash
cd backend
npm install
npm run db:push
```
Verify: NeonDB console shows `contracts`, `service_emails`, `contract_threads`, `inbound_emails`.

### Step 1b: Create Better Auth's tables

Better Auth needs 4 tables of its own (`user`, `session`, `account`, `verification`). These are not in the Drizzle schema and are not created by `db:push`. The `@better-auth/cli` command reads `src/lib/auth.ts` and runs the `CREATE TABLE` statements directly.

**Why you must `cd` into `src/lib/` first:** The CLI uses `jiti` to load `auth.ts`. `jiti` resolves relative imports from wherever the terminal is sitting, not from the file's location. Running from `backend/src/lib/` makes `jiti`'s path resolution match the file's actual location.

```bash
# From the project root, source the env first:
set -a; source .env; set +a

cd backend/src/lib
npx @better-auth/cli migrate
cd ../../..
```

Verify: NeonDB console now also shows `user`, `session`, `account`, `verification`.

### Step 2: Start backend
```bash
cd backend
npm run dev
```
Verify: `curl http://localhost:8080/health` returns `{"status":"ok"}`.

### Step 3: Start frontend
```bash
cd frontend
npm install
npm run dev
```
Verify: Open `http://localhost:4321`. If you have an active session, you land directly on `/dashboard`. If not, the landing page loads.

---

## 4. Physical End-to-End Testing (Local)

To test the inbound webhook locally, you must expose the backend to the internet.

1. **Expose backend**: Run `cloudflared tunnel --url http://localhost:8080`. Note the tunnel URL — it changes every restart.
2. **Configure Postmark**:
   - Go to Postmark → your inbound server → Settings → Inbound.
   - Set **Inbound Domain** to `mail.usetend.in`.
   - Set the **Webhook URL** with credentials embedded directly in the URL (Postmark's inbound UI has no separate Basic Auth fields):
     ```
     https://{POSTMARK_INBOUND_WEBHOOK_USER}:{POSTMARK_INBOUND_WEBHOOK_PASS}@{TUNNEL_URL}/webhooks/postmark/inbound
     ```
   - Use the literal password value — do not URL-encode it.
3. **Run the flow**:
   - Log in → upload a PDF → send to an email you control → reply with an attachment.
   - Refresh the dashboard after 20 seconds. Contract status should be `replied`.

---

## 5. Deployment Playbook (Cloud)

### A. Backend (GCP Cloud Run)
```bash
cd backend
gcloud run deploy backend \
  --source . \
  --region europe-west2 \
  --set-env-vars "BETTER_AUTH_URL=https://YOUR_BACKEND_URL,FRONTEND_URL=https://YOUR_FRONTEND_URL,GCS_BUCKET_NAME=your-bucket,MAIL_DOMAIN=mail.usetend.in" \
  --set-secrets "DATABASE_URL=db-url:latest,BETTER_AUTH_SECRET=auth-secret:latest,..."
```

### B. Frontend (Cloudflare Workers)
```bash
cd frontend
npm run build
npx wrangler deploy
```
Set `PUBLIC_API_URL` in the Cloudflare Dashboard under Workers → Settings → Environment Variables.

---

## 6. Code Anatomy

### Backend (`backend/src/`)

**`lib/auth.ts`**
- Better Auth configured with Google social provider (identity-only: `openid email profile`).
- Cookie flags: `SameSite: lax, secure: false` in local dev; `SameSite: none, secure: true` in production. This is required for cross-origin cookie forwarding (Cloudflare Workers frontend → Cloud Run backend).
- `databaseHooks.user.create.after`: fires only on first-ever login. Calls `provisionServiceEmail` in a fire-and-forget async function with up to 2 retries (3-second gaps) for transient DB errors. The auth session completes immediately regardless of provisioning outcome.

**`middleware/auth.ts`**
- `requireAuth`: calls `auth.api.getSession()`, injects `user` and `session` into Hono context, returns 401 if no valid session.

**`services/serviceEmail.ts`**
- Generates `{slug}-{6-char-nanoid}@{MAIL_DOMAIN}` addresses.
- Idempotency guard: returns the existing address if the user already has one (safe against retries and duplicate hook calls).
- 5-attempt collision retry loop for the unlikely case where the random token clashes with an existing address.

**`routes/contracts.ts`**
- `POST /upload`: saves PDF Buffer to GCS, inserts `draft` row.
- `POST /:id/send`: downloads from GCS, sends via Postmark, updates to `sent`.
- `GET /:id/download-url`: generates a V4 GCS signed URL (1-hour TTL).

**`routes/webhooks.ts`**
- `POST /postmark/inbound`: verifies Basic Auth, stores raw payload with `onConflictDoNothing` for idempotency, processes asynchronously.

### Frontend (`frontend/src/pages/`)

**`index.astro`** — SSR (no prerender)
- Server-side session check on every request. Already-logged-in users are redirected to `/dashboard` before any HTML is sent to the browser. No flash.
- Reads `?error=` query param and renders a specific human-readable banner (cancelled sign-in, service unavailable, etc.).
- Sign-in button POSTs to `/api/auth/sign-in/social` via `fetch`, redirects to Google on success, shows an inline error message on failure. Button disables itself mid-flight to prevent double-submission.

**`dashboard.astro`** — SSR
- Session check wrapped in try/catch. Backend-down triggers redirect to `/?error=service_unavailable`.
- OAuth error params (e.g. `?error=access_denied` arriving from the Google callback) are forwarded to `/?error=...` so the landing page can display them.
- Data fetches (contracts, service email) in a separate try/catch — failure renders an empty shell rather than crashing.
- Service email display: shows the address if provisioned, a refresh prompt if still pending, and a specific error message with instructions if provisioning failed.
- Sign-out is a `<button>` with a JavaScript `fetch POST` handler, not an anchor tag. The button disables itself mid-click. On completion (success or network error) it navigates to `/`.

**`upload.astro`** and **`contracts/[id].astro`** — SSR
- Session checks wrapped in try/catch. Backend-down redirects to `/?error=service_unavailable` rather than crashing with a 500.

---

## 7. Auth Flow Reference

### Happy paths

| Flow | Behaviour |
|---|---|
| First-ever login | User created, service email provisioned async, session created, redirect to `/dashboard` |
| Repeat login (same account) | New session created, redirect to `/dashboard`. Old sessions remain valid until their 30-day expiry. |
| Visit `/` while already logged in | Server-side redirect to `/dashboard` immediately — no button shown |
| Visit `/dashboard` without a session | Redirect to `/` |
| Visit `/upload` or `/contracts/:id` without a session | Redirect to `/` |

### Error paths

| Flow | Behaviour |
|---|---|
| Google OAuth cancelled by user | Google sends `?error=access_denied` to the callback. Better Auth redirects to `callbackURL` (dashboard). Dashboard SSR has no session → forwards error to `/?error=access_denied`. Landing page renders "Sign-in was cancelled" banner. |
| Network error during sign-in fetch | Inline error message appears below the button. Button re-enables. |
| Backend unreachable during SSR | Session fetch throws → redirect to `/?error=service_unavailable`. Landing page renders "service temporarily unavailable" banner. |
| Service email provisioning failure | Session completes. Async retry runs up to 2 more times. Dashboard shows "Provisioning…" if pending, or an actionable error message if all retries failed. |
| Session cookie present but session expired in DB | `auth.api.getSession()` returns null → SSR redirects to `/`. |

---

## 8. Bugs Found and Fixed (2026-05-26)

These bugs were identified through RCA after observing broken sign-out behaviour in testing.

### Bug 1 — Sign-out used a GET request, then a POST without Content-Type (two-stage failure)

**Stage 1:** The dashboard had `<a href="${apiUrl}/api/auth/sign-out">Sign out</a>`. An anchor tag always issues a GET. Better Auth only registers sign-out on POST. Result: 404, session never cleared, browser navigated to the raw backend port.

**Root cause of stage 1:** The original plan (section 9) prescribed `<a href=...>` for sign-out. The implementation copied it without questioning the HTTP method. The plan itself was wrong.

**Fix attempt:** Replaced the anchor with a `<button>` whose click handler does `fetch POST` to the sign-out endpoint, then `window.location.href = '/'`.

**Stage 2:** The `fetch POST` was sent without a `Content-Type: application/json` header and without a body. Better Auth returned **415 Unsupported Media Type** — it requires a JSON content type even when there is no meaningful body. The session was still never cleared. `window.location.href = '/'` ran anyway, the `index.astro` SSR found the still-valid session, and redirected straight back to `/dashboard`. The user was stuck in a loop.

**Final fix:** The fetch now sends `Content-Type: application/json` and `body: '{}'`:
```javascript
await fetch(`${apiUrl}/api/auth/sign-out`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
  credentials: 'include',
});
```

### Bug 2 — Google OAuth cancel sent the user to Better Auth's built-in backend error page

**What was wrong:** When a user cancelled the Google consent screen, Better Auth received `error=access_denied` in the OAuth callback and redirected to its own built-in error page at `{BACKEND_URL}/api/auth/error?error=access_denied` (port 8080). This page is styled with Better Auth's own design language and has no navigation back to the app. The user was stuck on the backend URL.

**Root cause of the original analysis being wrong:** The earlier RCA assumed Better Auth would forward the error to the `callbackURL`. That was speculation. The actual Better Auth source (`api/routes/callback.mjs`) shows:
```javascript
const defaultErrorURL = c.context.options.onAPIError?.errorURL || `${c.context.baseURL}/error`;
const baseURL = errorURL ?? defaultErrorURL;   // errorURL comes from OAuth state
```
`errorURL` in the state is only set if `errorCallbackURL` was passed in the sign-in body. Without it, Better Auth uses its own `/api/auth/error` page.

**Why the first fix attempt was incomplete:** The fix added frontend-side error param reading (dashboard forwarding, landing page banner) but never told Better Auth where to send errors. The backend `auth.ts` was not touched. The frontend error handling was dead code — the browser never reached the frontend.

**Final fix — two layers:**

1. `errorCallbackURL` in the sign-in fetch body (frontend `index.astro`): Better Auth stores this in the OAuth state. On cancel, it redirects to `{origin}/?error=access_denied`. The landing page SSR reads `?error=access_denied` and renders "Sign-in was cancelled" banner.

```javascript
body: JSON.stringify({
  provider: 'google',
  callbackURL: `${window.location.origin}/dashboard`,
  errorCallbackURL: `${window.location.origin}/`,   // ← added
}),
```

2. `onAPIError.errorURL` in `betterAuth({})` config (backend `auth.ts`): global fallback for errors that occur outside the OAuth state (state mismatch, invalid callback request, etc.). Without this, those errors still show the built-in page.

```typescript
onAPIError: {
  errorURL: `${process.env.FRONTEND_URL || 'http://localhost:4321'}/`,
},
```

### Bug 3 — Sign-in fetch had no error handling

**What was wrong:** The sign-in button's JavaScript had no `try/catch`. Network errors, non-JSON responses, and missing `url` fields all silently failed — the button appeared to do nothing.

**Fix:** Wrapped the fetch in try/catch. Added button loading/disabled state and an inline visible error message.

### Bug 4 — Landing page did not redirect already-logged-in users (and had a flash)

**What was wrong:** `index.astro` had `export const prerender = true`, making it a static file rendered at build time. It never checked the session cookie at runtime. A logged-in user visiting `/` always saw the "Continue with Google" button, could click it, and would create another orphaned session.

**Fix:** Removed `prerender = true`. The page is now SSR. On every request the server calls `GET /api/auth/get-session`, and if a valid session exists, issues an immediate `Astro.redirect('/dashboard')` before sending any HTML to the browser. No flash, no client-side round-trip.

### Bug 5 — Service email provisioning failure showed "Provisioning…" forever

**What was wrong:** If `provisionServiceEmail` threw (e.g. transient DB error on first login), the error was caught and swallowed. The user reached the dashboard, which showed "Provisioning…" indefinitely with no retry and no actionable message.

**Fix (backend):** The provisioning call is now a recursive async function with 2 retries (3-second gaps), covering transient connection errors at startup.

**Fix (frontend):** The dashboard now distinguishes three states: address present (show it), 404 from the API (show "Provisioning…, refresh in a moment"), and any other error status (show an explicit error message with instructions to sign out and sign back in).

### Bug 6 — SSR pages crashed with a 500 if the backend was unreachable

**What was wrong:** All SSR pages called `fetch(...)` with no `try/catch`. If the backend was down, the fetch threw, Astro caught the unhandled error, and returned a generic 500 page with no navigation options.

**Fix:** Every SSR `fetch` is now in a try/catch. A caught error on the session check redirects to `/?error=service_unavailable`. A caught error on data fetches (contracts, service email) renders the page with an empty state rather than crashing.

---

## 9. Success Criteria Checklist

- [ ] VS Code "Problems" tab is 0.
- [ ] `npm run dev` starts both servers without error.
- [ ] Visiting `/` while already logged in redirects immediately to `/dashboard` with no flash.
- [ ] Visiting `/` while logged out shows the landing page.
- [ ] Clicking "Continue with Google" → cancelling on Google consent → returns to `/` with a "Sign-in was cancelled" banner.
- [ ] Google login successfully redirects to `/dashboard`.
- [ ] Clicking "Sign out" clears the session and redirects to `/`. After sign-out, pressing back does not restore the dashboard (server re-validates the now-invalid cookie and redirects to `/`).
- [ ] Backend down while navigating to `/dashboard` → redirects to `/` with a "service unavailable" banner.
- [ ] PDF upload appears in GCS bucket immediately.
- [ ] Postmark activity log shows the outbound email.
- [ ] Webhook log in Postmark shows `200 OK` after you reply.
