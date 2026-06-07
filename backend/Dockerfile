# ARG before the first FROM = global scope, available in all FROM lines.
# Default → local tag for dev. CI passes the Artifact Registry path via --build-arg.
# See plans/deployment-guide.md — Step 2 for the exact --build-arg value.
ARG BASE_IMAGE=genie-backend-base:local

FROM node:24 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

COPY . .
RUN npm run build


FROM ${BASE_IMAGE} AS runner

WORKDIR /app

COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev

# Compiled app
COPY --from=builder /app/dist ./dist

# Font files — tsc does not copy non-ts assets.
# rootDir is "." so src/services/pdfGenerate.js lands at dist/src/services/
# and resolves ../fonts relative to that → dist/src/fonts/
COPY --from=builder /app/src/fonts ./dist/src/fonts

EXPOSE 8080

CMD ["node", "dist/src/index.js"]
