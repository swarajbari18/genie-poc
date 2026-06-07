#!/bin/bash
set -e

bash "$(dirname "$0")/build-backend.sh"

IMAGE=$(cat "$(dirname "$0")/.backend-image")
echo "Deploying: ${IMAGE}"

gcloud run deploy genie-backend \
  --image "${IMAGE}" \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 5 \
  --memory 1Gi \
  --timeout 3600 \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,DATABASE_URL_POOLED=DATABASE_URL_POOLED:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest,GOOGLE_CLOUD_PROJECT=GOOGLE_CLOUD_PROJECT:latest,GCS_BUCKET_NAME=GCS_BUCKET_NAME:latest,POSTMARK_SERVER_API_TOKEN=POSTMARK_SERVER_API_TOKEN:latest,POSTMARK_INBOUND_WEBHOOK_USER=POSTMARK_INBOUND_WEBHOOK_USER:latest,POSTMARK_INBOUND_WEBHOOK_PASS=POSTMARK_INBOUND_WEBHOOK_PASS:latest,BOLDSIGN_API_KEY=BOLDSIGN_API_KEY:latest,BOLDSIGN_WEBHOOK_SECRET=BOLDSIGN_WEBHOOK_SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,MAIL_DOMAIN=MAIL_DOMAIN:latest,COOKIE_DOMAIN=COOKIE_DOMAIN:latest" \
  --set-env-vars="NODE_ENV=production,BETTER_AUTH_URL=https://genie-api.usetend.in,PUBLIC_BASE_URL=https://genie-api.usetend.in,FRONTEND_URL=https://genie-app.usetend.in,PUBLIC_API_URL=https://genie-api.usetend.in"
