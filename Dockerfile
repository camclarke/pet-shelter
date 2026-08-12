# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Cloud Run image for the Next.js app.
#
# Three stages so the final image carries only what `output: 'standalone'`
# actually needs at runtime — node_modules and the full source tree never
# make it into the image that ships. Smaller image, faster cold start, and
# cold starts are the one place scale-to-zero pricing can bite.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public NEXT_PUBLIC_* values are baked in at build time. They are not
# secrets — see .env.example — so passing them as build args is safe.
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_APP_CHECK_SITE_KEY
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Do not remove. `output: 'standalone'` generates a server.js that binds to
# process.env.HOSTNAME, and container runtimes set HOSTNAME to the container
# id — so without this the server binds to a non-routable name, Cloud Run's
# startup probe never succeeds, and the error blames the container rather than
# this line. Cost the sibling stack a debugging cycle.
ENV HOSTNAME=0.0.0.0

# Cloud Run runs containers as a non-root user by convention.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

EXPOSE 8080
CMD ["node", "server.js"]
