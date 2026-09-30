# NexusPuppet API. Built from the monorepo root:
#   docker build -f apps/api/Dockerfile .
# The image is the whole product. LDAP/AD, OIDC, custom roles and audit
# forwarding are part of apps/api (ADR-0027); each stays inert until it is
# configured.
#
# There used to be an EDITION build argument selecting between a "core" image
# and one that included a separate packages/enterprise. It defaulted to core,
# and nothing in scripts/deploy.sh set it — so an install that followed
# DEPLOYMENT.md silently built an image without the directory and audit
# integrations. There is nothing left to select.

FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tls-grant/package.json packages/tls-grant/
COPY apps/api/package.json apps/api/
# `npm ci` against the committed lockfile, for every workspace the API needs.
# `ldapts` is an ordinary dependency of the api, so `ci` installs it like any
# other — no separate install step that a rebuild could forget.
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/tls-grant --workspace @nexuspuppet/api --include-workspace-root

FROM deps AS build
# Prisma 7 resolves DATABASE_URL through prisma.config.ts even for `generate`,
# which never contacts a database. A dummy value is correct at build time; the
# real connection string is injected at runtime.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/unused
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/tls-grant packages/tls-grant
COPY apps/api apps/api

RUN npm run build --workspace @nexuspuppet/contracts \
 && npm run build --workspace @nexuspuppet/tls-grant \
 && npm run db:generate --workspace @nexuspuppet/api \
 && npm run build --workspace @nexuspuppet/api

# The version the image reports, taken from the root manifest at BUILD time.
#
# This is what the comment above `PACKAGE_VERSION` always claimed happened and
# what nothing actually did: the version came from an environment variable that
# no build set, so every image reported `0.0.0-dev` — including the one running
# in front of customers — until somebody remembered to hand-write it into .env.
#
# A file rather than reading package.json at runtime, because the runtime layout
# is `dist/` and a relative path into a trimmed manifest is the fragile thing the
# original comment was right to avoid. This path is fixed by the two lines that
# create and copy it.
#
# BUILD_REF refines it, and is OPTIONAL. The manifest version only changes at
# release time, so every commit between releases inherits the last release's
# number: a console one commit past v1.7.6 reported `1.7.6`, and so did one
# nine commits past it. An operator cannot tell a release from something after
# it, which is the same confident wrong answer `0.0.0-dev` gave in a different
# disguise.
#
# `git describe --tags` answers exactly that distinction:
#
#   at the v1.8.0 tag   -> v1.8.0
#   three commits later -> v1.8.0-3-gabc1234
#   uncommitted changes -> v1.8.0-3-gabc1234-dirty
#
# UNSET FALLS BACK TO THE MANIFEST, deliberately. The earlier note here rejected
# an ARG because "an ARG would have to be passed in", and that reasoning holds:
# a build arg nobody sets must degrade to today's answer, never to a worse one.
# scripts/deploy.sh sets it; a hand-run `docker compose build` does not and
# still reports a correct-at-a-release version. Git is never invoked here — the
# build context has no .git, and requiring one would break installs from a
# release tarball.
ARG BUILD_REF=
RUN if [ -n "$BUILD_REF" ]; then \
      printf '%s' "$BUILD_REF" > /repo/VERSION; \
    else \
      node -p "require('./package.json').version" > /repo/VERSION; \
    fi

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# uid 100 / gid 101 PINNED, not inherited. DEPLOYMENT.md §3 tells operators to
# chown the certificate directory to uid 100, and until now that number was
# whatever Alpine's next system uid happened to be. A base-image bump that
# shifted it would make every documented install produce an unreadable key, with
# the only symptom being "PuppetDB unreachable".
RUN addgroup -S -g 101 app && adduser -S -u 100 -G app app
# The FULL node_modules, devDependencies included — deliberately, for now.
#
# `prisma` (the CLI) is a devDependency, and DEPLOYMENT.md §5 has operators run
# `docker compose run --rm api npx prisma migrate deploy` against this image. It
# works only because nothing has been pruned. Anyone slimming this image with
# `npm ci --omit=dev` must first move `prisma` into dependencies, or the
# documented migration step stops working in a way no test here would notice.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/
COPY --from=build /repo/packages/tls-grant/dist ./packages/tls-grant/dist
COPY --from=build /repo/packages/tls-grant/package.json ./packages/tls-grant/
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
# prisma.config.ts, not just prisma/. Prisma 7 keeps the connection string out
# of schema.prisma and resolves it through this file, so without it
# `prisma migrate deploy` fails with "The datasource.url property is required in
# your Prisma config file" — which made the documented migration step impossible
# with the shipped image. The CLI loads the TypeScript config directly; nothing
# needs transpiling.
COPY --from=build /repo/apps/api/prisma.config.ts ./
COPY --from=build /repo/apps/api/package.json ./
# Read at boot by app.module.ts. An absolute, Dockerfile-controlled path.
COPY --from=build /repo/VERSION ./VERSION

# The commissioning check, so it can run FROM the container:
#   docker compose run --rm api node scripts/test-puppetdb.mjs
# DEPLOYMENT.md recommends this check, but §0 asks only for Docker — on a
# Docker-only host there is no Node to run it with. In here there is, and it
# tests from the uid, network position and certificate mounts the real client
# uses rather than approximating them from the host.
#
# From the BUILD CONTEXT, not --from=build. The build stage only ever receives
# tsconfig.base.json, packages/* and apps/api, so /repo/scripts does not
# exist in it and copying from there fails the whole image build. This file is
# plain ESM that runs as-is; there is nothing for a build stage to do to it.
COPY scripts/test-puppetdb.mjs ./scripts/
# The ENC volume is mounted here read-write; it is the only path this service writes.
RUN mkdir -p /srv/nexuspuppet/enc && chown -R app:app /srv/nexuspuppet
USER app
EXPOSE 3001
CMD ["node", "dist/main.js"]
