# One image, two roles. APP_ROLE=api starts the HTTP server, APP_ROLE=worker starts the
# schedules/queues/outbox/Ichancy-signin process. Keeping them in one image guarantees both
# roles run byte-identical business code — a worker that disagrees with the api about money
# rules is the failure mode we are engineering against.
#
# TWO BUILD TARGETS from this one file:
#
#   --target runner  -> ghcr.io/mostafahasan1995/cashier-backend        (api AND worker)
#                       dist/, PRODUCTION deps only, Chromium. The always-on image.
#   --target tools   -> ghcr.io/mostafahasan1995/cashier-backend-tools  (one-shot operations)
#                       dist/, FULL deps (prisma CLI, ts-node, tsconfig-paths), scripts/, src/,
#                       prisma.config.ts. Runs `prisma migrate deploy`, db-bootstrap and the seed.
#
# WHY a second image instead of dev deps in the first: prisma, ts-node and tsconfig-paths are
# devDependencies and the runner prunes them, so it physically cannot run a migration. Shipping the
# whole dev toolchain in a long-running, internet-facing container to fix that is the wrong trade —
# the migration runs for seconds per deploy; the api runs all day.
#
# Stage graph:  builder ──► prod-deps ──► runner
#                  └──────────────────────► tools      (branches off BEFORE the prune)
#
# NO HEALTHCHECK in this file, on purpose: it would apply to the worker as well, which has no HTTP
# listener (src/worker.module.ts), and mark it permanently unhealthy. The compose stack owns checks.

# WHY an exact tag: `node:22-bookworm-slim` moves under you, so two builds of the same commit could
# ship different Node patch releases. Bump this deliberately (and the node-version in ci.yml with it).
#
# WHY a digest on top of the tag: even an exact tag is re-pushed whenever Docker rebuilds it on a newer
# Debian, so the tag alone still lets two builds of one commit differ, and lets a poisoned re-push reach
# api and worker unnoticed. The digest is the multi-arch index for the tag, the same one the dashboard
# and mini-app Dockerfiles pin; bump all three together
# (`docker buildx imagetools inspect node:<tag>` prints it).
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# ---------- build ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# openssl is required by Prisma; the rest are sharp's runtime deps on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The lockfile is named explicitly (not `package-lock.json*`): `npm ci` without one fails anyway, and
# a COPY that names the missing file says so far more clearly than npm does.
COPY package.json package-lock.json ./
# The cache mount keeps npm's downloaded tarballs between builds on the same machine, and never in the
# image: after a lockfile change `npm ci` fetches only what changed instead of the whole tree, which on a
# slow link is minutes instead of tens of minutes. A fresh CI runner starts with an empty cache, so the
# result there is identical. `sharing=locked` stops the runner and tools builds racing on one cache.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --include=optional

# prisma.config.ts travels with the schema: Prisma 7 reads the schema path (and, for migrate, the
# connection string) from it. It needs no database URL to generate — see the comment inside it.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------- production dependencies ----------
# A separate stage so `tools` can copy the builder's node_modules from BEFORE this prune. Pruning in
# the builder itself (as this file used to) would leave no full dependency tree to branch from.
FROM builder AS prod-deps
# Drop dev deps in place so the generated Prisma client under node_modules/.prisma survives.
RUN npm prune --omit=dev

# ---------- tools (migrate / db-bootstrap / seed / operational CLI) ----------
# A plain `docker build .` (no --target) builds the LAST stage, which is `runner` below — so the
# default stays what it always was. This stage is built only when asked for with --target tools.
FROM ${NODE_IMAGE} AS tools
WORKDIR /app

# openssl: Prisma's schema engine links against it. tini: same signal story as the runner — a
# migration interrupted by `docker compose down` should get SIGTERM, not be orphaned.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# NODE_ENV=production keeps the development fixture seed's refuse-in-production guard armed
# (prisma/seed.ts; its npm script no longer overrides NODE_ENV) and makes the CLI ignore any stray
# .env (src/core/config/config.module.ts). The first platform admin comes from
# `npm run seed:platform-admin`, which is production-safe and needs no override.
ENV NODE_ENV=production
# The Prisma CLI phones home for update checks. The migrate container sits on an internal-only
# network, so that request can only time out — and it should not be tried at all from a prod box.
ENV CHECKPOINT_DISABLE=1

