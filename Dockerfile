# One image, two roles. APP_ROLE=api starts the HTTP server, APP_ROLE=worker starts the
# schedules/queues/outbox/Ichancy-signin process. Keeping them in one image guarantees both
# roles run byte-identical business code — a worker that disagrees with the api about money
# rules is the failure mode we are engineering against.

# ---------- build ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# openssl is required by Prisma; the rest are sharp's runtime deps on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --include=optional

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev deps in place so the generated Prisma client under node_modules/.prisma survives.
RUN npm prune --omit=dev

# ---------- run ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV APP_ROLE=api
ENV PORT=3000

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json

# ---------- Chromium for ICHANCY_TRANSPORT=browser ----------
# REQUIRED, not optional: browser is the DEFAULT transport and IchancyTransportPreflightService
# refuses to boot without a usable binary, so an image built without this step crash-loops. That is
# the deliberate trade, and it is the better half of it — before 2026-08-20 the missing prerequisite
# surfaced at the first player as an unexplained TRANSPORT_ERROR row on ichancy_calls, which reads
# like an Ichancy problem rather than a gap in our own image.
#
# `npm ci --include=optional` in the builder keeps the playwright JS, but Playwright 1.62 has NO
# postinstall hook, so the ~400 MB browser has to be fetched explicitly and separately. --with-deps
# brings Chromium's shared libraries; the chmod is what lets the unprivileged node user read them,
# since the browsers land under a root-owned path. Adds ~400 MB to the image.
#
# To skip all of this: set ICHANCY_TRANSPORT=fetch and accept the pasted-cookie countdown.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright

USER node
EXPOSE 3000

# tini reaps zombies and forwards SIGTERM so BullMQ/outbox can drain in-flight jobs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = \"worker\" ]; then exec node dist/main.worker.js; else exec node dist/main.js; fi"]
