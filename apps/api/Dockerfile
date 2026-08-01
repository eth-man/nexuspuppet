# NexusPuppet API. Built from the monorepo root:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
# The enterprise layer is absent here by design (ADR-0002).
#
# A PRIVATE BUILD NEEDS FOUR EDITS, NOT ONE. This comment used to name only the
# COPY below, and that is not enough: the build succeeds, the API starts, and
# the loader reports "No enterprise layer installed — running core edition".
# It fails SILENTLY INTO CORE, which is the worst available outcome — an
# operator who paid for SSO gets a working console with local auth and no error
# anywhere. Verified on a clean VM: `node_modules/@nexuspuppet/` in the runtime
# image held only `api` and `contracts`.
#
#   1. COPY packages/enterprise packages/enterprise      (below, before npm ci)
#   2. add --workspace @nexuspuppet/enterprise to the npm ci line, or the
#      workspace is never linked into node_modules
#   3. in the build stage, `npm run build --workspace @nexuspuppet/enterprise`
#      after contracts and before api — package.json main is ./dist/index.js
#   4. in the runtime stage, copy packages/enterprise/dist and its package.json,
#      or the node_modules symlink copied from build points at nothing
#
# Run `npm run enterprise:fetch` AND `npm install` on the host first. `npm ci`
# fails outright without the second — the committed lock file has no entry for
# @nexuspuppet/enterprise:
#   npm error Missing: @nexuspuppet/enterprise@0.1.0 from lock file
#
# For LDAP, also `npm install ldapts --workspace @nexuspuppet/enterprise`. It is
# an optional peer dependency so an OIDC-only deployment does not pull an LDAP
# client; without it the layer loads and every login fails at runtime.
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/api --include-workspace-root

FROM deps AS build
# Prisma 7 resolves DATABASE_URL through prisma.config.ts even for `generate`,
# which never contacts a database. A dummy value is correct at build time; the
# real connection string is injected at runtime.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/unused
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build --workspace @nexuspuppet/contracts \
 && npm run db:generate --workspace @nexuspuppet/api \
 && npm run build --workspace @nexuspuppet/api

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
# The commissioning check, so it can run FROM the container:
#   docker compose run --rm api node scripts/test-puppetdb.mjs
# DEPLOYMENT.md recommends this check, but §0 asks only for Docker — on a
# Docker-only host there is no Node to run it with. In here there is, and it
# tests from the uid, network position and certificate mounts the real client
# uses rather than approximating them from the host.
#
# From the BUILD CONTEXT, not --from=build. The build stage only ever receives
# tsconfig.base.json, packages/contracts and apps/api, so /repo/scripts does not
# exist in it and copying from there fails the whole image build. This file is
# plain ESM that runs as-is; there is nothing for a build stage to do to it.
COPY scripts/test-puppetdb.mjs ./scripts/
# The ENC volume is mounted here read-write; it is the only path this service writes.
RUN mkdir -p /srv/nexuspuppet/enc && chown -R app:app /srv/nexuspuppet
USER app
EXPOSE 3001
CMD ["node", "dist/main.js"]