# FULL dependency tree, from the builder, i.e. before `npm prune --omit=dev`. The schema-engine binary
# Prisma needs for `migrate deploy` was downloaded by `npm ci` on this same Debian base, so it matches
# the runtime's OpenSSL and nothing has to be fetched when the container runs.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json prisma.config.ts ./
COPY --chown=node:node tsconfig.json tsconfig.build.json nest-cli.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node scripts ./scripts
# src/ is here because ts-node entrypoints (prisma/seed.ts, scripts/*) import it through the
# @common/@core/@modules path aliases, which tsconfig-paths resolves against src/.
COPY --chown=node:node src ./src

USER node

ARG GIT_SHA=unknown
ARG SOURCE_URL=https://github.com/mostafahasan1995/Telegram-mini-app
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="cashier-backend-tools"

ENTRYPOINT ["/usr/bin/tini", "--"]
# No useful default: every use names its command (the compose `migrate` service, or
# `docker compose run --rm tools ...`). Exiting 64 (EX_USAGE) beats silently migrating a database
# because somebody ran the image to look inside it.
CMD ["sh", "-c", "echo 'cashier-backend-tools: pass a command, e.g. npm run --silent prisma:deploy' >&2; exit 64"]

# ---------- run ----------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV APP_ROLE=api
ENV PORT=3000

# OWNED BY ROOT, readable by everyone, and deliberately NOT --chown=node:node (the four COPY lines here
# and the two below the Chromium step). The process runs as `node`, so a compromised api or worker
# cannot rewrite the code it runs: without this, an attacker could patch dist/ (the ledger or the
# withdrawal service) in the container's writable layer, and that layer survives restarts and reboots
# until the next deploy recreates the container. The mini-app image does the same.
#
# Nothing in /app needs to be writable at runtime. The Prisma client is generated at build time and
# talks to Postgres through @prisma/adapter-pg (no engine download or cache). pino writes to stdout.
# Chromium and the cookie-harvester profile default to /tmp and $HOME (/home/node). The only code that
# writes relative to the working directory is LocalFileStorage (`.storage`), which is used only when
# FILE_STORAGE_DRIVER=local; production uses S3. If that driver is ever enabled in this image, point
# FILE_STORAGE_LOCAL_DIR at a volume outside /app rather than chowning /app back to node.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

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
#
# ORDER: this layer sits AFTER node_modules (it needs the playwright CLI, and must be re-fetched when
# the playwright version changes) but BEFORE dist/, so an ordinary code change reuses the cached
# 400 MB layer instead of downloading Chromium on every commit.
#
# INSTALL_CHROMIUM=false exists ONLY for building on a network that cannot reach deb.debian.org — the
# ~100 system libraries Chromium needs come from there, and on a throttled connection this one step never
# finishes. An image built that way has no browser, so it must run with ICHANCY_TRANSPORT=fetch (or with
# ICHANCY_FAKE=true on a laptop). CI and the VPS always build with the default, and nothing else in the
# image changes.
ARG INSTALL_CHROMIUM=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright; \
    else \
      echo "INSTALL_CHROMIUM=$INSTALL_CHROMIUM: no Chromium in this image; run it with ICHANCY_TRANSPORT=fetch" >&2; \
    fi

# Root-owned for the reason given above the node_modules COPY: `node` may read the code, not rewrite it.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

USER node
EXPOSE 3000

# Declared last so a new commit SHA only changes image metadata, never invalidates a cached layer.
ARG GIT_SHA=unknown
ARG SOURCE_URL=https://github.com/mostafahasan1995/Telegram-mini-app
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="cashier-backend"

# tini reaps zombies and forwards SIGTERM so BullMQ/outbox can drain in-flight jobs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = \"worker\" ]; then exec node dist/main.worker.js; else exec node dist/main.js; fi"]
