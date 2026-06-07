# Genie AI POC — Deployment Guide
> Step-by-step. Every step is verifiable before you move to the next.
> Stack: Neon Postgres · Cloud Run (backend) · Cloudflare Workers (frontend)
> Last updated: 2026-06-02

---

## Prerequisites — have these ready before starting

| What | How to check |
|---|---|
| Node 24+ | `node --version` → `v24.x.x` |
| `gcloud` CLI | `gcloud --version` → `Google Cloud SDK ...` |
| `wrangler` CLI | `npx wrangler --version` → `4.x.x` |
| Docker (for local test build) | `docker --version` → `Docker version ...` |
| GCP project with billing | [console.cloud.google.com](https://console.cloud.google.com) — confirm project exists and billing is enabled |
| Cloudflare account | [dash.cloudflare.com](https://dash.cloudflare.com) |
| Neon account | [console.neon.tech](https://console.neon.tech) |

---

## Step 1 — Create a Neon DB branch for production

Neon branches are instant, isolated copies of your database. You keep `main` for development and create a `production` branch for live traffic.

### 1.1 Create the branch

1. Open [console.neon.tech](https://console.neon.tech) → your project.
2. Left sidebar → **Branches** → **New branch**.
3. Settings:
   - **Name:** `production`
   - **Branch from:** `main` (current state of your schema)
   - **Compute:** default (0.25 vCPU, scales to 0)
4. Click **Create branch**. Takes ~5 seconds.

### 1.2 Get the connection strings

In the `production` branch, click **Connect** (top-right of branch detail page):

1. Select **Connection string** tab.
2. **Direct connection** (for Better Auth's `pg.Pool` and migrations):
   ```
   postgresql://USER:PASSWORD@ep-XXXX.eu-west-2.aws.neon.tech/neondb?sslmode=require
   ```
   Copy it. This becomes `DATABASE_URL`.

3. Switch to **Pooled connection**:
   ```
   postgresql://USER:PASSWORD@ep-XXXX-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require
   ```
   Copy it. This becomes `DATABASE_URL_POOLED`.

> The only difference is the hostname: direct = `ep-XXXX.aws...`, pooled = `ep-XXXX-pooler.aws...`.

### 1.3 Run migrations against the production branch

From the repo root, temporarily set the env vars and push the schema:

```bash
# One-off: push schema to the new production branch
DATABASE_URL="postgresql://USER:PASSWORD@ep-XXXX.eu-west-2.aws.neon.tech/neondb?sslmode=require" \
  cd backend && npm run db:push
```

**Verify:** go back to Neon console → `production` branch → **Tables** tab. You should see: `service_emails`, `contracts`, `contract_threads`, `inbound_emails`, `contract_signers`, plus the four Better Auth tables (`user`, `session`, `account`, `verification`).

> If you only see the four Better Auth tables, run `db:push` again — Better Auth auto-creates its tables on the first auth request, so you might be fine without them appearing yet in migrations.

---

## Step 2 — Docker setup (base image + app image)

The backend uses two Dockerfiles:

| File | Purpose | Built |
|---|---|---|
| `backend/Dockerfile.base` | `node:24-slim` + Chromium + system libraries | Once manually, pushed to Artifact Registry |
| `backend/Dockerfile` | Builder (compile TS) + runner (FROM base) | Every deploy via CI |

This split means `apt-get install chromium` — the slow part (~5–8 min) — runs **once ever**. Every subsequent app build pulls the pre-built base from Artifact Registry in seconds and only re-runs `npm ci` + `tsc`.

### 2.1 Verify locally before touching GCP

Build the base image locally first:

```bash
cd backend
docker build -f Dockerfile.base -t genie-backend-base:local .
```

> This takes 5–8 minutes. You only ever run this command again if you need to update Chromium. The tag `genie-backend-base:local` is the default `BASE_IMAGE` arg in `Dockerfile`, so the next step just works.

Build the app image:

```bash
docker build -t genie-backend:local .
# ↑ no --build-arg needed — Dockerfile defaults to genie-backend-base:local
```

Run it:

```bash
docker run --rm -p 8080:8080 --env-file ../.env genie-backend:local
```

**Verify:**
```bash
curl http://localhost:8080/health
# → {"status":"ok"}
```

Test PDF generation (requires Gemini API key in your .env):
```bash
curl -s -X POST http://localhost:8080/api/generate \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","contractType":"NDA","partyA":"Alice","partyB":"Bob"}' \
  | jq .
# → {"contractId":"..."} — if this returns a contractId, Puppeteer + Chromium are working
```

### 2.2 Push the base image to Artifact Registry (do this once, after Step 3.2)

> Complete Step 3 first to create the Artifact Registry repository, then come back here.

Replace `YOUR_GCP_PROJECT_ID` with your GCP project ID:

```bash
# Authenticate Docker to Artifact Registry
gcloud auth configure-docker europe-west2-docker.pkg.dev

# Tag the local base image with the registry path
docker tag genie-backend-base:local \
  europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/base:1

# Push it
docker push europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/base:1
```

**Verify:**
```bash
gcloud artifacts docker images list \
  europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend
# → base:1 listed with a digest
```

> The `:1` tag is intentional. When you need to update the base (e.g. Chromium security patch), build a new `Dockerfile.base`, push as `:2`, and update the `--build-arg` in the CI deploy command. This makes rollbacks trivial — just point back to `:1`.

### 2.3 How to rebuild the base (when needed)

Only do this when Chromium itself needs updating — roughly once every few months:

```bash
cd backend
docker build -f Dockerfile.base -t genie-backend-base:local .
docker tag genie-backend-base:local \
  europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/base:2
docker push europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/base:2
```

Then update the `--build-arg BASE_IMAGE=...` value in the CI deploy command to `:2`.

---

## Step 3 — GCP setup (do this once)

### 3.1 Enable required APIs

```bash
gcloud config set project YOUR_GCP_PROJECT_ID

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com
```

**Verify:**
```bash
gcloud services list --enabled --filter="name:(run|cloudbuild|secretmanager|storage)"
# → should list all four
```

### 3.2 Create Artifact Registry repository (replaces the old GCR)

```bash
gcloud artifacts repositories create genie-backend \
  --repository-format=docker \
  --location=europe-west2 \
  --description="Genie backend images"
```

**Verify:**
```bash
gcloud artifacts repositories list --location=europe-west2
# → genie-backend listed
```

### 3.3 Create the GCS bucket

```bash
gsutil mb -p YOUR_GCP_PROJECT_ID -l europe-west2 gs://genie-poc-contracts
gsutil uniformbucketlevelaccess set on gs://genie-poc-contracts
```

**Verify:**
```bash
gsutil ls gs://genie-poc-contracts
# → no error (empty bucket is fine)
```

### 3.4 Create a service account for local dev (GCS signed URLs)

Cloud Run will use its own runtime SA. For local dev you need a key file.

```bash
gcloud iam service-accounts create genie-backend-sa \
  --display-name="Genie backend service account"

# Grant object admin on the bucket
gsutil iam ch \
  serviceAccount:genie-backend-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com:roles/storage.objectAdmin \
  gs://genie-poc-contracts

# Grant token creator on itself (required for v4 signed URLs)
gcloud iam service-accounts add-iam-policy-binding \
  genie-backend-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com \
  --member="serviceAccount:genie-backend-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

# Download the key (local dev only — never commit this)
gcloud iam service-accounts keys create \
  ~/genie-backend-sa-key.json \
  --iam-account=genie-backend-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com
```

Update your root `.env`:
```
GOOGLE_APPLICATION_CREDENTIALS=/home/YOUR_USER/genie-backend-sa-key.json
```

**Verify:**
```bash
# Start backend locally and upload a test contract
cd backend && npm run dev
# In another terminal:
curl http://localhost:8080/health
# → {"status":"ok"}
```

---

## Step 4 — Store production secrets in GCP Secret Manager

Every secret is stored once in Secret Manager and injected into Cloud Run at deploy time. Never put secrets in environment variables in the Cloud Run console's plain text fields.

### 4.1 Create each secret

Run these one by one, pasting the real value when prompted:

```bash
# NeonDB — production branch connection strings
echo -n "postgresql://USER:PASSWORD@ep-XXXX.neon.tech/neondb?sslmode=require" | \
  gcloud secrets create DATABASE_URL --data-file=-

echo -n "postgresql://USER:PASSWORD@ep-XXXX-pooler.neon.tech/neondb?sslmode=require" | \
  gcloud secrets create DATABASE_URL_POOLED --data-file=-

# Google OAuth
echo -n "YOUR_CLIENT_ID.apps.googleusercontent.com" | \
  gcloud secrets create GOOGLE_CLIENT_ID --data-file=-

echo -n "GOCSPX-YOUR_SECRET" | \
  gcloud secrets create GOOGLE_CLIENT_SECRET --data-file=-

# Better Auth
echo -n "$(openssl rand -base64 32)" | \
  gcloud secrets create BETTER_AUTH_SECRET --data-file=-

# GCP
echo -n "YOUR_GCP_PROJECT_ID" | \
  gcloud secrets create GOOGLE_CLOUD_PROJECT --data-file=-

echo -n "genie-poc-contracts" | \
  gcloud secrets create GCS_BUCKET_NAME --data-file=-

# Postmark
echo -n "YOUR_POSTMARK_SERVER_TOKEN" | \
  gcloud secrets create POSTMARK_SERVER_API_TOKEN --data-file=-

echo -n "postmark-inbound" | \
  gcloud secrets create POSTMARK_INBOUND_WEBHOOK_USER --data-file=-

echo -n "$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")" | \
  gcloud secrets create POSTMARK_INBOUND_WEBHOOK_PASS --data-file=-

# BoldSign
echo -n "YOUR_BOLDSIGN_API_KEY" | \
  gcloud secrets create BOLDSIGN_API_KEY --data-file=-

echo -n "YOUR_BOLDSIGN_WEBHOOK_SECRET" | \
  gcloud secrets create BOLDSIGN_WEBHOOK_SECRET --data-file=-

# Gemini
echo -n "YOUR_GEMINI_API_KEY" | \
  gcloud secrets create GEMINI_API_KEY --data-file=-

# Mail domain
echo -n "mail.usetend.in" | \
  gcloud secrets create MAIL_DOMAIN --data-file=-
```

> `BETTER_AUTH_URL`, `PUBLIC_BASE_URL`, `FRONTEND_URL`, and `PUBLIC_API_URL` are NOT stored as secrets — they are plain env vars set directly in the Cloud Run deployment command (Step 6), because they depend on the URLs you get from deploying.

### 4.2 Grant the Cloud Run runtime SA access to secrets

```bash
# Get the Cloud Run runtime SA email
export RUN_SA=$(gcloud iam service-accounts list \
  --filter="displayName:Compute Engine default service account" \
  --format="value(email)")

echo "Runtime SA: $RUN_SA"

# Grant secret access
for SECRET in DATABASE_URL DATABASE_URL_POOLED GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET \
  BETTER_AUTH_SECRET GOOGLE_CLOUD_PROJECT GCS_BUCKET_NAME \
  POSTMARK_SERVER_API_TOKEN POSTMARK_INBOUND_WEBHOOK_USER POSTMARK_INBOUND_WEBHOOK_PASS \
  BOLDSIGN_API_KEY BOLDSIGN_WEBHOOK_SECRET GEMINI_API_KEY MAIL_DOMAIN; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:$RUN_SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

**Verify:**
```bash
gcloud secrets list
# → all 14 secrets listed
```

---

## Step 5 — First manual deploy of the backend to Cloud Run

Do the first deploy manually (not via CI) so you get the Cloud Run URL before wiring Cloudflare and OAuth.

### 5.1 Build and push the image

> The base image must already be pushed to Artifact Registry (Step 2.2) before running this.

```bash
cd backend

# Build app image using the pre-built base from Artifact Registry
# Replace YOUR_GCP_PROJECT_ID with your GCP project ID
docker build \
  --build-arg BASE_IMAGE=europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/base:1 \
  -t europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/backend:v1 .

docker push europe-west2-docker.pkg.dev/YOUR_GCP_PROJECT_ID/genie-backend/backend:v1
```

### 5.2 Deploy to Cloud Run

Replace `YOUR_PROJECT_ID` and `YOUR_FRONTEND_URL` (use a placeholder like `https://todo.example.com` for now — you'll update it after the Cloudflare deploy):

```bash
gcloud run deploy genie-backend \
  --image europe-west2-docker.pkg.dev/YOUR_PROJECT_ID/genie-backend/backend:v1 \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 5 \
  --timeout 3600 \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,\
DATABASE_URL_POOLED=DATABASE_URL_POOLED:latest,\
GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,\
GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,\
BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest,\
GOOGLE_CLOUD_PROJECT=GOOGLE_CLOUD_PROJECT:latest,\
GCS_BUCKET_NAME=GCS_BUCKET_NAME:latest,\
POSTMARK_SERVER_API_TOKEN=POSTMARK_SERVER_API_TOKEN:latest,\
POSTMARK_INBOUND_WEBHOOK_USER=POSTMARK_INBOUND_WEBHOOK_USER:latest,\
POSTMARK_INBOUND_WEBHOOK_PASS=POSTMARK_INBOUND_WEBHOOK_PASS:latest,\
BOLDSIGN_API_KEY=BOLDSIGN_API_KEY:latest,\
BOLDSIGN_WEBHOOK_SECRET=BOLDSIGN_WEBHOOK_SECRET:latest,\
GEMINI_API_KEY=GEMINI_API_KEY:latest,\
MAIL_DOMAIN=MAIL_DOMAIN:latest" \
  --set-env-vars="NODE_ENV=production,\
BETTER_AUTH_URL=https://YOUR_CLOUDRUN_URL,\
PUBLIC_BASE_URL=https://YOUR_CLOUDRUN_URL,\
FRONTEND_URL=https://YOUR_CLOUDFLARE_WORKERS_URL,\
PUBLIC_API_URL=https://YOUR_CLOUDRUN_URL"
```

Cloud Run prints the URL when done:
```
Service URL: https://genie-backend-XXXX-uc.a.run.app
```

**Write that URL down.** It is your `BACKEND_URL` for the rest of this guide.

**Verify:**
```bash
curl https://genie-backend-XXXX-uc.a.run.app/health
# → {"status":"ok"}
```

> `--timeout 3600` is important. The default 300s would kill SSE connections and long AI/PDF jobs.

---

## Step 6 — Wire webhook URLs

Now that you have a permanent backend URL, register it everywhere that needs to call back.

### 6.1 Postmark inbound webhook

1. [postmarkapp.com](https://postmarkapp.com) → your server → **Settings** → **Inbound**.
2. **Inbound webhook URL:**
   ```
   https://genie-backend-XXXX-uc.a.run.app/webhooks/postmark/inbound
   ```
3. Check **Include raw email content in JSON payload**.
4. **Credentials** → Basic Auth:
   - Username: `postmark-inbound` (matches `POSTMARK_INBOUND_WEBHOOK_USER`)
   - Password: the value you stored in `POSTMARK_INBOUND_WEBHOOK_PASS`
5. Click **Save**.

**Verify:** Postmark has a **Send test webhook** button. Click it. The backend should log the test request. Check:
```bash
gcloud run services logs read genie-backend --region europe-west2 --limit 20
# → look for "→ POST /webhooks/postmark/inbound" and "← ... 200"
```

### 6.2 BoldSign webhook

1. [BoldSign dashboard](https://app.boldsign.com) → **API** → **Webhooks** → **Add webhook**.
2. **Webhook URL:**
   ```
   https://genie-backend-XXXX-uc.a.run.app/webhooks/boldsign/inbound
   ```
3. **Events to subscribe:** check all signing lifecycle events:
   - `signature_request.sent`
   - `signature_request.viewed`
   - `signature_request.signed`
   - `signature_request.completed`
   - `signature_request.declined`
4. Save. BoldSign displays a **Webhook Secret** — copy it.
5. Update the secret in GCP:
   ```bash
   echo -n "THE_BOLDSIGN_SECRET_FROM_DASHBOARD" | \
     gcloud secrets versions add BOLDSIGN_WEBHOOK_SECRET --data-file=-
   ```

### 6.3 Google OAuth redirect URI

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services** → **Credentials** → your OAuth 2.0 Client ID.
2. Under **Authorized redirect URIs**, add:
   ```
   https://genie-backend-XXXX-uc.a.run.app/api/auth/callback/google
   ```
3. Under **Authorized JavaScript origins**, add the **Cloudflare Workers URL** (from Step 7):
   ```
   https://frontend.YOUR_SUBDOMAIN.workers.dev
   ```
4. Click **Save**.

---

## Step 7 — Deploy the frontend to Cloudflare Workers

### 7.1 Set the `PUBLIC_API_URL` variable for the build

The Astro frontend needs to know the backend URL at **build time** so SSR pages can call the API. Create `frontend/.env.production`:

```bash
# frontend/.env.production
PUBLIC_API_URL=https://genie-backend-XXXX-uc.a.run.app
```

> Do NOT commit this file if it might be pushed to a public repo. Add `frontend/.env.production` to `.gitignore`.

### 7.2 Build

```bash
cd frontend
npm ci
npm run build
```

Output goes to `frontend/dist/`. **Verify it built cleanly:**
```bash
ls frontend/dist/
# → _worker.js  _routes.json  (plus any static assets)
```

### 7.3 Deploy with Wrangler

```bash
cd frontend
npx wrangler deploy
```

Wrangler reads `frontend/wrangler.jsonc` (already configured with `name: "frontend"` and the correct `main` entrypoint). It will prompt you to log in to Cloudflare if you haven't.

Output:
```
Deployed frontend to:
  https://frontend.YOUR_ACCOUNT.workers.dev
```

**Write that URL down.** It is your `FRONTEND_URL`.

**Verify:**
```bash
curl -I https://frontend.YOUR_ACCOUNT.workers.dev
# → HTTP/2 200
```

---

## Step 8 — Wire the two URLs back into the backend

Now you have both URLs. Update the Cloud Run service with the correct values:

```bash
gcloud run services update genie-backend \
  --region europe-west2 \
  --update-env-vars="NODE_ENV=production,\
BETTER_AUTH_URL=https://genie-backend-XXXX-uc.a.run.app,\
PUBLIC_BASE_URL=https://genie-backend-XXXX-uc.a.run.app,\
FRONTEND_URL=https://frontend.YOUR_ACCOUNT.workers.dev,\
PUBLIC_API_URL=https://genie-backend-XXXX-uc.a.run.app"
```

**Verify:**
```bash
gcloud run services describe genie-backend --region europe-west2 \
  --format="value(spec.template.spec.containers[0].env)"
# → env vars listed, FRONTEND_URL points at workers.dev
```

---

## Step 9 — Run the production smoke test

Work through this checklist top to bottom, in order. Each step depends on the ones before it.

### ☐ 9.1 Health check
```bash
curl https://genie-backend-XXXX-uc.a.run.app/health
# → {"status":"ok"}
```

### ☐ 9.2 Frontend loads
Open `https://frontend.YOUR_ACCOUNT.workers.dev` in a browser. You should see the login page (not a blank screen or Cloudflare error).

### ☐ 9.3 Google OAuth round-trip
1. Click **Continue with Google**.
2. Consent screen shows only name/email/profile — no Gmail scopes.
3. You land on `/dashboard` logged in as yourself.
4. Your service address (e.g. `alice-x7k2@mail.usetend.in`) is displayed.

**Verify in DB:**
```sql
-- In Neon console, production branch → SQL editor
SELECT * FROM service_emails LIMIT 5;
-- → one row for your account
```

### ☐ 9.4 Upload and send a contract
1. Upload a PDF via the dashboard.
2. Send it to yourself (your personal Gmail).
3. You receive the email from `alice-x7k2@mail.usetend.in` with the PDF attached.

**Verify in DB:**
```sql
SELECT id, status, postmark_message_id FROM contracts ORDER BY created_at DESC LIMIT 1;
-- → status = 'sent', postmark_message_id not null
```

### ☐ 9.5 Inbound reply capture
Reply to that email (with or without attachment). Within 30 seconds:
- Dashboard moves the contract to "Needs You"
- Contract thread shows the reply

**Verify in DB:**
```sql
SELECT processed, processing_error FROM inbound_emails ORDER BY created_at DESC LIMIT 1;
-- → processed = true, processing_error = null
```

### ☐ 9.6 BoldSign signing flow
1. Open the contract → Send for Signature with one signer (your personal email).
2. Open the email → sign the contract on BoldSign's page.
3. Contract moves to `signed`, executed PDF downloadable.

---

## Step 10 — Wire CI/CD (GitHub Actions)

This makes `git push origin main` auto-deploy both services.

### 10.1 Add GitHub repository secrets

In GitHub → your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Value |
|---|---|
| `GCP_PROJECT_ID` | your GCP project ID |
| `GCP_SERVICE_ACCOUNT_KEY` | the JSON content of a service account key that has `Cloud Run Admin`, `Cloud Build Editor`, `Artifact Registry Writer`, `Service Account User` roles |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with `Workers Scripts: Edit` permission (create at dash.cloudflare.com → My Profile → API Tokens) |

### 10.2 Update deploy.yml with the correct image registry

Replace the entire `deploy-backend` job. Key changes: Artifact Registry instead of `gcr.io`, and `--build-arg BASE_IMAGE` so Cloud Build uses the pre-built base and never runs `apt-get`:

```yaml
deploy-backend:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: google-github-actions/auth@v2
      with:
        credentials_json: ${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}
    - uses: google-github-actions/setup-gcloud@v2
    - run: gcloud auth configure-docker europe-west2-docker.pkg.dev --quiet
    - run: |
        cd backend
        docker build \
          --build-arg BASE_IMAGE=europe-west2-docker.pkg.dev/${{ secrets.GCP_PROJECT_ID }}/genie-backend/base:1 \
          -t europe-west2-docker.pkg.dev/${{ secrets.GCP_PROJECT_ID }}/genie-backend/backend:${{ github.sha }} .
        docker push europe-west2-docker.pkg.dev/${{ secrets.GCP_PROJECT_ID }}/genie-backend/backend:${{ github.sha }}
        gcloud run deploy genie-backend \
          --image europe-west2-docker.pkg.dev/${{ secrets.GCP_PROJECT_ID }}/genie-backend/backend:${{ github.sha }} \
          --region europe-west2 \
          --platform managed \
          --allow-unauthenticated
```

Also update the frontend job to inject `PUBLIC_API_URL` at build time. Replace `YOUR_CLOUDRUN_URL` with your actual Cloud Run URL:

```yaml
- name: Build frontend
  run: |
    cd frontend
    echo "PUBLIC_API_URL=https://YOUR_CLOUDRUN_URL" > .env.production
    npm ci
    npm run build
```

### 10.3 Verify CI runs

Push a trivial commit to `main`:
```bash
git commit --allow-empty -m "chore: test CI deploy"
git push origin main
```

In GitHub → **Actions** → watch both jobs pass (green checkmarks). Each should take ~3 minutes.

---

## Webhook URL reference card

Once deployed, these are the permanent inbound URLs to register in external services:

| Service | Where to register | URL |
|---|---|---|
| Postmark inbound | Postmark → Settings → Inbound | `https://YOUR_CLOUDRUN/webhooks/postmark/inbound` |
| BoldSign events | BoldSign → API → Webhooks | `https://YOUR_CLOUDRUN/webhooks/boldsign/inbound` |
| Google OAuth callback | GCP → OAuth Client → Redirect URIs | `https://YOUR_CLOUDRUN/api/auth/callback/google` |

---

## Environment variable map (what goes where)

| Variable | Backend (Cloud Run) | Frontend (build-time `.env.production`) |
|---|---|---|
| `DATABASE_URL` | Secret Manager | — |
| `DATABASE_URL_POOLED` | Secret Manager | — |
| `GOOGLE_CLIENT_ID` | Secret Manager | — |
| `GOOGLE_CLIENT_SECRET` | Secret Manager | — |
| `BETTER_AUTH_SECRET` | Secret Manager | — |
| `BETTER_AUTH_URL` | Plain env var (= backend URL) | — |
| `PUBLIC_BASE_URL` | Plain env var (= backend URL) | — |
| `FRONTEND_URL` | Plain env var (= CF workers URL) | — |
| `PUBLIC_API_URL` | — | `.env.production` (= backend URL) |
| `GOOGLE_CLOUD_PROJECT` | Secret Manager | — |
| `GCS_BUCKET_NAME` | Secret Manager | — |
| `GOOGLE_APPLICATION_CREDENTIALS` | NOT SET (Cloud Run uses runtime SA) | — |
| `POSTMARK_SERVER_API_TOKEN` | Secret Manager | — |
| `POSTMARK_INBOUND_WEBHOOK_USER` | Secret Manager | — |
| `POSTMARK_INBOUND_WEBHOOK_PASS` | Secret Manager | — |
| `MAIL_DOMAIN` | Secret Manager | — |
| `BOLDSIGN_API_KEY` | Secret Manager | — |
| `BOLDSIGN_WEBHOOK_SECRET` | Secret Manager | — |
| `GEMINI_API_KEY` | Secret Manager | — |

> `GOOGLE_APPLICATION_CREDENTIALS` is only for local dev. On Cloud Run, the runtime service account handles GCS authentication automatically via ADC — no key file needed.

---

## Troubleshooting

**`gcloud run deploy` fails with "Permission denied"**
→ The runtime SA doesn't have Secret Manager access. Re-run Step 4.2.

**PDF upload returns 500**
→ The runtime SA doesn't have `roles/storage.objectAdmin` on the bucket. Run:
```bash
gsutil iam ch serviceAccount:$RUN_SA:roles/storage.objectAdmin gs://genie-poc-contracts
```

**Google OAuth redirect loops**
→ The redirect URI in the OAuth client doesn't match `BETTER_AUTH_URL`. Check Step 6.3 and that `BETTER_AUTH_URL` equals the exact Cloud Run URL with no trailing slash.

**SSE disconnects immediately on Cloudflare**
→ Cloudflare's default response timeout is 100 seconds. The backend sends `: ping\n\n` keepalives, and the browser's `EventSource` auto-reconnects. This is expected and transparent — the contract page refetches state on every reconnect.

**BoldSign webhook returns 401**
→ `BOLDSIGN_WEBHOOK_SECRET` in Secret Manager doesn't match the secret shown in BoldSign's dashboard. Add a new version (Step 6.2) and redeploy.

**`runDiffAnalysis` never fires / diff not showing**
→ This is a known bug (logged in `PROGRESS-v2.md` under A6). `runDiffAnalysis()` runs but doesn't write a `contract_versions` row — the frontend reads that table, not `contracts.aiAnalysis`. Fix is in the A6 sprint.
