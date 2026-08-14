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

USER node
EXPOSE 3000

# tini reaps zombies and forwards SIGTERM so BullMQ/outbox can drain in-flight jobs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = \"worker\" ]; then exec node dist/main.worker.js; else exec node dist/main.js; fi"]
